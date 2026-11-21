import Foundation
import Observation
import Security

// MARK: - Settings + GitHub account (token lives in the Keychain, never in UserDefaults)

@Observable
final class AppSettings {
    static let shared = AppSettings()
    var serverURL: String { didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") } }
    private(set) var githubToken: String?
    var githubLogin: String?
    var githubAvatar: URL?

    init() {
        serverURL = ProcessInfo.processInfo.environment["DEVTOK_SERVER"] ?? UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:8765"
        githubToken = Keychain.read("github-token")
        githubLogin = UserDefaults.standard.string(forKey: "githubLogin")
    }

    /// Validates the token against GitHub (`GET /user`) and stores it.
    func signIn(token: String) async throws {
        let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
        var req = URLRequest(url: URL(string: "https://api.github.com/user")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw APIError.message("GitHub rejected this token") }
        let user = try JSONDecoder().decode(GHUser.self, from: data)
        Keychain.save("github-token", t)
        githubToken = t
        githubLogin = user.login
        githubAvatar = URL(string: user.avatar_url ?? "")
        UserDefaults.standard.set(user.login, forKey: "githubLogin")
    }

    func signOut() {
        Keychain.delete("github-token")
        githubToken = nil
        githubLogin = nil
        githubAvatar = nil
        UserDefaults.standard.removeObject(forKey: "githubLogin")
    }

    struct GHUser: Decodable { let login: String; let avatar_url: String? }
}

enum Keychain {
    private static let service = "com.devtok.prototype"
    static func save(_ key: String, _ value: String) {
        delete(key)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key, kSecValueData as String: Data(value.utf8),
                                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        SecItemAdd(q as CFDictionary, nil)
    }
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func delete(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}

// MARK: - Job server API (pipeline/server.py)

enum APIError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { m } else { nil } }
}

struct JobStatus: Decodable, Identifiable {
    let job_id: String
    let pr_url: String
    let status: String
    let error: String?
    let roles: [String]?
    let roles_ready: [String]?
    let pr: PRSummary?
    let stats: Stats?
    let stages: [Stage]?
    var id: String { job_id }

    struct PRSummary: Decodable {
        let title: String?
        let repo: String?
        let number: Int?
        let author: String?
        let state: String?
        let merged_at: String?
        let files: Int?
        let additions: Int?
        let deletions: Int?
        let commits: Int?
    }
    struct Stats: Decodable { let total_seconds: Double?; let llm_calls: Int?; let tokens: Int? }
    struct Stage: Decodable, Identifiable { let id: String; let label: String; let status: String; let detail: String; let t: Double? }
}

struct DevTokAPI {
    var base: String { AppSettings.shared.serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) }

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        guard let url = URL(string: base + path) else { throw APIError.message("Bad server URL: \(base)") }
        var r = URLRequest(url: url, timeoutInterval: 30)
        r.httpMethod = method
        if let body {
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let t = AppSettings.shared.githubToken { r.setValue(t, forHTTPHeaderField: "X-GitHub-Token") }
        return r
    }

    private func load<T: Decodable>(_ r: URLRequest, as: T.Type) async throws -> T {
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await URLSession.shared.data(for: r) } catch {
            throw APIError.message("Can't reach the DevTok server at \(base). Is `python3 pipeline/server.py` running?")
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code >= 400 {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.message(msg ?? "Server error \(code)")
        }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw APIError.message("Unexpected server response: \(error)") }
    }

    func createJob(prURL: String, refresh: Bool = false) async throws -> JobStatus {
        try await load(request("/api/jobs", method: "POST", body: ["pr_url": prURL, "refresh": refresh]), as: JobStatus.self)
    }
    func job(_ id: String) async throws -> JobStatus { try await load(request("/api/jobs/\(id)"), as: JobStatus.self) }
    func recentJobs() async throws -> [JobStatus] { try await load(request("/api/jobs"), as: [JobStatus].self) }
    func manifest(_ id: String, _ role: Role) async throws -> Manifest {
        try await load(request("/api/jobs/\(id)/manifest/\(role.rawValue)"), as: Manifest.self)
    }
    func explain(_ id: String, _ role: Role) async -> String {
        guard let r = try? request("/api/jobs/\(id)/explain/\(role.rawValue)"),
              let (d, _) = try? await URLSession.shared.data(for: r) else { return "" }
        return String(data: d, encoding: .utf8) ?? ""
    }
    func mediaURL(_ name: String) -> URL? { URL(string: base + "/media/" + name) }
}

// MARK: - A review session = the three role manifests for one PR (bundled demo or from the server)

struct ReviewSession: Identifiable {
    let id: String
    let manifests: [Role: Manifest]
    let explains: [Role: String]
    let remote: Bool
    var roles: [Role] { Role.allCases.filter { manifests[$0] != nil } }
    var any: Manifest { manifests[roles.first ?? .technical_engineer]! }

    /// Bundled offline demos: (resource prefix, label). Files are named <prefix>manifest_<role>.json.
    static let demos: [(prefix: String, label: String)] = [("", "pydantic-ai #3942 · 3 roles"), ("vibe140_", "mistral-vibe #140 · engineer, 5 styles")]

    /// Only demos whose manifests are actually in the bundle.
    static var availableDemos: [(prefix: String, label: String)] {
        demos.filter { d in Role.allCases.contains { FeedStore.loadIfPresent($0, prefix: d.prefix) != nil } }
    }

    static func bundled(prefix: String = "") -> ReviewSession {
        var m: [Role: Manifest] = [:], e: [Role: String] = [:]
        for r in Role.allCases {
            if let x = FeedStore.loadIfPresent(r, prefix: prefix) { m[r] = x; e[r] = FeedStore.explainText(r, prefix: prefix) }
        }
        return ReviewSession(id: "bundled-\(prefix)", manifests: m, explains: e, remote: false)
    }

    static func load(job: JobStatus) async throws -> ReviewSession {
        let api = DevTokAPI()
        var m: [Role: Manifest] = [:], e: [Role: String] = [:]
        for r in Role.allCases where (job.roles_ready ?? []).contains(r.rawValue) {
            m[r] = try await api.manifest(job.job_id, r)
            e[r] = await api.explain(job.job_id, r)
        }
        guard !m.isEmpty else { throw APIError.message("No role finished for this PR") }
        return ReviewSession(id: job.job_id, manifests: m, explains: e, remote: true)
    }
}

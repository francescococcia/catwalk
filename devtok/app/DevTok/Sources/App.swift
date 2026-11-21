import AVFoundation
import SwiftUI
import UIKit

@main
struct DevTokApp: App {
    init() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
    var body: some Scene {
        WindowGroup { RootView().preferredColorScheme(.dark) }
    }
}

private let env = ProcessInfo.processInfo.environment

/// home (paste PR link) -> job progress -> role picker -> feed
struct RootView: View {
    @State private var jobID: String?
    @State private var session: ReviewSession?
    @State private var store: FeedStore?
    @State private var role: Role = env["DEVTOK_ROLE"].flatMap(Role.init(rawValue:)) ?? .technical_engineer

    var body: some View {
        ZStack {
            if let store, let session {
                FeedView(store: store, session: session, onExit: { self.store = nil }).transition(.move(edge: .trailing))
            } else if let session {
                SessionView(session: session, role: $role,
                            onStart: { r in withAnimation(.smooth) { store = FeedStore(role: r, manifest: session.manifests[r]!) } },
                            onBack: { withAnimation { self.session = nil; jobID = nil } })
            } else if let jobID {
                JobView(jobID: jobID, onReady: { s in withAnimation(.smooth) { session = s } }, onBack: { withAnimation { self.jobID = nil } })
            } else {
                HomeView(onJob: { id in withAnimation(.smooth) { jobID = id } },
                         onDemo: { p in withAnimation(.smooth) { let s = ReviewSession.bundled(prefix: p); session = s; if s.manifests[role] == nil { role = s.roles[0] } } })
            }
        }
        .onAppear {
            if env["DEVTOK_AUTOSTART"] == "1", !ReviewSession.availableDemos.isEmpty {
                let s = ReviewSession.bundled(prefix: env["DEVTOK_DEMO"] ?? ""); session = s
                if s.manifests[role] == nil { role = s.roles[0] }
                store = FeedStore(role: role, manifest: s.manifests[role]!)
            }
        }
    }
}

// MARK: - Home: paste a PR link

struct HomeView: View {
    var onJob: (String) -> Void
    var onDemo: (String) -> Void
    @State private var settings = AppSettings.shared
    @State private var link = env["DEVTOK_PR_URL"] ?? ""
    @State private var busy = false
    @State private var error: String?
    @State private var recent: [JobStatus] = []
    @State private var showLogin = false
    @State private var showSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("DevTok").font(.system(size: 34, weight: .black, design: .rounded))
                    Spacer()
                    Button { showSettings = true } label: { Image(systemName: "gearshape.fill").font(.title3) }.tint(.white)
                }
                Text("Turn a big PR into short videos you actually understand, then approve it.").font(.subheadline).foregroundStyle(.secondary)

                // GitHub account
                Button { showLogin = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: settings.githubLogin == nil ? "person.crop.circle.badge.plus" : "checkmark.seal.fill")
                            .font(.title3).foregroundStyle(settings.githubLogin == nil ? .orange : .green)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(settings.githubLogin.map { "Signed in to GitHub as @\($0)" } ?? "Sign in to GitHub").font(.subheadline.bold())
                            Text(settings.githubLogin == nil ? "Needed for private repos and higher rate limits" : "Private repos you can see will work")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }
                    .padding(14).background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.07)))
                }.buttonStyle(.plain)

                // PR link
                VStack(alignment: .leading, spacing: 10) {
                    Text("Pull request link").font(.headline)
                    HStack {
                        Image(systemName: "link").foregroundStyle(.secondary)
                        TextField("https://github.com/owner/repo/pull/123", text: $link)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                            .font(.callout.monospaced()).submitLabel(.go).onSubmit(start)
                        Button {
                            if let s = UIPasteboard.general.string { link = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                        } label: { Image(systemName: "doc.on.clipboard") }
                    }
                    .padding(12).background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.08)))
                    if let error { Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange) }
                    Button(action: start) {
                        HStack {
                            if busy { ProgressView().tint(.white) } else { Image(systemName: "sparkles") }
                            Text("Explain this PR").font(.headline)
                        }.frame(maxWidth: .infinity).padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent).tint(.pink).disabled(busy || link.isEmpty)
                    Button("Try the demo PR link") { link = "https://github.com/pydantic/pydantic-ai/pull/3942" }.font(.caption)
                }

                if !recent.isEmpty {
                    Text("Recent").font(.headline).padding(.top, 6)
                    ForEach(recent) { j in
                        Button { onJob(j.job_id) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(j.pr?.title ?? j.pr_url).font(.subheadline.bold()).lineLimit(2).multilineTextAlignment(.leading)
                                    Text("\(j.pr?.repo ?? "")#\(String(j.pr?.number ?? 0))").font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusPill(status: j.status)
                            }
                            .padding(12).background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
                        }.buttonStyle(.plain)
                    }
                }

                if !ReviewSession.availableDemos.isEmpty {
                    Text("Offline demos (on the phone, no server)").font(.headline).padding(.top, 6)
                }
                ForEach(ReviewSession.availableDemos, id: \.prefix) { d in
                    Button { onDemo(d.prefix) } label: {
                        HStack {
                            Image(systemName: "shippingbox.fill").foregroundStyle(.purple)
                            Text(d.label).font(.subheadline.bold())
                            Spacer()
                            Image(systemName: "play.circle.fill").font(.title3).foregroundStyle(.pink)
                        }
                        .padding(12).background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
                    }.buttonStyle(.plain)
                }
            }
            .padding(20)
        }
        .background(LinearGradient(colors: [Color(red: 0.09, green: 0.05, blue: 0.16), .black], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .sheet(isPresented: $showLogin) { GitHubLoginView() }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .task { recent = (try? await DevTokAPI().recentJobs()) ?? [] }
        .onAppear { if env["DEVTOK_PR_URL"] != nil, env["DEVTOK_SUBMIT"] == "1" { start() } }
    }

    private func start() {
        guard !busy else { return }
        error = nil
        busy = true
        Task {
            defer { busy = false }
            do { onJob(try await DevTokAPI().createJob(prURL: link).job_id) } catch { self.error = error.localizedDescription }
        }
    }
}

struct StatusPill: View {
    let status: String
    var body: some View {
        Text(status.uppercased()).font(.system(size: 10, weight: .black)).padding(.horizontal, 8).padding(.vertical, 4)
            .background((status == "done" ? Color.green : status == "error" ? .red : .orange).opacity(0.35), in: Capsule())
    }
}

// MARK: - GitHub sign-in (prototype: personal access token, validated with GET /user and kept in the Keychain)

struct GitHubLoginView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var settings = AppSettings.shared
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                if let login = settings.githubLogin {
                    Section { Label("Signed in as @\(login)", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
                    Section { Button("Sign out", role: .destructive) { settings.signOut() } }
                } else {
                    Section {
                        SecureField("github_pat_… or ghp_…", text: $token).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button {
                            busy = true
                            Task {
                                defer { busy = false }
                                do { try await settings.signIn(token: token); dismiss() } catch { self.error = error.localizedDescription }
                            }
                        } label: { HStack { if busy { ProgressView() }; Text("Sign in") } }.disabled(token.isEmpty || busy)
                        if let error { Text(error).foregroundStyle(.red).font(.caption) }
                    } header: { Text("GitHub token") } footer: {
                        Text("Prototype sign-in: paste a fine-grained token with read-only “Pull requests” and “Contents” access. It is stored in the iOS Keychain and only sent to your DevTok server to fetch the PR. A production build would use GitHub's OAuth device flow instead.")
                    }
                    Section { Link("Create a token on GitHub", destination: URL(string: "https://github.com/settings/personal-access-tokens/new")!) }
                }
            }
            .navigationTitle("GitHub").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var settings = AppSettings.shared
    @State private var health: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://localhost:8765", text: $settings.serverURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    Button("Test connection") {
                        Task {
                            guard let u = URL(string: settings.serverURL + "/api/health") else { return }
                            health = (try? await URLSession.shared.data(from: u)).map { _ in "✅ Connected" } ?? "❌ Not reachable"
                        }
                    }
                    if let health { Text(health) }
                } header: { Text("DevTok server") } footer: {
                    Text("Simulator: http://localhost:8765. iPhone: run `python3 pipeline/server.py --host 0.0.0.0` and use your Mac's Wi-Fi IP.")
                }
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}

// MARK: - Job progress: what the pipeline is doing right now (fetch, parse, map, per-role reels)

struct JobView: View {
    let jobID: String
    var onReady: (ReviewSession) -> Void
    var onBack: () -> Void
    @State private var job: JobStatus?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Button(action: onBack) { Label("Back", systemImage: "chevron.left") }.font(.subheadline)
                if let pr = job?.pr {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(pr.repo ?? "")#\(String(pr.number ?? 0))").font(.caption.monospaced()).foregroundStyle(.secondary)
                        Text(pr.title ?? "").font(.title3.bold())
                        HStack(spacing: 12) {
                            Label("\(pr.files ?? 0) files", systemImage: "doc.on.doc")
                            Text("+\(pr.additions ?? 0)").foregroundStyle(.green)
                            Text("−\(pr.deletions ?? 0)").foregroundStyle(.red)
                            Label("\(pr.commits ?? 0)", systemImage: "point.3.connected.trianglepath.dotted")
                            if let a = pr.author { Text("@\(a)") }
                        }.font(.caption.monospaced())
                    }
                    .padding(16).background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.07)))
                } else {
                    Text(job?.pr_url ?? "Starting…").font(.callout.monospaced()).foregroundStyle(.secondary)
                }
                Text(headline).font(.headline)
                ForEach(job?.stages ?? []) { s in
                    HStack(alignment: .top, spacing: 12) {
                        Group {
                            switch s.status {
                            case "done": Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            case "running": ProgressView().controlSize(.small)
                            case "error": Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
                            default: Image(systemName: "circle").foregroundStyle(.secondary)
                            }
                        }.frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(s.label).font(.subheadline.bold())
                                Spacer()
                                if let t = s.t, s.status != "pending" { Text(String(format: "%.0fs", t)).font(.caption2.monospaced()).foregroundStyle(.secondary) }
                            }
                            if !s.detail.isEmpty { Text(s.detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                        }
                    }
                    .padding(12).background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(s.status == "running" ? 0.1 : 0.05)))
                }
                if let e = job?.error ?? error {
                    Label(e, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.callout)
                    Button("Try again") { Task { if let url = job?.pr_url { _ = try? await DevTokAPI().createJob(prURL: url, refresh: true) } } }
                        .buttonStyle(.bordered)
                }
                if let st = job?.stats, job?.status == "done" {
                    Text("Pipeline: \(Int(st.total_seconds ?? 0)) s · \(st.llm_calls ?? 0) LLM calls · \(st.tokens ?? 0) tokens")
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
                if job?.status == "done" {
                    Button { openSession() } label: {
                        HStack { if loading { ProgressView().tint(.white) }; Text("Watch the explainer") }.font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                    }.buttonStyle(.borderedProminent).tint(.pink).disabled(loading)
                }
            }
            .padding(20)
        }
        .background(Color.black.ignoresSafeArea())
        .task(id: jobID) {
            while !Task.isCancelled {
                do { job = try await DevTokAPI().job(jobID); error = nil } catch { self.error = error.localizedDescription }
                if job?.status == "done" || job?.status == "error" {
                    if job?.status == "done", env["DEVTOK_SUBMIT"] == "1" { openSession() }
                    break
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private var headline: String {
        switch job?.status {
        case "done": "Ready — your reels are cut"
        case "error": "Something went wrong"
        default: "Breaking the PR into a story…"
        }
    }

    private func openSession() {
        guard let job else { return }
        loading = true
        Task {
            defer { loading = false }
            do { onReady(try await ReviewSession.load(job: job)) } catch { self.error = error.localizedDescription }
        }
    }
}

// MARK: - Role picker for one PR

struct SessionView: View {
    let session: ReviewSession
    @Binding var role: Role
    var onStart: (Role) -> Void
    var onBack: () -> Void
    @State private var showDebug = false

    var body: some View {
        let m = session.any
        let pr = m.pr
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Button(action: onBack) { Image(systemName: "chevron.left").font(.title3.bold()) }.tint(.white)
                    Text("DevTok").font(.system(size: 30, weight: .black, design: .rounded))
                    Spacer()
                    Button { showDebug = true } label: { Label("Debug", systemImage: "ladybug.fill").font(.footnote.bold()) }
                        .buttonStyle(.bordered).tint(.orange)
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.triangle.pull").foregroundStyle(.green)
                        Text("\(pr.repo ?? "")#\(String(pr.number ?? 0))").font(.caption.monospaced()).foregroundStyle(.secondary)
                        Spacer()
                        Text(session.remote ? "LIVE" : "DEMO").font(.caption2.bold()).padding(.horizontal, 7).padding(.vertical, 3)
                            .background((session.remote ? Color.green : .purple).opacity(0.35), in: Capsule())
                    }
                    Text(pr.title).font(.title3.bold())
                    HStack(spacing: 14) {
                        Label("\(pr.stats.files) files", systemImage: "doc.on.doc")
                        Text("+\(pr.stats.added)").foregroundStyle(.green)
                        Text("−\(pr.stats.deleted)").foregroundStyle(.red)
                        Label("\(pr.commits.count) commits", systemImage: "point.3.connected.trianglepath.dotted")
                    }.font(.caption.monospaced())
                    Text(m.graph.summary).font(.footnote).foregroundStyle(.secondary).lineLimit(5)
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.07)))

                Text("Explain it to me as…").font(.headline).padding(.top, 6)
                ForEach(session.roles) { r in
                    let rm = session.manifests[r]!
                    Button { role = r } label: {
                        HStack(spacing: 14) {
                            Image(systemName: r.symbol).font(.title2).frame(width: 36)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(r.title).font(.headline)
                                Text(r.subtitle).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text("\(rm.items.filter { if case .video = $0 { true } else { false } }.count) reels").font(.caption.bold())
                                Text("\(rm.items.filter { if case .quiz = $0 { true } else { false } }.count) quizzes").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 16).fill(role == r ? Color.pink.opacity(0.25) : Color.white.opacity(0.06)))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(role == r ? Color.pink : .clear, lineWidth: 1.5))
                    }
                    .buttonStyle(.plain)
                }
                Button { onStart(session.manifests[role] != nil ? role : session.roles[0]) } label: {
                    Label("Start reviewing", systemImage: "play.fill").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent).tint(.pink).padding(.top, 8)
                let mocks = session.manifests.values.flatMap { $0.items }.filter { if case .video(let r) = $0 { r.video_is_mock } else { false } }.count
                Text(mocks == 0 ? "Every reel is a rendered architecture-tour video with voice-over." : "\(mocks) reels still use the placeholder video while the real ones render on the server.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .padding(20)
        }
        .background(LinearGradient(colors: [Color(red: 0.09, green: 0.05, blue: 0.16), .black], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .sheet(isPresented: $showDebug) { DebugView(session: session, role: role) }
    }
}

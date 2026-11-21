import Foundation
import Observation

@Observable
final class FeedStore {
    var role: Role
    var manifest: Manifest
    /// question id -> chosen index
    var answers: [String: Int] = [:]
    var watched: Set<String> = []
    var decision: Decision?
    var checked: Set<String> = []
    var skipped: Set<String> = []

    struct Decision { let approved: Bool; let note: String; let at: Date }

    init(role: Role, manifest: Manifest) {
        self.role = role
        self.manifest = manifest
    }

    static func load(_ role: Role, prefix: String = "") -> Manifest {
        guard let m = loadIfPresent(role, prefix: prefix) else { fatalError("missing \(prefix)manifest_\(role.rawValue).json in bundle") }
        return m
    }
    static func loadIfPresent(_ role: Role, prefix: String = "") -> Manifest? {
        guard let url = Bundle.main.url(forResource: "\(prefix)manifest_\(role.rawValue)", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }
    static func loadStrict(_ role: Role) -> Manifest {
        guard let url = Bundle.main.url(forResource: "manifest_\(role.rawValue)", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { fatalError("missing manifest_\(role.rawValue).json in bundle") }
        do { return try JSONDecoder().decode(Manifest.self, from: data) } catch { fatalError("manifest decode: \(error)") }
    }

    static func explainText(_ role: Role, prefix: String = "") -> String {
        guard let url = Bundle.main.url(forResource: "\(prefix)explain_\(role.rawValue)", withExtension: "md"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "(no explain text bundled)" }
        return s
    }

    var reels: [Reel] { manifest.items.compactMap { if case .video(let r) = $0 { r } else { nil } } }
    var checkpoints: [Checkpoint] { manifest.items.compactMap { if case .quiz(let q) = $0 { q } else { nil } } }
    var reelCount: Int { reels.count }

    func component(_ id: String?) -> Graph.Component? { manifest.graph.components.first { $0.id == id } }

    func isAnswered(_ q: Checkpoint) -> Bool { q.questions.allSatisfy { answers[$0.id] != nil } }
    /// answered or skipped: the feed may move on
    func isDone(_ q: Checkpoint) -> Bool { isAnswered(q) || skipped.contains(q.id) }
    func score(_ q: Checkpoint) -> Double {
        let ok = q.questions.filter { answers[$0.id] == $0.correct_index }.count
        return q.questions.isEmpty ? 1 : Double(ok) / Double(q.questions.count)
    }
    var allQuestions: [Question] { checkpoints.flatMap(\.questions) }
    var understanding: Double {
        let qs = allQuestions
        guard !qs.isEmpty else { return 0 }
        return Double(qs.filter { answers[$0.id] == $0.correct_index }.count) / Double(qs.count)
    }
    var quizzesDone: Bool { checkpoints.allSatisfy(isAnswered) }
    var passedAll: Bool { checkpoints.allSatisfy { score($0) >= $0.pass_threshold } }
    var blockingChecks: [Summary.Check] { (manifest.summary.checklist ?? []).filter { $0.blocking == true } }
    /// Quizzes and checklist are advisory: approval is never blocked, the verdict screen just shows what was skipped or missed.
    var canApprove: Bool { true }
    var readyWithConfidence: Bool { quizzesDone && passedAll && blockingChecks.allSatisfy { checked.contains($0.id) } }
    var skippedCount: Int { checkpoints.filter { skipped.contains($0.id) && !isAnswered($0) }.count }
    var openChecks: Int { blockingChecks.filter { !checked.contains($0.id) }.count }
    var missed: [Question] { allQuestions.filter { answers[$0.id] != nil && answers[$0.id] != $0.correct_index } }

    func reel(_ id: String) -> Reel? { reels.first { $0.id == id } }
    func reset() { answers = [:]; watched = []; decision = nil; checked = []; skipped = [] }
}

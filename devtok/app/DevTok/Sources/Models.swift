import Foundation

// Mirrors pipeline/run.py `manifest_<role>.json` (schema devtok.manifest.v1).

enum Role: String, CaseIterable, Identifiable, Codable {
    case technical_engineer, team_lead, paying_manager
    var id: String { rawValue }
    var title: String {
        switch self {
        case .technical_engineer: "Engineer"
        case .team_lead: "Team lead"
        case .paying_manager: "Manager"
        }
    }
    var subtitle: String {
        switch self {
        case .technical_engineer: "Mechanism, code, invariants, what breaks"
        case .team_lead: "Owners, blast radius, what to check"
        case .paying_manager: "What we pay, what users get, risk"
        }
    }
    var symbol: String {
        switch self {
        case .technical_engineer: "chevron.left.forwardslash.chevron.right"
        case .team_lead: "person.3.fill"
        case .paying_manager: "dollarsign.circle.fill"
        }
    }
}

struct Manifest: Decodable {
    let role: Role
    let role_label: String
    let arc: String
    let pr: PRInfo
    let graph: Graph
    let items: [FeedItem]
    let summary: Summary
}

struct PRInfo: Decodable {
    let title: String
    let number: Int?
    let repo: String?
    let url: String?
    let author: String?
    let merged_at: String?
    let stats: Stats
    let commits: [Commit]
    let files: [PRFile]
    struct Stats: Decodable { let files: Int; let added: Int; let deleted: Int }
    struct Commit: Decodable, Identifiable { let sha: String; let message: String; var id: String { sha + message } }
    struct PRFile: Decodable, Identifiable { let path: String; let added: Int; let deleted: Int; let kind: String; var id: String { path } }
}

struct Graph: Decodable {
    let summary: String
    let components: [Component]
    let edges: [Edge]
    struct Component: Decodable, Identifiable {
        let id: String
        let name: String
        let kind: String
        let responsibility: String
        let change: String?
        let owner_team: String?
        let vendor: String?
        let monthly_cost_usd: Double?
        let cost_note: String?
        let risk: String?
        let risk_reason: String?
    }
    struct Edge: Decodable, Identifiable {
        let id: String
        let from: String
        let to: String
        let label: String?
        let change: String?
    }
}

enum FeedItem: Decodable, Identifiable {
    case video(Reel)
    case quiz(Checkpoint)
    case verdict

    var id: String {
        switch self {
        case .video(let r): r.id
        case .quiz(let q): q.id
        case .verdict: "verdict"
        }
    }

    private enum K: String, CodingKey { case type }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .type) {
        case "video": self = .video(try Reel(from: decoder))
        case "quiz": self = .quiz(try Checkpoint(from: decoder))
        default: self = .verdict
        }
    }
}

struct Reel: Decodable, Identifiable {
    let id: String
    let order: Int
    let title: String
    let hook: String
    let scene_type: String?
    let focus_component_id: String
    let path_component_ids: [String]
    let narration: String
    let on_screen_text: String
    let duration_s: Double
    let shots: [Shot]
    let code_refs: [CodeRef]
    let break_it: BreakIt?
    let retain_facts: [String]
    let video: String
    let video_is_mock: Bool
}

struct Shot: Decodable, Identifiable {
    let t_start: Double
    let t_end: Double
    let narration: String?
    let caption: String?
    let visual: String?
    let highlight_component_id: String?
    let code_ref_id: String?
    var id: Double { t_start }
}

struct CodeRef: Decodable, Identifiable {
    let id: String
    let file: String
    let start_line: Int
    let end_line: Int
    let highlight_lines: [Int]
    let why: String
    let language: String
    let lines: [CodeLine]
    var shortFile: String { file.split(separator: "/").last.map(String.init) ?? file }
    var label: String { "\(shortFile):\(start_line)-\(end_line)" }
}

struct CodeLine: Decodable, Identifiable {
    let line: Int
    let code: String
    let added: Bool
    var id: Int { line }
}

struct BreakIt: Decodable {
    let code_ref_id: String
    let line: Int
    let removed_code: String
    let what_breaks: String
}

struct Checkpoint: Decodable, Identifiable {
    let id: String
    let after_video_id: String
    let video_ids: [String]
    let pass_threshold: Double
    let questions: [Question]
}

struct Question: Decodable, Identifiable {
    let id: String
    let label: String
    let prompt: String
    let choices: [String]
    let correct_index: Int
    let explanation: String
    let linked_video_ids: [String]
}

struct Summary: Decodable {
    let verdict_suggestion: String?
    let headline: String?
    let what_changed: [String]?
    let why: String?
    let risks: [Risk]?
    let checklist: [Check]?
    let cost_impact: Cost?
    let user_impact: String?
    struct Risk: Decodable, Identifiable { let title: String; let severity: String?; let mitigation: String?; var id: String { title } }
    struct Check: Decodable, Identifiable { let text: String; let kind: String?; let blocking: Bool?; var id: String { text } }
    struct Cost: Decodable { let summary: String?; let monthly_delta_usd: Double?; let confidence: String? }
}

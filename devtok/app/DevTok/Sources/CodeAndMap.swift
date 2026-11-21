import SwiftUI

// MARK: - Syntax colouring (ported from the old VibeDidactic Components/CodeViews.swift `SyntaxTint`)

enum SyntaxTint {
    private static let keywords: Set<String> = [
        "import", "from", "return", "if", "else", "elif", "for", "while", "await", "async", "class", "def", "self", "raise",
        "try", "except", "finally", "with", "as", "in", "is", "not", "and", "or", "None", "True", "False", "lambda", "yield",
        "assert", "pass", "break", "continue", "global", "case", "match", "func", "let", "var", "const", "function",
    ]
    private static let base = Color.white.opacity(0.92)
    private static let keyword = Color(red: 1.0, green: 0.45, blue: 0.75)
    private static let string = Color(red: 1.0, green: 0.78, blue: 0.45)
    private static let number = Color(red: 0.55, green: 0.85, blue: 1.0)
    private static let typeName = Color(red: 0.55, green: 1.0, blue: 0.85)

    static func attributed(_ line: String, hashComments: Bool = true) -> AttributedString {
        var result = AttributedString()
        func append<S: Sequence>(_ cs: S, _ color: Color) where S.Element == Character {
            var piece = AttributedString(String(cs)); piece.foregroundColor = color; result += piece
        }
        let chars = Array(line)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if hashComments && c == "#" { append(chars[i...], .gray); break }
            if c == "\"" || c == "'" {
                var j = i + 1
                while j < chars.count, chars[j] != c { if chars[j] == "\\" { j += 1 }; j += 1 }
                let end = min(j + 1, chars.count); append(chars[i..<end], string); i = end; continue
            }
            if c.isLetter || c == "_" || c == "@" {
                var j = i
                while j < chars.count, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" || chars[j] == "@" { j += 1 }
                let w = String(chars[i..<j])
                append(w, keywords.contains(w) ? keyword : (w.first?.isUppercase == true ? typeName : base)); i = j; continue
            }
            if c.isNumber {
                var j = i
                while j < chars.count, chars[j].isNumber || chars[j] == "." { j += 1 }
                append(chars[i..<j], number); i = j; continue
            }
            var j = i + 1
            while j < chars.count, !(chars[j].isLetter || chars[j].isNumber || "\"'#_@".contains(chars[j])) { j += 1 }
            append(chars[i..<j], base); i = j
        }
        return result
    }
}

// MARK: - Code sheet: file:line refs with highlighted and "break-it" lines

struct CodeSheet: View {
    let reel: Reel
    var focus: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    ForEach(reel.code_refs) { ref in
                        CodeCard(ref: ref, breakIt: reel.break_it?.code_ref_id == ref.id ? reel.break_it : nil, focused: ref.id == focus)
                    }
                }.padding()
            }
            .background(Color(red: 0.06, green: 0.07, blue: 0.1))
            .navigationTitle("Code · \(reel.title)").navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct CodeCard: View {
    let ref: CodeRef
    let breakIt: BreakIt?
    var focused = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: "doc.text").foregroundStyle(.green)
                Text(ref.file).font(.caption.monospaced().bold()).lineLimit(1).truncationMode(.head)
                Spacer()
                Text("L\(ref.start_line)–\(ref.end_line)").font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
            .padding(10).background(Color.white.opacity(0.06))
            if !ref.why.isEmpty {
                Text(ref.why).font(.caption).foregroundStyle(.yellow).padding(.horizontal, 10).padding(.vertical, 6)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(ref.lines) { l in
                        let hl = ref.highlight_lines.contains(l.line)
                        let broken = breakIt?.line == l.line
                        HStack(spacing: 8) {
                            Text("\(l.line)").frame(width: 38, alignment: .trailing).foregroundStyle(.white.opacity(0.35))
                            Text(l.added ? "+" : " ").bold().foregroundStyle(.green).frame(width: 8)
                            Text(SyntaxTint.attributed(l.code)).strikethrough(broken, color: .red)
                        }
                        .font(.system(size: 12, design: .monospaced))
                        .padding(.vertical, 2).padding(.trailing, 12)
                        .frame(minWidth: 340, alignment: .leading)
                        .background(broken ? Color.red.opacity(0.28) : hl ? Color.yellow.opacity(0.18) : l.added ? Color.green.opacity(0.08) : .clear)
                    }
                }.padding(.vertical, 6)
            }
            if let b = breakIt {
                VStack(alignment: .leading, spacing: 4) {
                    Label("Break it: delete line \(b.line)", systemImage: "bolt.trianglebadge.exclamationmark.fill").font(.caption.bold()).foregroundStyle(.red)
                    Text(b.what_breaks).font(.caption)
                }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Color.red.opacity(0.12))
            }
        }
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(red: 0.11, green: 0.12, blue: 0.16)))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(focused ? Color.green : .white.opacity(0.08), lineWidth: focused ? 2 : 1))
    }
}

// MARK: - Architecture map ("AWS diagram" style): layered boxes, animated packets, tap for role-relevant details

struct MapSheet: View {
    let store: FeedStore
    let reel: Reel?
    @State private var selected: String?

    var body: some View {
        let g = store.manifest.graph
        NavigationStack {
            VStack(spacing: 0) {
                ArchitectureDiagram(graph: g, focus: selected ?? reel?.focus_component_id,
                                    path: Set(reel?.path_component_ids ?? []), onTap: { selected = $0 })
                    .frame(maxHeight: .infinity)
                if let c = store.component(selected ?? reel?.focus_component_id) {
                    ComponentCard(c: c, role: store.role).padding()
                }
            }
            .background(Color(red: 0.05, green: 0.06, blue: 0.1))
            .navigationTitle("System map").navigationBarTitleDisplayMode(.inline)
        }
    }
}

struct ComponentCard: View {
    let c: Graph.Component
    let role: Role
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(c.name).font(.headline)
                Spacer()
                if let ch = c.change { Text(ch.uppercased()).font(.caption2.bold()).padding(4).background((ch == "added" ? Color.green : ch == "modified" ? .orange : .gray).opacity(0.4), in: Capsule()) }
            }
            Text(c.responsibility).font(.subheadline)
            if role != .technical_engineer, let t = c.owner_team { Label(t, systemImage: "person.3").font(.caption) }
            if role == .paying_manager || role == .team_lead {
                if let cost = c.monthly_cost_usd { Label("$\(Int(cost)) / month", systemImage: "dollarsign.circle").font(.caption.bold()).foregroundStyle(.green) }
                if let n = c.cost_note { Text(n).font(.caption).foregroundStyle(.secondary) }
            }
            if let r = c.risk { Label("Risk \(r): \(c.risk_reason ?? "")", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(r == "high" ? .red : .yellow) }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.07)))
    }
}

struct ArchitectureDiagram: View {
    let graph: Graph
    var focus: String?
    var path: Set<String> = []
    var onTap: (String) -> Void = { _ in }

    /// Longest-path layering, top to bottom.
    private var layers: [[Graph.Component]] {
        var layer: [String: Int] = [:]
        for c in graph.components { layer[c.id] = 0 }
        for _ in 0..<graph.components.count {
            for e in graph.edges where e.from != e.to { if let a = layer[e.from], let b = layer[e.to], b < a + 1, a < 6 { layer[e.to] = a + 1 } }
        }
        let maxL = layer.values.max() ?? 0
        return (0...maxL).map { l in graph.components.filter { layer[$0.id] == l } }.filter { !$0.isEmpty }
    }

    var body: some View {
        GeometryReader { geo in
            let L = layers
            let pos = positions(L, geo.size)
            TimelineView(.animation) { tl in
                let time = tl.date.timeIntervalSinceReferenceDate
                ZStack {
                    Canvas { ctx, _ in
                        for (i, e) in graph.edges.enumerated() {
                            guard let a = pos[e.from], let b = pos[e.to] else { continue }
                            let hot = e.from == focus || e.to == focus || (path.contains(e.from) && path.contains(e.to))
                            var p = Path(); p.move(to: a); p.addLine(to: b)
                            ctx.stroke(p, with: .color(hot ? .cyan : .white.opacity(0.2)), style: StrokeStyle(lineWidth: hot ? 2.5 : 1.2, dash: e.change == "added" ? [6, 4] : []))
                            // packet
                            let k = (time * (hot ? 0.6 : 0.25) + Double(i) * 0.17).truncatingRemainder(dividingBy: 1)
                            let q = CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
                            ctx.fill(Path(ellipseIn: CGRect(x: q.x - 4, y: q.y - 4, width: 8, height: 8)), with: .color(hot ? .yellow : .white.opacity(0.5)))
                        }
                    }
                    ForEach(graph.components) { c in
                        if let p = pos[c.id] {
                            let isFocus = c.id == focus, inPath = path.contains(c.id)
                            VStack(spacing: 3) {
                                Image(systemName: icon(c.kind)).font(.system(size: 16, weight: .bold))
                                Text(c.name).font(.system(size: 11, weight: .bold)).multilineTextAlignment(.center).lineLimit(2)
                            }
                            .foregroundStyle(.white)
                            .frame(width: 104, height: 58)
                            .background(RoundedRectangle(cornerRadius: 12).fill(color(c.kind).opacity(isFocus ? 0.95 : inPath ? 0.6 : 0.32)))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(isFocus ? Color.yellow : c.change == "added" ? .green : .white.opacity(0.15), lineWidth: isFocus ? 3 : 1.2))
                            .scaleEffect(isFocus ? 1.0 + 0.04 * sin(time * 4) : 1)
                            .position(p)
                            .onTapGesture { onTap(c.id) }
                        }
                    }
                }
            }
        }
        .padding(.vertical, 10)
    }

    private func positions(_ L: [[Graph.Component]], _ s: CGSize) -> [String: CGPoint] {
        var out: [String: CGPoint] = [:]
        let rows = max(1, L.count)
        for (r, row) in L.enumerated() {
            let y = s.height * (CGFloat(r) + 0.5) / CGFloat(rows)
            let cols = row.count
            for (i, c) in row.enumerated() {
                let per = min(3, cols)
                let line = i / per, idx = i % per
                let inLine = min(per, cols - line * per)
                let x = s.width * (CGFloat(idx) + 0.5) / CGFloat(inLine)
                out[c.id] = CGPoint(x: x, y: y + CGFloat(line) * 66 - CGFloat((cols - 1) / per) * 33)
            }
        }
        return out
    }
    private func icon(_ k: String) -> String {
        switch k {
        case "external": "cloud.fill"
        case "store": "cylinder.split.1x2.fill"
        case "ui": "iphone"
        case "test": "checkmark.shield.fill"
        case "service": "server.rack"
        case "job": "gearshape.2.fill"
        case "config": "slider.horizontal.3"
        default: "shippingbox.fill"
        }
    }
    private func color(_ k: String) -> Color {
        switch k {
        case "external": .purple
        case "store": .orange
        case "ui": .pink
        case "test": .green
        case "service": .blue
        default: .teal
        }
    }
}

// MARK: - Script sheet (what is being explained in this reel)

struct ScriptSheet: View {
    let store: FeedStore
    let reel: Reel
    var body: some View {
        NavigationStack {
            List {
                Section("Hook") { Text(reel.hook) }
                Section("Narration (\(Int(reel.duration_s)) s)") { Text(reel.narration) }
                Section("Shots") {
                    ForEach(reel.shots) { s in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(format: "%.1f–%.1fs  ·  %@", s.t_start, s.t_end, s.caption ?? "")).font(.caption.monospaced().bold())
                            Text(s.narration ?? "").font(.subheadline)
                            if let v = s.visual { Text("🎬 \(v)").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                Section("Remember") { ForEach(reel.retain_facts, id: \.self) { Text("• \($0)") } }
            }
            .navigationTitle(reel.title).navigationBarTitleDisplayMode(.inline)
        }
    }
}

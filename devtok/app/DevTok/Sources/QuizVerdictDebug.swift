import SwiftUI
import UIKit

// MARK: - Quiz page (after every 2 reels). Feed scrolling is locked until every question is answered.

struct QuizPage: View {
    @Bindable var store: FeedStore
    let checkpoint: Checkpoint
    var onNext: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Label("Vibe check", systemImage: "brain.head.profile").font(.title2.weight(.black))
                    Spacer()
                    if store.isAnswered(checkpoint) {
                        Text("\(Int(store.score(checkpoint) * 100))%").font(.title3.bold())
                            .foregroundStyle(store.score(checkpoint) >= checkpoint.pass_threshold ? .green : .orange)
                    }
                }
                Text("About reels \(checkpoint.video_ids.compactMap { store.reel($0)?.order }.map(String.init).joined(separator: " & ")): \(checkpoint.video_ids.compactMap { store.reel($0)?.title }.joined(separator: " · "))")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(checkpoint.questions) { q in QuestionCard(store: store, q: q) }
                if store.isAnswered(checkpoint) {
                    Button(action: onNext) {
                        Label(store.score(checkpoint) >= checkpoint.pass_threshold ? "Nice — keep going" : "Continue (we'll flag this on approval)",
                              systemImage: "arrow.down").frame(maxWidth: .infinity).padding(.vertical, 12)
                    }.buttonStyle(.borderedProminent).tint(.pink)
                } else {
                    HStack {
                        Label("Answer to continue — or", systemImage: "lock.open").font(.caption).foregroundStyle(.secondary)
                        Button {
                            store.skipped.insert(checkpoint.id)
                            onNext()
                        } label: { Label("Skip quiz", systemImage: "forward.fill").font(.subheadline.bold()) }
                            .buttonStyle(.bordered).tint(.white)
                    }.frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 18).padding(.top, 120).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .foregroundStyle(.white)
        .background(LinearGradient(colors: [Color(red: 0.25, green: 0.05, blue: 0.3), Color(red: 0.05, green: 0.02, blue: 0.12)], startPoint: .top, endPoint: .bottom))
    }
}

struct QuestionCard: View {
    @Bindable var store: FeedStore
    let q: Question
    var body: some View {
        let chosen = store.answers[q.id]
        VStack(alignment: .leading, spacing: 10) {
            Text(q.label.uppercased()).font(.caption2.bold().monospaced()).foregroundStyle(.pink)
            Text(q.prompt).font(.headline)
            ForEach(Array(q.choices.enumerated()), id: \.offset) { i, ch in
                Button {
                    guard chosen == nil else { return }
                    store.answers[q.id] = i
                    UINotificationFeedbackGenerator().notificationOccurred(i == q.correct_index ? .success : .error)
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Text(["A", "B", "C", "D"][i]).font(.subheadline.bold()).frame(width: 26, height: 26)
                            .background(Circle().fill(Color.white.opacity(0.15)))
                        Text(ch).font(.subheadline).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        if chosen != nil && i == q.correct_index { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                        else if chosen == i { Image(systemName: "xmark.circle.fill").foregroundStyle(.red) }
                    }
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(fill(i, chosen)))
                }
                .buttonStyle(.plain)
            }
            if chosen != nil {
                Text(q.explanation).font(.footnote).foregroundStyle(.white.opacity(0.85)).padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.3)))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.07)))
    }
    private func fill(_ i: Int, _ chosen: Int?) -> Color {
        guard let chosen else { return .white.opacity(0.08) }
        if i == q.correct_index { return .green.opacity(0.35) }
        if i == chosen { return .red.opacity(0.35) }
        return .white.opacity(0.05)
    }
}

// MARK: - Verdict page: summary, risks, checklist, understanding score, approve / request changes

struct VerdictPage: View {
    @Bindable var store: FeedStore
    var onMap: () -> Void
    var onRestart: () -> Void
    @State private var note = ""
    @State private var drag: CGFloat = 0
    @State private var showCommits = false

    var body: some View {
        let s = store.manifest.summary
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Label("Ready to decide?", systemImage: "flag.checkered").font(.title2.weight(.black))
                HStack(spacing: 14) {
                    Gauge(value: store.understanding) { EmptyView() } currentValueLabel: { Text("\(Int(store.understanding * 100))%").font(.caption.bold()) }
                        .gaugeStyle(.accessoryCircularCapacity).tint(store.passedAll ? .green : .orange).scaleEffect(1.2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Your understanding").font(.caption).foregroundStyle(.secondary)
                        Text(store.readyWithConfidence ? "Passed every check" :
                             [store.skippedCount > 0 ? "\(store.skippedCount) quiz skipped" : nil,
                              store.missed.isEmpty ? nil : "\(store.missed.count) answer(s) to revisit",
                              store.openChecks > 0 ? "\(store.openChecks) check(s) open" : nil].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline.bold())
                        Text("AI suggests: \((s.verdict_suggestion ?? "").replacingOccurrences(of: "_", with: " "))").font(.caption).foregroundStyle(.yellow)
                    }
                }
                if let h = s.headline { Text(h).font(.headline) }
                section("What changed", items: s.what_changed ?? [])
                if let risks = s.risks, !risks.isEmpty {
                    Text("Risks").font(.subheadline.bold())
                    ForEach(risks) { r in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\((r.severity ?? "").uppercased()) · \(r.title)").font(.caption.bold()).foregroundStyle(r.severity == "high" ? .red : .orange)
                            if let m = r.mitigation { Text(m).font(.caption) }
                        }
                    }
                }
                if let checks = s.checklist, !checks.isEmpty {
                    Text("Checklist").font(.subheadline.bold())
                    ForEach(checks) { c in
                        Button {
                            if store.checked.contains(c.id) { store.checked.remove(c.id) } else { store.checked.insert(c.id) }
                        } label: {
                            HStack(alignment: .top) {
                                Image(systemName: store.checked.contains(c.id) ? "checkmark.square.fill" : "square").foregroundStyle(.green)
                                Text(c.text).font(.caption).multilineTextAlignment(.leading)
                                Spacer()
                                if c.blocking == true { Text("IMPORTANT").font(.system(size: 9, weight: .black)).foregroundStyle(.orange) }
                            }
                        }.buttonStyle(.plain)
                    }
                }
                if let c = s.cost_impact?.summary { Label(c, systemImage: "dollarsign.circle").font(.caption) }
                if let u = s.user_impact { Label(u, systemImage: "person.2").font(.caption) }
                HStack {
                    Button(action: onMap) { Label("System map", systemImage: "point.3.filled.connected.trianglepath.dotted") }
                    Button { showCommits.toggle() } label: { Label("\(store.manifest.pr.commits.count) commits", systemImage: "list.bullet") }
                }.buttonStyle(.bordered).font(.caption)
                if showCommits {
                    ForEach(store.manifest.pr.commits) { c in
                        Text("\(c.sha)  \(c.message)").font(.system(size: 10, design: .monospaced)).lineLimit(1)
                    }
                }
                if let d = store.decision {
                    VStack(spacing: 8) {
                        Image(systemName: d.approved ? "checkmark.seal.fill" : "arrow.uturn.backward.circle.fill").font(.system(size: 54))
                            .foregroundStyle(d.approved ? .green : .orange)
                        Text(d.approved ? "Approved with confidence" : "Changes requested").font(.title3.bold())
                        if !d.note.isEmpty { Text("“\(d.note)”").font(.caption).foregroundStyle(.secondary) }
                        Button("Start over", action: onRestart).buttonStyle(.bordered)
                    }.frame(maxWidth: .infinity).padding(.vertical, 10)
                } else {
                    TextField("Note for the author (optional)", text: $note, axis: .vertical).textFieldStyle(.roundedBorder)
                    decisionCard
                    if !store.readyWithConfidence {
                        Label("Quizzes and checklist are advisory — you can approve anyway; the gaps are noted in your review.", systemImage: "info.circle")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.horizontal, 18).padding(.top, 120).padding(.bottom, 40)
        }
        .scrollIndicators(.hidden)
        .foregroundStyle(.white)
        .background(LinearGradient(colors: [Color(red: 0.03, green: 0.15, blue: 0.12), .black], startPoint: .top, endPoint: .bottom))
        .overlay {
            if let ok = celebrate {
                DecisionCelebration(approved: ok, pr: "\(store.manifest.pr.repo ?? "")#\(String(store.manifest.pr.number ?? 0))",
                                    caveat: store.readyWithConfidence ? nil : "with notes: skipped/missed checks attached",
                                    onDone: { withAnimation { celebrate = nil } })
                    .transition(.opacity)
            }
        }
    }

    /// Swipe right to approve, left to request changes (idea from the old DecisionPrompt), with buttons as a fallback.
    private var decisionCard: some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 18).fill(drag > 40 ? Color.green.opacity(0.5) : drag < -40 ? Color.orange.opacity(0.5) : Color.white.opacity(0.08))
                Text(drag > 40 ? "Approve →" : drag < -40 ? "← Request changes" : "Swipe → approve · ← request changes").font(.subheadline.bold())
            }
            .frame(height: 64)
            .offset(x: drag)
            .gesture(DragGesture().onChanged { v in drag = store.canApprove || v.translation.width < 0 ? v.translation.width : min(v.translation.width, 30) }
                .onEnded { v in
                    if v.translation.width > 110 && store.canApprove { decide(true) } else if v.translation.width < -110 { decide(false) }
                    withAnimation(.spring) { drag = 0 }
                })
            HStack {
                Button { decide(false) } label: { Label("Request changes", systemImage: "arrow.uturn.backward").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(.orange)
                Button { decide(true) } label: { Label("Approve PR", systemImage: "checkmark.seal.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.green).disabled(!store.canApprove)
            }
        }
    }

    @State private var celebrate: Bool?
    private func decide(_ ok: Bool) {
        UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .warning)
        withAnimation(.smooth) { store.decision = .init(approved: ok, note: note, at: .now) }
        celebrate = ok
    }

    @ViewBuilder private func section(_ title: String, items: [String]) -> some View {
        if !items.isEmpty {
            Text(title).font(.subheadline.bold())
            ForEach(items, id: \.self) { Text("• \($0)").font(.caption) }
        }
    }
}

// MARK: - Debug: the generated texts of what we explain (per role), plus raw pipeline markdown

struct DebugView: View {
    let session: ReviewSession
    @State var role: Role
    @State private var raw = false
    var body: some View {
        let m = session.manifests[role] ?? session.any
        NavigationStack {
            List {
                Picker("Role", selection: $role) { ForEach(session.roles) { Text($0.title).tag($0) } }.pickerStyle(.segmented)
                Toggle("Raw pipeline markdown", isOn: $raw)
                if raw {
                    Text(session.explains[role] ?? "").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                } else {
                    Section("Arc") { Text(m.arc) }
                    Section("System (\(m.graph.components.count) components, \(m.graph.edges.count) edges)") {
                        Text(m.graph.summary).font(.footnote)
                        ForEach(m.graph.components) { c in
                            VStack(alignment: .leading) {
                                Text("\(c.name)  ·  \(c.kind)  ·  \(c.change ?? "")").font(.caption.bold())
                                Text(c.responsibility).font(.caption)
                            }
                        }
                    }
                    ForEach(m.items) { it in
                        switch it {
                        case .video(let r):
                            Section("Reel \(r.order): \(r.title)  (\(Int(r.duration_s))s, \(r.scene_type ?? ""))") {
                                Text(r.narration).font(.footnote).textSelection(.enabled)
                                ForEach(r.code_refs) { Text("⌨︎ \($0.file):\($0.start_line)-\($0.end_line) — \($0.why)").font(.caption2.monospaced()) }
                                if let b = r.break_it { Text("⚡︎ line \(b.line): \(b.what_breaks)").font(.caption2) }
                            }
                        case .quiz(let q):
                            Section("Quiz \(q.id)") {
                                ForEach(q.questions) { x in Text("\(x.prompt)\n✔ \(x.choices[x.correct_index])").font(.caption) }
                            }
                        case .verdict:
                            Section("Approval summary") {
                                Text(m.summary.headline ?? "").font(.footnote.bold())
                                ForEach(m.summary.checklist ?? []) { Text("☐ \($0.text)").font(.caption) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Debug · explain texts").navigationBarTitleDisplayMode(.inline)
        }
    }
}


// MARK: - Approval celebration (visual only: nothing is posted to GitHub in the prototype)

struct DecisionCelebration: View {
    let approved: Bool
    let pr: String
    var caveat: String?
    var onDone: () -> Void
    @State private var start = Date()
    @State private var pop = false

    private var steps: [String] {
        approved ? ["Recording your review", "Posting “Approve” to \(pr)", "Required checks green", "Ready to merge"]
                 : ["Recording your notes", "Posting “Request changes” to \(pr)", "Author notified"]
    }

    var body: some View {
        TimelineView(.animation) { tl in
            let t = tl.date.timeIntervalSince(start)
            ZStack {
                Rectangle().fill(.ultraThinMaterial).overlay(Color.black.opacity(0.78)).ignoresSafeArea()
                if approved { Confetti(t: t).ignoresSafeArea().allowsHitTesting(false) }
                VStack(spacing: 22) {
                    ZStack {
                        Circle().fill((approved ? Color.green : .orange).opacity(0.18)).frame(width: 220, height: 220)
                            .scaleEffect(1 + 0.08 * sin(t * 3))
                        Circle().stroke((approved ? Color.green : .orange).opacity(max(0, 1 - (t.truncatingRemainder(dividingBy: 1.6)) / 1.6)), lineWidth: 4)
                            .frame(width: 160 + 140 * (t.truncatingRemainder(dividingBy: 1.6)) / 1.6)
                        Image(systemName: approved ? "checkmark.seal.fill" : "arrow.uturn.backward.circle.fill")
                            .font(.system(size: 110, weight: .bold))
                            .foregroundStyle(approved ? Color.green : .orange)
                            .scaleEffect(pop ? 1 : 0.2).rotationEffect(.degrees(pop ? 0 : -40))
                    }
                    Text(approved ? "Approved!" : "Changes requested").font(.system(size: 40, weight: .black, design: .rounded))
                    if let caveat { Text(caveat).font(.caption).foregroundStyle(.secondary) }
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
                            let shown = t > 0.7 + Double(i) * 0.7, done = t > 1.2 + Double(i) * 0.7
                            HStack(spacing: 10) {
                                Group { if done { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) } else { ProgressView().controlSize(.small) } }
                                    .frame(width: 22)
                                Text(s).font(.callout.weight(.semibold))
                            }
                            .opacity(shown ? 1 : 0).offset(x: shown ? 0 : 30)
                            .animation(.spring(duration: 0.4), value: shown)
                        }
                    }
                    .padding(16).frame(maxWidth: 320, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.08)))
                    Text("Prototype: nothing is sent to GitHub yet").font(.caption2).foregroundStyle(.secondary)
                    Button(action: onDone) { Text("Done").font(.headline).frame(width: 200).padding(.vertical, 12) }
                        .buttonStyle(.borderedProminent).tint(approved ? .green : .orange)
                        .opacity(t > 1.2 + Double(steps.count) * 0.7 ? 1 : 0.3)
                }
                .foregroundStyle(.white)
            }
        }
        .onAppear {
            start = .now
            withAnimation(.spring(response: 0.55, dampingFraction: 0.5)) { pop = true }
            for i in 0..<steps.count { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2 + Double(i) * 0.7) { UIImpactFeedbackGenerator(style: .light).impactOccurred() } }
        }
    }
}

/// Deterministic confetti burst drawn with Canvas.
struct Confetti: View {
    let t: Double
    private static let colors: [Color] = [.pink, .yellow, .green, .cyan, .orange, .purple, .white]
    var body: some View {
        Canvas { ctx, size in
            for i in 0..<160 {
                let r1 = frac(sin(Double(i) * 12.9898) * 43758.5453), r2 = frac(sin(Double(i) * 78.233) * 12345.678)
                let r3 = frac(sin(Double(i) * 3.17) * 9876.54)
                let ang = -Double.pi / 2 + (r1 - 0.5) * 2.2
                let speed = 520 + r2 * 680
                let tt = max(0, t - r3 * 0.25)
                let x = size.width / 2 + cos(ang) * speed * tt + sin(tt * 6 + Double(i)) * 18
                let y = size.height * 0.42 + sin(ang) * speed * tt + 900 * tt * tt
                guard y < size.height + 40 else { continue }
                var c = ctx
                c.translateBy(x: x, y: y)
                c.rotate(by: .radians(tt * (4 + r1 * 8)))
                c.fill(Path(CGRect(x: -5, y: -3, width: 10, height: 6 + r2 * 6)), with: .color(Self.colors[i % Self.colors.count]))
            }
        }
    }
    private func frac(_ x: Double) -> Double { x - floor(x) }
}

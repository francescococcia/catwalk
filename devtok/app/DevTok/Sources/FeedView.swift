import AVFoundation
import SwiftUI

/// Full-screen vertical paging feed (pattern from the old VibeDidactic ReelFeedView): reels, a quiz after every 2, verdict.
struct FeedView: View {
    @Bindable var store: FeedStore
    let session: ReviewSession
    var onExit: () -> Void
    @State private var position: String?
    @State private var sheet: SheetKind?

    enum SheetKind: Identifiable {
        case code(Reel, String?), map(Reel?), script(Reel), debug
        var id: String {
            switch self {
            case .code(let r, _): "code" + r.id
            case .map(let r): "map" + (r?.id ?? "")
            case .script(let r): "script" + r.id
            case .debug: "debug"
            }
        }
    }

    private var items: [FeedItem] { store.manifest.items }
    private var currentIndex: Int { items.firstIndex { $0.id == position } ?? 0 }
    /// Lock forward swiping on an unanswered quiz.
    private var locked: Bool {
        if case .quiz(let q) = items[currentIndex] { return !store.isDone(q) }
        return false
    }

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(spacing: 0) {
                ForEach(items) { item in
                    page(item)
                        .containerRelativeFrame([.horizontal, .vertical])
                        .id(item.id)
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $position)
        .scrollIndicators(.hidden)
        .scrollDisabled(locked)
        .ignoresSafeArea()
        .background(Color.black)
        .overlay(alignment: .top) { header }
        .onAppear {
            if position == nil { position = items.first?.id }
            // Debug/demo launch flags: DEVTOK_ANSWER_ALL=1 answers every quiz correctly, DEVTOK_JUMP=<item id> opens that page.
            let env = ProcessInfo.processInfo.environment
            if env["DEVTOK_ANSWER_ALL"] == "1" { for q in store.allQuestions { store.answers[q.id] = q.correct_index } }
            if let j = env["DEVTOK_JUMP"], items.contains(where: { $0.id == j }) { position = j }
        }
        .sheet(item: $sheet) { s in
            switch s {
            case .code(let r, let id): CodeSheet(reel: r, focus: id).presentationDetents([.medium, .large])
            case .map(let r): MapSheet(store: store, reel: r).presentationDetents([.large])
            case .script(let r): ScriptSheet(store: store, reel: r).presentationDetents([.medium, .large])
            case .debug: DebugView(session: session, role: store.role)
            }
        }
    }

    @ViewBuilder private func page(_ item: FeedItem) -> some View {
        switch item {
        case .video(let r):
            ReelPage(store: store, reel: r, isActive: position == r.id && sheet == nil,
                     onCode: { id in sheet = .code(r, id) }, onMap: { sheet = .map(r) }, onScript: { sheet = .script(r) })
        case .quiz(let q):
            QuizPage(store: store, checkpoint: q, onNext: { advance() })
        case .verdict:
            VerdictPage(store: store, onMap: { sheet = .map(nil) }, onRestart: { store.reset(); withAnimation { position = items.first?.id } })
        }
    }

    private func advance() {
        let i = currentIndex + 1
        if i < items.count { withAnimation(.smooth) { position = items[i].id } }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Button(action: onExit) { Image(systemName: "chevron.left").font(.headline).padding(6) }
                Text("\(store.manifest.pr.repo ?? "")#\(String(store.manifest.pr.number ?? 0))  ·  \(store.role.title)")
                    .font(.caption.monospaced().bold()).lineLimit(1)
                Spacer()
                Button { sheet = .debug } label: { Image(systemName: "ladybug").font(.subheadline).padding(6) }
            }
            ProgressDots(items: items, current: currentIndex, store: store).padding(.leading, 10)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.top, 2)
        .padding(.bottom, 10)
        .background(LinearGradient(colors: [.black.opacity(0.85), .black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom)
            .ignoresSafeArea(edges: .top))
        .shadow(color: .black.opacity(0.6), radius: 6)
    }
}

struct ProgressDots: View {
    let items: [FeedItem]
    let current: Int
    let store: FeedStore
    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                switch it {
                case .video: Capsule().fill(i <= current ? Color.white : .white.opacity(0.3)).frame(width: 14, height: 4)
                case .quiz(let q):
                    Image(systemName: store.isAnswered(q) ? "checkmark.seal.fill" : "questionmark.circle.fill")
                        .font(.system(size: 10)).foregroundStyle(store.isAnswered(q) ? .green : (i <= current ? .yellow : .white.opacity(0.4)))
                case .verdict: Image(systemName: "flag.checkered").font(.system(size: 10)).foregroundStyle(i <= current ? .white : .white.opacity(0.4))
                }
            }
        }
    }
}

// MARK: - Reel page

struct ReelPage: View {
    let store: FeedStore
    let reel: Reel
    let isActive: Bool
    var onCode: (String?) -> Void
    var onMap: () -> Void
    var onScript: () -> Void
    @State private var player = LoopingPlayer()
    @State private var t: Double = 0
    @State private var liked = false
    private let tick = Timer.publish(every: 0.25, on: .main, in: .common).autoconnect()

    /// Script time runs on its own clock (the mock video length differs from the narration length).
    private var shot: Shot? { reel.shots.last { t >= $0.t_start } ?? reel.shots.first }
    private var focus: Graph.Component? { store.component(shot?.highlight_component_id ?? reel.focus_component_id) }

    var body: some View {
        ZStack {
            PlayerLayerView(player: player.player).ignoresSafeArea()
            LinearGradient(colors: [.black.opacity(0.55), .clear, .clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea().allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 10) {
                // top: reel title + scripted shot caption (the rendered video draws its own title, so only for mock video)
                if reel.video_is_mock { VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text("REEL \(reel.order)/\(store.reelCount)").font(.caption2.bold().monospaced())
                            .padding(.horizontal, 6).padding(.vertical, 3).background(.pink, in: Capsule())
                        Text(reel.scene_type?.replacingOccurrences(of: "_", with: " ").uppercased() ?? "").font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 3).background(.white.opacity(0.18), in: Capsule())
                        if reel.video_is_mock {
                            Text("MOCK VIDEO").font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 3)
                                .background(.orange.opacity(0.8), in: Capsule())
                        }
                    }
                    Text(reel.title).font(.title2.weight(.heavy)).lineLimit(2)
                    if let focus {
                        Button(action: onMap) {
                            Label(focus.name, systemImage: "square.3.layers.3d.top.filled")
                                .font(.caption.bold()).padding(.horizontal, 9).padding(.vertical, 5)
                                .background(.ultraThinMaterial, in: Capsule())
                        }.buttonStyle(.plain)
                    }
                }
                .padding(.top, 118) }
                Spacer()
                // bottom: narration subtitle for the current shot + code chip
                if let s = shot, reel.video_is_mock {
                    VStack(alignment: .leading, spacing: 6) {
                        if let cap = s.caption, !cap.isEmpty {
                            Text(cap.uppercased()).font(.system(size: 13, weight: .black)).foregroundStyle(.yellow)
                        }
                        Text(s.narration ?? reel.narration).font(.callout.weight(.semibold)).lineLimit(5)
                            .id(s.t_start).transition(.opacity)
                    }
                    .padding(12)
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 14))
                    .padding(.trailing, 64)
                }
                if let ref = reel.code_refs.first(where: { $0.id == shot?.code_ref_id }) ?? reel.code_refs.first {
                    Button { onCode(ref.id) } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "chevron.left.forwardslash.chevron.right")
                            Text(ref.label).font(.caption.monospaced().bold()).lineLimit(1)
                            if reel.break_it?.code_ref_id == ref.id { Image(systemName: "bolt.trianglebadge.exclamationmark.fill").foregroundStyle(.red) }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Color(red: 0.12, green: 0.13, blue: 0.18).opacity(0.92), in: Capsule())
                        .overlay(Capsule().stroke(.green.opacity(0.7), lineWidth: 1))
                    }.buttonStyle(.plain)
                }
                ScriptProgress(reel: reel, t: t).padding(.trailing, 64)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.bottom, 50)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

            // TikTok action rail
            VStack(spacing: 20) {
                Spacer()
                RailButton(icon: liked ? "heart.fill" : "heart", label: "Clear", tint: liked ? .pink : .white) { liked.toggle() }
                RailButton(icon: "chevron.left.forwardslash.chevron.right", label: "\(reel.code_refs.count) code", tint: .green) { onCode(nil) }
                    .opacity(reel.code_refs.isEmpty ? 0.35 : 1).disabled(reel.code_refs.isEmpty)
                RailButton(icon: "point.3.filled.connected.trianglepath.dotted", label: "Map", tint: .cyan, action: onMap)
                RailButton(icon: "text.bubble.fill", label: "Script", tint: .yellow, action: onScript)
                RailButton(icon: player.muted ? "speaker.slash.fill" : "speaker.wave.2.fill", label: "Sound", tint: .white) { player.toggleMute() }
            }
            .padding(.trailing, 10).padding(.bottom, 120)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        }
        .contentShape(Rectangle())
        .onTapGesture { player.togglePause() }
        .onAppear { player.load(reel.video) ; if isActive { start() } }
        .onChange(of: isActive) { _, on in on ? start() : player.pause() }
        .onDisappear { player.pause() }
        .onReceive(tick) { _ in
            guard isActive, !player.paused else { return }
            if reel.video_is_mock {
                withAnimation(.easeInOut(duration: 0.25)) { t = (t + 0.25).truncatingRemainder(dividingBy: max(reel.duration_s, 1) + 1.5) }
            } else {
                t = player.currentSeconds  // real video: script timing == player time
            }
            store.watched.insert(reel.id)
        }
    }

    private func start() { t = 0; player.restart() }
}

struct ScriptProgress: View {
    let reel: Reel
    let t: Double
    var body: some View {
        GeometryReader { g in
            HStack(spacing: 3) {
                ForEach(reel.shots) { s in
                    let w = (s.t_end - s.t_start) / max(reel.duration_s, 1)
                    let p = min(1, max(0, (t - s.t_start) / max(0.1, s.t_end - s.t_start)))
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.25))
                        Capsule().fill(.white).frame(width: max(0, (g.size.width * w - 3) * p))
                    }
                    .frame(width: max(4, g.size.width * w - 3))
                }
            }
        }.frame(height: 3)
    }
}

struct RailButton: View {
    let icon: String
    let label: String
    var tint: Color = .white
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 24, weight: .semibold)).foregroundStyle(tint)
                    .frame(width: 46, height: 46).background(.black.opacity(0.35), in: Circle())
                Text(label).font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
            }
        }.buttonStyle(.plain).shadow(color: .black.opacity(0.5), radius: 4)
    }
}

// MARK: - Player

@Observable
final class LoopingPlayer {
    let player = AVQueuePlayer()
    private var looper: AVPlayerLooper?
    private var loaded: String?
    var paused = false
    var muted = false

    func load(_ name: String) {
        guard loaded != name else { return }
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        guard let url = Bundle.main.url(forResource: base, withExtension: ext.isEmpty ? "mp4" : ext) ?? DevTokAPI().mediaURL(name) else { return }
        looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        loaded = name
    }
    var currentSeconds: Double { let s = player.currentTime().seconds; return s.isFinite ? s : 0 }
    func restart() { player.seek(to: .zero); player.play(); paused = false }
    func pause() { player.pause(); paused = true }
    func togglePause() { paused ? (player.play(), paused = false) : (player.pause(), paused = true) }
    func toggleMute() { muted.toggle(); player.isMuted = muted }
}

struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    final class V: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var pl: AVPlayerLayer { layer as! AVPlayerLayer }
    }
    func makeUIView(context: Context) -> V {
        let v = V(); v.pl.player = player; v.pl.videoGravity = .resizeAspectFill; v.backgroundColor = .black; return v
    }
    func updateUIView(_ v: V, context: Context) { v.pl.player = player }
}

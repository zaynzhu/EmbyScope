import SwiftUI
import EmbyScopeCore

struct PlaybackView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var live = false
  @State private var applicationActive = NSApplication.shared.isActive
  let snapshot: PlaybackResponse
  private var shouldPoll: Bool {
    live && applicationActive && scenePhase == .active && app.page == .home && app.authenticated && !app.offline && !app.demo
  }
  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Label("正在观看", systemImage: "play.rectangle").font(.headline)
          Spacer()
          Toggle("实时查看", isOn: $live).toggleStyle(.switch).fixedSize()
            .disabled(app.offline || app.demo)
          Button(app.playbackLoading ? "读取中…" : "读取当前会话") { Task { await app.refreshPlayback() } }
            .disabled(app.offline || app.demo || app.playbackLoading)
        }
        Text(app.offline ? "离线预览，仅展示已有快照。" : live ? "前台每 10 秒读取当前账号会话；离开页面或切到后台即暂停，失败后退避。不扫描片库。" : "点击读取，或开启实时查看。支持服务端上报的各类播放器；与片库自动更新独立。")
          .font(.caption).foregroundStyle(Theme.secondary)
        ForEach(snapshot.servers, id: \.serverId) { source in
          let fresh = source.isFresh(at: context.date)
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(source.serverName).font(.subheadline.weight(.medium))
              Spacer()
              Text(source.checkedAt == nil ? "尚未读取" : "上次确认 \(displayDate(source.checkedAt))\(fresh ? "" : " · 当前状态未知")")
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            if let error = source.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
            if source.sessions.isEmpty {
              Text(!source.available ? "没有可用的会话数据" : fresh ? "本次未返回当前账号正在播放的条目" : "仅有旧快照，需重新读取后确认")
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            ForEach(source.sessions) { session in
              VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                  Text(!fresh || session.state == "unknown" ? "状态未确认" : session.state == "paused" ? "已暂停" : "播放中")
                    .font(.caption).foregroundStyle(Theme.accent).frame(width: 78, alignment: .leading)
                  Text(session.title).font(.subheadline).lineLimit(2)
                  Spacer()
                  Text([session.client, session.device].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                }
                if let progress = session.progress {
                  ProgressView(value: progress).tint(fresh ? Theme.accent : Theme.secondary)
                }
                HStack {
                  Text(fresh ? "服务端确认进度" : "上次确认进度 · 当前未知")
                  Spacer()
                  Text(session.progressLabel).monospacedDigit()
                }.font(.caption).foregroundStyle(Theme.secondary)
              }.padding(.vertical, 6)
            }
          }.padding(.vertical, 5)
        }
      }.padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in applicationActive = true }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in applicationActive = false }
    .task(id: "\(shouldPoll)-\(app.server)") {
      guard shouldPoll else { return }
      while !Task.isCancelled && shouldPoll {
        await app.refreshPlayback()
        do { try await Task.sleep(for: .seconds(10)) } catch { return }
      }
    }
  }
}

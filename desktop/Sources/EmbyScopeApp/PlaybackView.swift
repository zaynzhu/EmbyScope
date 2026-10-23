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
    TimelineView(.periodic(from: .now, by: 10)) { context in
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Label("正在观看", systemImage: "play.rectangle").font(.system(size: 20, weight: .semibold))
          Spacer()
          Toggle("实时查看", isOn: $live).toggleStyle(.switch).fixedSize()
            .disabled(app.offline || app.demo)
          Button(app.playbackLoading ? "读取中…" : "读取一次") { Task { await app.refreshPlayback() } }
            .disabled(app.offline || app.demo || app.playbackLoading || live)
        }
        Text(app.offline ? "离线预览，仅展示已有快照。" : live ? "前台每 10–15 秒读取；离开页面或切到后台即暂停，失败后退避。不扫描片库。" : "点击读取，或开启实时查看。与片库自动更新独立；兼容检测需要开启实时查看积累样本。")
          .font(.caption).foregroundStyle(Theme.secondary)
        ForEach(snapshot.servers, id: \.serverId) { source in
          let fresh = source.isFresh(at: context.date)
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(source.serverName).font(.subheadline.weight(.medium))
              Toggle("兼容检测", isOn: Binding(
                get: { app.playbackCompatibility.contains(source.serverId) },
                set: { if $0 { app.playbackCompatibility.insert(source.serverId) } else { app.playbackCompatibility.remove(source.serverId) } }
              )).toggleStyle(.checkbox).font(.caption)
                .accessibilityLabel("\(source.serverName)兼容检测")
                .disabled(app.offline || app.demo || app.playbackLoading)
                .help("仅当前打开有效。读取此账号最多 18 条续播记录，从连续变化检测活动；不代表精确播放状态。")
              Spacer()
              Text(source.checkedAt == nil ? "尚未读取" : "上次确认 \(displayDate(source.checkedAt))\(fresh ? "" : " · 当前状态未知")")
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            if let error = source.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
            if source.isCompatibility != app.playbackCompatibility.contains(source.serverId) {
              Text("检测方式已切换，等待下次读取；下方为上次结果。")
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            if source.isCompatibility && source.sessions.isEmpty {
              Text("兼容检测 · \(source.activityLabel(at: context.date))").font(.subheadline).foregroundStyle(Theme.accent)
            }
            if source.sessions.isEmpty && !source.isCompatibility {
              Text(!source.available ? "没有可用的会话数据" : fresh ? "本次未返回当前账号正在播放的条目" : "仅有旧快照，需重新读取后确认")
                .font(.caption).foregroundStyle(Theme.secondary)
            }
            ForEach(source.sessions) { session in
              playbackItem(session, source: source, now: context.date)
            }
            if source.isCompatibility {
              DisclosureGroup("兼容检测说明 · 活动线索不等于确定播放状态") {
                Text("只观察当前账号返回的最多 18 条记录，列表外可能漏检。通常需至少 30 秒识别，约 60 秒无更新后结束提示；暂停与退出不区分。数据变化仅在 VidHub 实测。")
                  .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 5)
              }.font(.caption).foregroundStyle(Theme.secondary).padding(.top, 6)
            }
          }.padding(.vertical, 5)
        }
      }.padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in applicationActive = true }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in applicationActive = false }
    .task(id: "\(shouldPoll)-\(app.server)-\(app.playbackCompatibility.sorted().joined(separator: ","))") {
      guard shouldPoll else { return }
      let observationId = UUID().uuidString
      while !Task.isCancelled && shouldPoll {
        await app.refreshPlayback(observationId: observationId)
        do { try await Task.sleep(for: .seconds(app.playbackCompatibility.isEmpty ? 10 : 15)) } catch { return }
      }
    }
  }
  private func playbackItem(_ session: PlaybackResponse.Session, source: PlaybackResponse.Source, now: Date) -> some View {
    let fresh = source.isFresh(at: now)
    let confirmed = fresh && session.state != "unknown"
    let activity = fresh && session.hasRecentActivity(at: now)
    let highlighted = source.isCompatibility ? activity : confirmed
    let status = source.isCompatibility ? (activity ? "检测到播放活动" : "上次活动 · 当前未知")
      : !confirmed ? "状态未确认" : session.state == "paused" ? "已暂停" : "播放中"
    let symbol = source.isCompatibility ? "waveform.path" : !confirmed ? "questionmark" : session.state == "paused" ? "pause.fill" : "play.fill"
    return HStack(alignment: .top, spacing: 16) {
      Image(systemName: "film")
        .font(.system(size: 25, weight: .light))
        .foregroundStyle(highlighted ? Theme.accent : Theme.secondary)
        .frame(width: 56, height: 72)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Label(status, systemImage: symbol)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(highlighted ? Theme.accent : Theme.secondary)
          Spacer()
          if source.isCompatibility {
            Text("兼容检测").font(.caption).foregroundStyle(Theme.secondary)
          }
        }
        Text(session.title)
          .font(.system(size: 23, weight: .semibold))
          .foregroundStyle(Theme.text).lineSpacing(3).lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled).help(session.title)
        if source.isCompatibility {
          Text("最近活动线索 \(displayDate(session.observedAt))")
            .font(.caption).foregroundStyle(Theme.secondary)
        } else {
          let device = [session.client, session.device].compactMap { $0 }.joined(separator: " · ")
          if !device.isEmpty { Text(device).font(.caption).foregroundStyle(Theme.secondary) }
          if let progress = session.progress {
            ProgressView(value: progress).tint(fresh ? Theme.accent : Theme.secondary)
          }
          HStack {
            Text(fresh ? "服务端确认进度" : "上次确认进度 · 当前未知")
            Spacer()
            Text(session.progressLabel).monospacedDigit()
          }.font(.caption).foregroundStyle(Theme.secondary)
        }
      }
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(highlighted ? Theme.accent.opacity(0.075) : Theme.background, in: RoundedRectangle(cornerRadius: 10))
    .overlay(alignment: .leading) {
      RoundedRectangle(cornerRadius: 2)
        .fill(highlighted ? Theme.accent : Theme.secondary.opacity(0.3))
        .frame(width: 3).padding(.vertical, 15)
    }
    .padding(.top, 8)
  }

}

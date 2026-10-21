import SwiftUI
import EmbyScopeCore

struct PlaybackView: View {
  @Environment(AppModel.self) private var app
  let snapshot: PlaybackResponse
  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      VStack(alignment: .leading, spacing: 12) {
        HStack {
          Label("播放会话", systemImage: "play.rectangle").font(.headline)
          Spacer()
          Button(app.playbackLoading ? "读取中…" : "读取当前会话") { Task { await app.refreshPlayback() } }
            .disabled(app.offline || app.demo || app.playbackLoading)
        }
        Text(app.offline ? "离线预览，仅展示已有快照。" : "手动读取当前账号；无后台轮询，不触发播放或片库扫描。")
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
              HStack(spacing: 12) {
                Text(!fresh || session.state == "unknown" ? "状态未确认" : session.state == "paused" ? "已暂停" : "播放中")
                  .font(.caption).foregroundStyle(Theme.accent).frame(width: 78, alignment: .leading)
                Text(session.title).font(.subheadline).lineLimit(1)
                Spacer()
                Text([session.client, session.device].compactMap { $0 }.joined(separator: " · "))
                  .font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                if let position = session.positionTicks {
                  Text("确认进度 \(Int(position / 600000000)) 分钟").font(.caption).foregroundStyle(Theme.secondary)
                }
              }
            }
          }.padding(.vertical, 5)
        }
      }.padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
  }
}

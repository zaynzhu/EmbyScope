import SwiftUI
import EmbyScopeCore

struct TraktView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.openURL) private var openURL
  @State private var applicationActive = NSApplication.shared.isActive
  @State private var showConfiguration = false
  @State private var clientId = ""
  @State private var confirmDisconnect = false
  private var visible: Bool { applicationActive && scenePhase == .active && app.page == .trakt && app.authenticated }
  private var disabled: Bool { app.demo || app.offline || app.trakt.saving }

  var body: some View {
    @Bindable var model = app.trakt
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        SectionTitle(title: "Trakt 观看", subtitle: "来自 Trakt 的观看记录 · 不需要打开 Mac 上的 Infuse")
        Spacer()
        if model.status?.busy == true {
          ProgressView().controlSize(.small)
          Text(model.status?.state == "authorizing" ? "等待授权" : "正在同步").font(.caption)
          Button("停止") { act("cancel") }.disabled(disabled)
        } else if model.status?.connected == true {
          Button("同步 Trakt") { act("sync") }.buttonStyle(GoldButton()).disabled(disabled)
        } else {
          Button("连接 Trakt") { act("connect") }.buttonStyle(GoldButton()).disabled(disabled || model.status?.configured != true)
        }
        Menu {
          Button("配置应用 Client ID") { clientId = ""; showConfiguration = true }
          if model.status?.connected == true { Button("重新授权") { act("connect") }.disabled(model.status?.busy == true) }
          Button("断开并清除本机 Trakt 缓存", role: .destructive) { confirmDisconnect = true }
        } label: { Image(systemName: "gearshape") }.disabled(disabled).accessibilityLabel("Trakt 连接设置")
      }
      if let status = model.status {
        HStack {
          Label(status.account.map { "Trakt · \($0)" } ?? "尚未连接", systemImage: status.connected ? "checkmark.circle" : "person.crop.circle")
          if let time = status.updatedAt { Text("缓存更新：\(formatted(time))") }
          Spacer()
          Text("已看 \(status.counts.watched) · 续播 \(status.counts.playback)")
        }.font(.caption).foregroundStyle(Theme.secondary)
        if !status.configured {
          HStack { Text("首次使用需要配置你注册的 Trakt 应用 Client ID。"); Button("配置应用") { showConfiguration = true } }
            .font(.callout).disabled(disabled)
        }
        if let device = status.device {
          VStack(alignment: .leading, spacing: 10) {
            Text("在 Trakt 授权映览使用的应用").font(.headline)
            HStack(spacing: 18) {
              Text(device.userCode).font(.title2.monospaced()).textSelection(.enabled)
              Button("复制授权码") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(device.userCode, forType: .string) }
              Button("打开 Trakt 授权页面") { if let url = URL(string: device.verificationUrl) { openURL(url) } }
            }
            Text("有效至 \(formatted(device.expiresAt))。复用 PixelReel 的 Client ID 时，授权页会显示原应用名称。")
              .font(.caption).foregroundStyle(Theme.secondary)
          }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
        if let error = status.error { Text(error).font(.callout).foregroundStyle(Theme.accent) }
      }
      if let error = model.statusError {
        HStack { Text(error); Button("重试状态") { model.retryStatus() } }.font(.callout).foregroundStyle(Theme.accent)
      }
      HStack(spacing: 16) {
        Picker("记录范围", selection: $model.kind) {
          Text("最近已看").tag("recent"); Text("全部已看").tag("watched"); Text("继续观看").tag("playback")
        }.pickerStyle(.segmented).frame(maxWidth: 390)
        TextField("搜索影片或剧集", text: $model.query).textFieldStyle(.roundedBorder).frame(maxWidth: 280)
        Picker("类型", selection: $model.type) { Text("全部").tag(""); Text("电影").tag("movie"); Text("单集").tag("episode") }.frame(width: 130)
      }
      Text(model.kind == "recent" ? "最近一页已看事件，重复观看按作品保留最新一次。未看完的内容在“继续观看”中。" : model.kind == "watched" ? "完整同步成功后的已看电影与单集；看过一集不代表整部剧看完。" : "最近上报的进度快照，不代表正在播放；重新观看的内容可能同时存在于已看记录中。")
        .font(.caption).foregroundStyle(Theme.secondary)
      if let error = model.error { HStack { Text(error); Button("重试列表") { Task { if let client = app.client { await model.load(client, page: model.retryPage) } } } }.font(.callout).foregroundStyle(Theme.accent) }
      ScrollView {
        if let result = model.result {
          if result.items.isEmpty {
            EmptyState(title: result.available ? "没有匹配的记录" : "尚未同步 Trakt", message: result.available ? "试试其他筛选；空列表不代表账号从未观看。" : "连接后同步记录。Infuse 需要开启 Scrobbling，映览才能读到已经上传的内容。")
          } else {
            LazyVStack(spacing: 0) {
              ForEach(result.items) { item in
                HStack(alignment: .center, spacing: 16) {
                  Image(systemName: item.type == "movie" ? "film" : "tv").font(.title2).foregroundStyle(Theme.accent).frame(width: 42)
                  VStack(alignment: .leading, spacing: 6) {
                    Text(item.displayTitle).font(.headline)
                    Text(item.subtitle).font(.caption).foregroundStyle(Theme.secondary)
                    if let time = item.pausedAt ?? item.watchedAt {
                      Text("\(item.pausedAt == nil ? "已看时间" : "进度更新")：\(formatted(time))").font(.caption).foregroundStyle(Theme.secondary)
                    }
                  }.frame(maxWidth: .infinity, alignment: .leading)
                  if let progress = item.progress {
                    VStack(alignment: .trailing, spacing: 8) {
                      Text("\(progress, specifier: "%.1f")%").font(.callout.monospacedDigit())
                      ProgressView(value: progress, total: 100).frame(width: 150)
                    }
                  } else {
                    Label(item.plays.map { "已看 · \($0) 次" } ?? "已看", systemImage: "checkmark.circle").font(.caption).foregroundStyle(Theme.secondary)
                  }
                }.padding(.vertical, 18)
                Divider()
              }
            }
          }
        } else if model.loading { ProgressView("正在读取本机记录…").frame(maxWidth: .infinity, minHeight: 180) }
      }
      HStack {
        Text("\(model.result?.total ?? 0) 条匹配记录 · 账号可能包含其他播放器的同步记录").font(.caption).foregroundStyle(Theme.secondary)
        Spacer()
        if model.loading { ProgressView().controlSize(.small) }
        Button("上一页") { loadPage((model.result?.page ?? 1) - 1) }.disabled(model.loading || (model.result?.page ?? 1) <= 1)
        Text("\(model.result?.page ?? 1) / \(model.result?.pages ?? 1)").font(.caption.monospacedDigit())
        Button("下一页") { loadPage((model.result?.page ?? 1) + 1) }.disabled(model.loading || model.result == nil || (model.result?.page ?? 1) >= (model.result?.pages ?? 1))
      }
    }.padding(28)
      .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in applicationActive = true }
      .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in applicationActive = false }
      .task(id: "\(visible)-\(model.pollRevision)") {
        guard visible, let client = app.client else { return }
        repeat {
          await model.loadStatus(client)
          guard model.statusError == nil, model.status?.busy == true else { return }
          do { try await Task.sleep(for: .seconds(2)) } catch { return }
        } while !Task.isCancelled
      }
      .task(id: [String(visible), model.kind, model.query, model.type, String(model.listRevision)]) {
        guard visible, let client = app.client else { return }
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        await model.refreshList(client)
      }
      .sheet(isPresented: $showConfiguration) {
        VStack(alignment: .leading, spacing: 18) {
          Text("Trakt 应用配置").font(.title3.weight(.semibold))
          Text("填写自己的应用 Client ID，无需 Client Secret。更换应用会断开现有授权并清除本机 Trakt 缓存。").font(.callout)
          TextField("Client ID", text: $clientId).textFieldStyle(.roundedBorder)
          HStack { Spacer(); Button("取消") { showConfiguration = false }; Button("保存应用配置") {
            Task {
              if let client = app.client { await model.action(client, path: "api/trakt/settings", method: "PUT", fields: ["clientId": clientId.trimmingCharacters(in: .whitespacesAndNewlines)]) }
              if model.statusError == nil { showConfiguration = false; clientId = "" }
            }
          }.disabled(clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.saving) }
          if let error = model.statusError { Text(error).font(.caption).foregroundStyle(Theme.accent) }
        }.padding(28).frame(width: 520)
      }
      .alert("断开 Trakt？", isPresented: $confirmDisconnect) {
        Button("取消", role: .cancel) {}
        Button("断开并清除本机缓存", role: .destructive) { act("disconnect") }
      } message: { Text("仅清除映览保存的授权与 Trakt 缓存，保留应用 Client ID；不会删除 Trakt 网站的记录或修改 PixelReel。远端应用授权可在 Trakt 设置中管理。") }
  }
  private func act(_ action: String) { Task { if let client = app.client { await app.trakt.action(client, path: "api/trakt/\(action)") } } }
  private func loadPage(_ page: Int) { Task { if let client = app.client { await app.trakt.load(client, page: page) } } }
  private func formatted(_ text: String) -> String {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let parsed = parser.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    return parsed?.formatted(date: .abbreviated, time: .shortened) ?? text
  }
}

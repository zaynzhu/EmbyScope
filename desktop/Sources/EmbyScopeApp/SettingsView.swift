import SwiftUI
import EmbyScopeCore

struct SettingsView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var editing: ServerEditorTarget?
  @State private var deleting: Server?
  @State private var confirmFull = false
  @State private var confirmOnline = false
  @State private var proxyTarget: Server?
  @State private var showPasswordSetup = false
  @State private var savingPasswordSetting = false
  @State private var passwordSettingError: String?
  private var shouldReadStatus: Bool { scenePhase == .active && app.page == .settings && app.authenticated }
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 26) {
        SectionTitle(title: "服务器与更新", subtitle: "凭据加密存于本机，远端媒体库只读。")
        if app.demo { Text("当前为隔离演示模式。退出后正常打开应用，才能配置你的服务器。").font(.callout).foregroundStyle(Theme.accent) }
        VStack(alignment: .leading, spacing: 16) {
          if app.offline {
            Label("当前处于离线预览", systemImage: "wifi.slash").font(.headline).foregroundStyle(Theme.accent)
            Text("自动更新开关因此不可用。退出离线预览后可以手动更新，自动更新仍保持关闭。").font(.caption).foregroundStyle(Theme.secondary)
            if app.canExitOffline {
              Button(app.exitingOffline ? "正在退出…" : "退出离线预览…") { confirmOnline = true }.disabled(app.demo || app.exitingOffline)
            } else {
              Text("当前运行模式强制离线，不能在此解除。").font(.caption).foregroundStyle(Theme.secondary)
            }
          } else {
            Label("正常模式 · 允许按需联网", systemImage: "network").font(.headline)
          }
          Toggle("自动更新", isOn: Binding(get: { app.automaticUpdates }, set: { enabled in Task { await app.setAutomaticUpdates(enabled) } })).toggleStyle(.switch).disabled(app.demo || app.offline)
          Text(app.offline ? "离线预览中，更新与连接修改已禁用；详情和海报仅从本机缓存读取。" : app.automaticUpdates ? "按各服务器周期更新，窗口失焦不会触发额外刷新。" : "已暂停。打开应用、切页和切换服务器只读取缓存；详情与海报可能按需请求。")
            .font(.caption).foregroundStyle(Theme.secondary)
          HStack {
            Button("轻量更新当前范围") { Task { await app.refresh(full: false) } }.disabled(app.demo || app.offline)
            Button("完整校准当前范围…") { confirmFull = true }.disabled(app.demo || app.offline)
            Button("重新读取本地状态") { Task { await app.loadScope() } }
          }
          Text("轻量更新读取媒体库、最近入库和继续观看；完整校准会分页读取片库。所有远端请求限速，同服务间隔至少两秒。").font(.caption).foregroundStyle(Theme.secondary)
        }.padding(22).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        HStack { Text("已连接的服务器").font(.title3.weight(.semibold)); Spacer(); Button("添加服务器") { editing = ServerEditorTarget(server: nil) }.buttonStyle(GoldButton()).disabled(app.demo || app.offline) }
        Text("本页在前台时每 5 秒读取本地更新状态，不触发服务器同步。连接结果来自最近一次更新，不代表实时在线检测。")
          .font(.caption).foregroundStyle(Theme.secondary)
        if let error = app.serverStatusError { Text(error).font(.caption).foregroundStyle(Theme.accent) }
        ForEach(app.servers) { server in
          VStack(alignment: .leading, spacing: 12) {
            HStack {
              Image(systemName: "externaldrive").foregroundStyle(Theme.accent)
              Text(server.name).font(.headline)
              if server.nsfw { Text("NSFW").font(.caption.monospaced()).foregroundStyle(Theme.accent) }
              Spacer()
              Text(server.syncing ? "正在读取服务器数据" : "上次连接：\(server.statusLabel)").font(.caption).foregroundStyle(Theme.secondary)
              Button("关联反代") { proxyTarget = server }
              Button("编辑") { editing = ServerEditorTarget(server: server) }.disabled(app.demo || app.offline)
              Button("删除") { deleting = server }.disabled(app.demo || app.offline)
            }
            ServerUpdateDetails(server: server, automaticUpdates: app.automaticUpdates, offline: app.offline)
          }.padding(22).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        }
        if app.servers.isEmpty { EmptyState(title: "添加你的第一台服务器", message: "填写服务器地址与普通 Emby 账号即可，不需要管理员 API Key。") }
        Toggle("减少界面动效", isOn: Binding(get: { app.reduceMotion }, set: { app.reduceMotion = $0 })).toggleStyle(.switch)
        VStack(alignment: .leading, spacing: 12) {
          Toggle("打开映览时需要密码", isOn: Binding(get: { app.passwordRequired }, set: { enabled in
            if enabled { showPasswordSetup = true }
            else {
              savingPasswordSetting = true
              Task {
                do { try await app.setPasswordRequired(false); passwordSettingError = nil }
                catch { passwordSettingError = error.localizedDescription }
                savingPasswordSetting = false
              }
            }
          })).toggleStyle(.switch).disabled(app.demo || savingPasswordSetting)
          Text(app.passwordRequired ? "已开启。下次打开或手动锁定后，需要本机密码解锁。" : "默认关闭，打开后直接进入首页。开启时可设置密码；已有密码会保留。")
            .font(.caption).foregroundStyle(Theme.secondary)
          if app.passwordRequired { Button("锁定映览") { Task { await app.lock() } }.disabled(app.demo || savingPasswordSetting) }
          if let passwordSettingError { Text(passwordSettingError).font(.caption).foregroundStyle(Theme.accent) }
        }.padding(22).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        Text("当前界面不播放视频、不代理流媒体、不修改远端文件。最近观看仅来自账号最后播放时间，尚未接入完整历史。").font(.caption).foregroundStyle(Theme.secondary)
      }.padding(30).frame(maxWidth: 1050).frame(maxWidth: .infinity)
    }
    .task(id: shouldReadStatus) {
      guard shouldReadStatus else { return }
      while !Task.isCancelled && shouldReadStatus {
        await app.loadServerStatus()
        do { try await Task.sleep(for: .seconds(5)) } catch { return }
      }
    }
    .sheet(isPresented: $showPasswordSetup) { PasswordLockEditor() }
    .sheet(item: $proxyTarget) { ProxyEditor(server: $0) }
    .alert("退出离线预览？", isPresented: $confirmOnline) {
      Button("取消", role: .cancel) {}
      Button("退出，保持自动更新关闭") { Task { await app.exitOffline() } }
    } message: { Text("退出操作本身不更新片库。之后手动更新、详情和海报可能访问已配置的服务器；自动更新仍关闭，不会立即扫库。") }
    .sheet(item: $editing) { ServerEditor(server: $0.server) }
    .alert("删除这个连接？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
      Button("取消", role: .cancel) { deleting = nil }
      Button("删除本地连接", role: .destructive) { if let target = deleting { Task { await app.deleteServer(target) } }; deleting = nil }
    } message: { Text("仅删除映览中的连接与缓存，不会删除远端媒体。") }
    .alert("完整校准片库？", isPresented: $confirmFull) {
      Button("取消", role: .cancel) {}
      Button("开始校准") { Task { await app.refresh(full: true) } }
    } message: { Text("将按限速分页读取当前范围的远端片库，较大媒体库可能耗时较长。") }
  }
}

private struct ServerUpdateDetails: View {
  let server: Server
  let automaticUpdates: Bool
  let offline: Bool
  private let datasets = [("catalog", "完整片库"), ("views", "媒体库列表"), ("latest", "最近入库"), ("resume", "继续观看")]
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
        info("原服务地址", server.url)
        info("关联反代", server.proxyUrl ?? "未配置")
        info("自动更新", offline ? "离线预览，已暂停" : automaticUpdates ? "已开启" : "已暂停")
        info("轻量更新周期", "每 \(server.lightMinutes) 分钟")
        info("完整校准周期", server.fullHours == 0 ? "仅手动" : "每 \(server.fullHours) 小时")
        info("最近尝试读取", server.attemptedAt == nil ? "尚未尝试" : displayDate(server.attemptedAt))
      }.font(.callout).textSelection(.enabled)
      if let error = server.error {
        Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(Theme.accent).textSelection(.enabled)
      }
      if let progress = server.catalogProgress, server.syncing {
        Text("片库读取中 · 已访问 \(progress.directories) 个目录 · 已发现 \(progress.discovered) 个目录 · 已收集 \(progress.items) 条媒体")
          .font(.caption).foregroundStyle(Theme.accent)
      }
      Divider()
      Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
        GridRow {
          Text("数据类型")
          Text("最后成功读取")
          Text("数据状态")
        }.foregroundStyle(Theme.secondary)
        ForEach(datasets, id: \.0) { kind, title in
          let dataset = server.datasets[kind]
          GridRow {
            Text(title)
            Text(dataset?.updatedAt.flatMap { $0.isEmpty ? nil : $0 }.map { displayDate($0) } ?? "暂无成功记录")
              .monospacedDigit()
            Text(dataset?.available != true ? "暂无数据" : dataset?.error != nil ? "保留旧数据" : dataset?.stale == true ? "待更新" : "已读取")
              .foregroundStyle(dataset?.error != nil ? Theme.accent : Theme.secondary)
          }
          if let message = dataset?.error ?? dataset?.warning {
            GridRow { Text("\(title)：\(message)").foregroundStyle(Theme.accent).gridCellColumns(3) }
          }
        }
      }.font(.caption).textSelection(.enabled)
      if let episodes = server.episodeSync {
        Text("季集信息\(episodes.syncing ? "补齐中" : "") · 已缓存 \(episodes.completed) / \(episodes.series) 部剧 · 已知 \(episodes.knownEpisodes) 集\(episodes.failed > 0 ? " · \(episodes.failed) 部读取失败" : "")\(episodes.stale ? " · 待更新" : "")")
          .font(.caption).foregroundStyle(Theme.secondary)
      }
      Text("尝试时间不代表成功；轻量更新不重读完整片库。以上为最新状态，不保留历次执行记录。")
        .font(.caption).foregroundStyle(Theme.secondary)
    }
  }
  private func info(_ label: String, _ value: String) -> some View {
    GridRow {
      Text(label).foregroundStyle(Theme.secondary)
      Text(value).frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

// 弹窗与目标共用同一状态，避免首次展示时捕获上一轮的服务器。
private struct ServerEditorTarget: Identifiable {
  let id = UUID()
  let server: Server?
}

private struct ServerEditor: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let server: Server?
  @State private var name = ""
  @State private var address = ""
  @State private var username = ""
  @State private var password = ""
  @State private var nsfw = false
  @State private var minutes = 60
  @State private var hours = 24
  @State private var saving = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      Text(server == nil ? "添加服务器" : "编辑服务器").font(.title2.bold())
      Form {
        TextField("连接名称", text: $name)
        TextField("服务器地址", text: $address, prompt: Text("http://服务器:端口"))
        TextField("Emby 用户名", text: $username, prompt: Text(server == nil ? "用户名" : "留空保留原账号"))
        SecureField("Emby 密码", text: $password, prompt: Text(server == nil ? "密码" : "留空保留原密码"))
        Toggle("NSFW · 默认遮挡海报", isOn: $nsfw)
        Stepper("轻量更新：\(minutes) 分钟", value: $minutes, in: 15...1440, step: 15)
        Picker("完整校准", selection: $hours) {
          Text("关闭").tag(0)
          ForEach([12, 24, 48, 168], id: \.self) { Text("每 \($0) 小时").tag($0) }
        }
      }
      Text("新增连接或修改登录信息会登录并首次读取片库；只调整名称、标签或周期不会主动扫描。").font(.caption).foregroundStyle(Theme.secondary)
      if let error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      HStack {
        Spacer()
        Button("取消") { dismiss() }.disabled(saving)
        Button(saving ? "保存中…" : "保存连接") {
          saving = true
          Task {
            do {
              try await app.saveServer(id: server?.id, fields: ["name": name, "url": address, "username": username, "password": password, "nsfw": nsfw, "lightMinutes": minutes, "fullHours": hours])
              password = ""; dismiss()
            } catch { self.error = error.localizedDescription }
            saving = false
          }
        }.buttonStyle(GoldButton()).disabled(saving || name.isEmpty || address.isEmpty)
      }
    }.padding(30).frame(width: 510).background(Theme.background)
    .onAppear { if let server { name = server.name; address = server.url; nsfw = server.nsfw; minutes = server.lightMinutes; hours = server.fullHours } }
  }
}


private struct ProxyEditor: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let server: Server
  @State private var address = ""
  @State private var saving = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("关联反代 · \(server.name)").font(.title2.bold())
      Text("原服务：\(server.url)").font(.caption).foregroundStyle(Theme.secondary)
      TextField("反代完整地址", text: $address, prompt: Text("http://代理主机:端口"))
      Text("这是当前服务器的附属地址，共用片库与统计。留空移除关联；保存不会访问该地址或修改 TTD 配置。").font(.caption).foregroundStyle(Theme.secondary)
      Text("仅保存地址不会取得 TTD 日志。日志还需要管理入口授权与可靠的规则匹配，当前尚未接入。").font(.caption).foregroundStyle(Theme.secondary)
      if let error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      HStack {
        Spacer()
        Button("取消") { dismiss() }.disabled(saving)
        Button("保存关联") {
          saving = true
          Task {
            do { try await app.saveProxy(server, url: address); dismiss() }
            catch { self.error = error.localizedDescription }
            saving = false
          }
        }.buttonStyle(GoldButton()).disabled(saving)
      }
    }.padding(30).frame(width: 510).background(Theme.background)
      .onAppear { address = server.proxyUrl ?? "" }
  }
}

private struct PasswordLockEditor: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var password = ""
  @State private var confirmation = ""
  @State private var saving = false
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("开启启动密码").font(.title2.bold())
      Text(app.initialized ? "请输入原本的本机密码，确认后开启。它不是 Emby 账号密码。" : "设置本机密码，之后打开映览时用它解锁。")
        .font(.callout).foregroundStyle(Theme.secondary)
      SecureField(app.initialized ? "原本的本机密码" : "密码（12 至 256 个字符）", text: $password)
      if !app.initialized { SecureField("再次输入密码", text: $confirmation) }
      if let error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      HStack {
        Spacer()
        Button("取消") { dismiss() }.disabled(saving)
        Button(saving ? "正在开启…" : "确认开启") {
          saving = true
          Task {
            do { try await app.setPasswordRequired(true, password: password); password = ""; confirmation = ""; dismiss() }
            catch { self.error = error.localizedDescription }
            saving = false
          }
        }.buttonStyle(GoldButton()).disabled(saving || password.count < 12 || password.count > 256 || (!app.initialized && password != confirmation))
      }
    }.padding(30).frame(width: 450).background(Theme.background)
      .interactiveDismissDisabled(saving)
  }
}

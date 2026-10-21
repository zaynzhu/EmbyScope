import SwiftUI
import AppKit
import EmbyScopeCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  var model: AppModel?
  private var exiting = false
  func applicationDidFinishLaunching(_ notification: Notification) {
    if let identifier = Bundle.main.bundleIdentifier,
       let existing = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
      existing.activate(options: [.activateAllWindows])
      NSApp.terminate(nil)
      return
    }
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if exiting { return .terminateLater }
    exiting = true
    Task { await model?.backend.stop(); sender.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }
}

@main
struct EmbyScopeApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = AppModel()
  var body: some Scene {
    Window("映览 · EmbyScope", id: "main") {
      RootView().environment(model).frame(minWidth: 1000, minHeight: 700)
        .preferredColorScheme(.light).tint(Theme.accent)
        .task { delegate.model = model; await model.start() }
    }.defaultSize(width: 1220, height: 860)
      .commands {
        CommandGroup(replacing: .newItem) {}
        CommandMenu("导航") {
          ForEach(Array(Page.allCases.enumerated()), id: \.element) { index, page in
            Button(page.rawValue) { model.navigate(to: page) }.keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
          }
          Divider()
          Button("刷新本地快照") { Task { await model.loadScope() } }
            .keyboardShortcut("r", modifiers: .command).disabled(!model.authenticated || model.loading)
        }
      }
  }
}

private struct RootView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @State private var password = ""
  var body: some View {
    @Bindable var app = app
    VStack(spacing: 0) {
      if app.starting {
        ProgressView("正在打开你的观影空间…").frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if !app.authenticated {
        VStack(alignment: .leading, spacing: 22) {
          Image(systemName: "viewfinder").font(.system(size: 40, weight: .light)).foregroundStyle(Theme.accent)
          Text("映览").font(.system(size: 38, weight: .bold))
          Text(app.initialized ? "欢迎回来" : "设置本机管理员密码").font(.title3)
          Text("连接配置与观看信息保存在你的 Mac。").font(.callout).foregroundStyle(Theme.secondary)
          SecureField("至少 12 个字符", text: $password).textFieldStyle(.roundedBorder)
            .onSubmit { Task { await app.login(password: password); password = "" } }
          Button(app.loading ? "正在验证…" : app.initialized ? "解锁映览" : "开始使用") { Task { await app.login(password: password); password = "" } }
            .buttonStyle(GoldButton()).disabled(app.client == nil || password.count < 12 || app.loading)
          if let error = app.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
        }.frame(width: 340).frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        header
        Rectangle().fill(Theme.line).frame(height: 1)
        if let error = app.error {
          HStack { Image(systemName: "exclamationmark.circle"); Text(error).font(.caption); Spacer(); Button("关闭提示") { app.error = nil } }
            .foregroundStyle(Theme.accent).padding(12).background(Theme.surface)
        }
        HStack(spacing: 0) {
          Group {
            switch app.page {
            case .home: HomeView()
            case .overview: OverviewView()
            case .library, .duplicates: LibraryView()
            case .settings: SettingsView()
            }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
          if let selected = app.selected {
            Rectangle().fill(Theme.line).frame(width: 1)
            DetailView(selected: selected).transition(.move(edge: .trailing).combined(with: .opacity))
          }
        }
        .animation(app.animation, value: app.selected?.key)
      }
    }.background(Theme.background).foregroundStyle(Theme.text)
      .onChange(of: systemReduceMotion, initial: true) { _, value in if value { app.reduceMotion = true } }
  }
  private var header: some View {
    @Bindable var app = app
    return HStack(spacing: 24) {
      HStack(spacing: 9) {
        Image(systemName: "viewfinder").font(.system(size: 21, weight: .medium)).foregroundStyle(Theme.accent)
        VStack(alignment: .leading, spacing: 1) {
          Text("映览").font(.system(size: 16, weight: .bold))
          Text("EmbyScope").font(.system(size: 9, weight: .medium)).tracking(1).foregroundStyle(Theme.secondary)
        }
      }.padding(.trailing, 8)
      HStack(spacing: 22) {
        ForEach(Page.allCases, id: \.self) { page in
          Button {
            withAnimation(app.animation) {
              app.navigate(to: page)
            }
          } label: {
            VStack(spacing: 8) {
              Text(page.rawValue).font(.system(size: 12, weight: app.page == page ? .semibold : .regular))
                .foregroundStyle(app.page == page ? Theme.text : Theme.secondary)
              Capsule().fill(app.page == page ? Theme.accent : .clear).frame(width: 18, height: 2)
            }.padding(.top, 10)
          }.buttonStyle(.plain)
        }
      }
      Spacer(minLength: 8)
      if app.loading { ProgressView().controlSize(.small) }
      Button { Task { await app.loadScope() } } label: { Image(systemName: "arrow.clockwise") }
        .buttonStyle(.plain).disabled(app.loading)
        .help("刷新本地快照，不触发远端同步（⌘R）").accessibilityLabel("刷新本地快照")
      Button {
        withAnimation(app.animation) { app.revealAll.toggle(); app.revealed = [] }
      } label: { Image(systemName: app.revealAll ? "eye" : "eye.slash") }.buttonStyle(.plain)
        .help(app.revealAll ? "重新遮挡所有 NSFW 海报" : "本次会话显示全部 NSFW 海报")
        .accessibilityLabel(app.revealAll ? "重新遮挡海报" : "显示全部海报")
      Picker("服务器", selection: $app.server) {
        Text("全部服务器").tag("all")
        ForEach(app.servers) { server in Text(server.name).tag(server.id) }
      }.labelsHidden().frame(width: 166)
        .onChange(of: app.server) { _, _ in Task { await app.switchServer() } }
    }.padding(.horizontal, 26).frame(height: 65)
  }
}

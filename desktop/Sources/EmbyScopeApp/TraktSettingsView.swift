import SwiftUI
import EmbyScopeCore

struct TraktSettingsView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var clientId = ""
  @State private var tmdbToken = ""
  @State private var showApplication = false
  @State private var showPosters = false
  @State private var confirmDisconnect = false
  @State private var savedMessage: String?
  private var disabled: Bool { app.demo || app.offline || app.trakt.saving || app.trakt.status?.busy == true }

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack {
        Text("Trakt 账号与配置").font(.title2.weight(.semibold))
        Spacer()
        Button("完成") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          VStack(alignment: .leading, spacing: 12) {
            Text("当前连接账号").font(.caption).foregroundStyle(Theme.secondary)
            HStack {
              Label(app.trakt.status?.account ?? "尚未连接", systemImage: "person.crop.circle")
                .font(.title3.weight(.semibold)).textSelection(.enabled)
              Spacer()
              Text(app.trakt.status?.connected == true ? "已授权" : "未授权或授权已失效")
                .font(.caption).foregroundStyle(Theme.accent)
            }
            Text("最近同步：\(displayDate(app.trakt.status?.updatedAt))")
              .font(.caption).foregroundStyle(Theme.secondary)
            HStack {
              Button(app.trakt.status?.connected == true ? "重新授权／切换账号" : "连接 Trakt 账号") {
                Task {
                  if let client = app.client { await app.trakt.action(client, path: "api/trakt/connect") }
                  if app.trakt.statusError == nil { dismiss() }
                }
              }.buttonStyle(GoldButton()).disabled(disabled || app.trakt.status?.configured != true)
              if app.trakt.status?.account != nil {
                Button("断开账号", role: .destructive) { confirmDisconnect = true }.disabled(disabled)
              }
            }
          }.padding(18).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))

          VStack(alignment: .leading, spacing: 8) {
            Text("数据从哪里来").font(.headline)
            Text("Infuse → Trakt → 映览").font(.callout.weight(.medium)).foregroundStyle(Theme.accent)
            Text("Infuse 将观看记录上传到 Trakt，映览读取上方账号的最近观看、已看状态和续播进度。账号中也可能包含其他播放器的记录，不需要打开 Mac 上的 Infuse。")
              .font(.callout).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            Text("切换账号时，请先在浏览器登录与 Infuse 相同的 Trakt 账号，再授权映览。")
              .font(.caption).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
          }
          Divider()
          DisclosureGroup(isExpanded: $showApplication) {
            VStack(alignment: .leading, spacing: 12) {
              Text(app.trakt.status?.configured == true ? "已保存 Trakt 应用 Client ID，无需重复填写。" : "首次连接需要填写自己的 Trakt 应用 Client ID。")
              TextField("Client ID", text: $clientId).textFieldStyle(.roundedBorder)
              Text("无需 Client Secret。更换应用会断开当前账号并清除本机 Trakt 记录和图片缓存。")
                .font(.caption).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
              Button("保存应用配置") {
                Task {
                  if let client = app.client {
                    await app.trakt.action(client, path: "api/trakt/settings", method: "PUT", fields: ["clientId": clientId.trimmingCharacters(in: .whitespacesAndNewlines)])
                  }
                  if app.trakt.statusError == nil { clientId = ""; savedMessage = "应用配置已保存" }
                }
              }.disabled(disabled || clientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.font(.callout).padding(.top, 12)
          } label: { Text("应用配置 · \(app.trakt.status?.configured == true ? "已配置" : "待配置")").font(.headline) }
          Divider()
          DisclosureGroup(isExpanded: $showPosters) {
            VStack(alignment: .leading, spacing: 12) {
              Text("海报按作品 ID 获取并缓存到本机；图片来源与观看账号分别配置。")
              SecureField("TMDB API 读取令牌或 API Key", text: $tmdbToken).textFieldStyle(.roundedBorder)
              Text("保存后重新载入海报，不影响观看记录或 Trakt 授权。")
                .font(.caption).foregroundStyle(Theme.secondary)
              HStack {
                Button("保存海报配置") { savePosters(tmdbToken) }
                  .disabled(disabled || tmdbToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if app.trakt.status?.posterConfigured == true {
                  Button("改用 Trakt 图片") { savePosters("") }.disabled(disabled)
                }
              }
            }.font(.callout).padding(.top, 12)
          } label: { Text("海报来源 · \(app.trakt.status?.posterConfigured == true ? "TMDB" : "Trakt")").font(.headline) }
          if let message = savedMessage { Text(message).font(.caption).foregroundStyle(Theme.accent) }
          if let error = app.trakt.statusError ?? app.trakt.status?.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
          Text("授权凭据加密保存在本机；映览只读取观看记录，不写回 Trakt。")
            .font(.caption).foregroundStyle(Theme.secondary)
        }.padding(.trailing, 4)
      }
    }.padding(28).frame(width: 560, height: 610)
      .onAppear { showApplication = app.trakt.status?.configured != true }
      .alert("断开 Trakt 账号？", isPresented: $confirmDisconnect) {
        Button("取消", role: .cancel) {}
        Button("断开并清除本机缓存", role: .destructive) {
          Task {
            if let client = app.client { await app.trakt.action(client, path: "api/trakt/disconnect") }
            if app.trakt.statusError == nil { savedMessage = "已断开账号，应用和海报配置已保留" }
          }
        }
      } message: { Text("清除映览中的 Trakt 授权与观看、图片缓存，保留应用和海报配置。不会删除 Trakt 网站上的记录。") }
  }
  private func savePosters(_ token: String) {
    Task {
      if let client = app.client {
        await app.trakt.action(client, path: "api/trakt/poster-settings", method: "PUT", fields: ["tmdbToken": token.trimmingCharacters(in: .whitespacesAndNewlines)])
      }
      if app.trakt.statusError == nil {
        PosterCache.shared.clear(); app.trakt.imagesRevision += 1
        tmdbToken = ""; savedMessage = "海报配置已保存"
      }
    }
  }
}

import SwiftUI
import EmbyScopeCore

struct DoubanSettingsView: View {
  @Environment(AppModel.self) private var app
  @State private var account = ""
  @State private var confirmFull = false
  private var disabled: Bool { app.offline || app.demo || app.douban.saving || app.douban.status?.syncing == true || app.douban.status == nil }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("豆瓣已看同步").font(.title3.weight(.semibold))
        Spacer()
        Button("查看已看记录") { app.navigate(to: .douban) }
      }
      Text("数据独立保存在映览，由你手动选择同步；无需启动 PixelReel，也不受服务器自动更新周期控制。")
        .font(.caption).foregroundStyle(Theme.secondary)
      if let status = app.douban.status {
        HStack {
          TextField("豆瓣个人主页的账号标识", text: $account).textFieldStyle(.roundedBorder).frame(maxWidth: 300)
            .disabled(disabled || status.total > 0)
          if status.total == 0 {
            Button("保存账号") { Task { if let client = app.client { await app.douban.action(client, path: "api/douban/settings", method: "PUT", fields: ["account": account.trimmingCharacters(in: .whitespacesAndNewlines)]) } } }.disabled(disabled || account.isEmpty)
          }
        }
        Text("已看 \(status.total) 条 · 电影 \(status.movies) · 剧集 \(status.series)\(status.unknown > 0 ? " · 未分类 \(status.unknown)" : "")")
          .font(.callout).monospacedDigit()
        Text("增量同步进度：\(status.checkpoint ?? "尚未建立，需先全量同步")")
          .font(.callout).foregroundStyle(Theme.secondary)
        if let imported = status.importedAt {
          Text("\(displayDate(imported)) 已从 PixelReel 复制现有数据与进度，之后由映览独立维护。")
            .font(.caption).foregroundStyle(Theme.secondary)
        }
        HStack {
          Button("增量同步") { start("incremental") }.buttonStyle(GoldButton()).disabled(disabled || !status.canIncremental)
          Button("全量同步…") { confirmFull = true }.disabled(disabled || status.account.isEmpty)
          if status.syncing {
            ProgressView().controlSize(.small)
            Button("停止同步") { Task { if let client = app.client { await app.douban.action(client, path: "api/douban/cancel") } } }.disabled(app.douban.saving)
          }
        }
        if let run = status.lastRun {
          VStack(alignment: .leading, spacing: 6) {
            Text("\(run.migrated == true ? "迁入的上次记录" : "最近同步") · \(run.mode == "full" ? "全量" : "增量") · \(run.stateLabel)").font(.callout.weight(.medium))
            Text(status.syncing ? "已读取 \(run.pages) 页 · \(run.scanned) 条，完成后统一保存" : "新增 \(run.imported) · 补充 \(run.updated) · 跳过 \(run.skipped)").font(.caption).monospacedDigit()
            if let date = run.finishedAt { Text("结束于 \(displayDate(date))").font(.caption).foregroundStyle(Theme.secondary) }
            if let error = run.error { Text(error).font(.caption).foregroundStyle(Theme.accent).textSelection(.enabled) }
          }
        }
      } else { Text("正在读取豆瓣同步设置…").font(.callout) }
      if let error = app.douban.statusError {
        HStack { Text(error).font(.caption); Button("重试") { Task { if let client = app.client { await app.douban.loadStatus(client) } } } }.foregroundStyle(Theme.accent)
      }
      Text("增量从上次成功进度继续；全量重读已看列表并补充空字段，不删除历史记录或覆盖原评分、短评。来源未明确类型的新条目标为未分类。请求至少间隔两秒，失败或取消保留原进度。")
        .font(.caption).foregroundStyle(Theme.secondary)
    }.padding(22).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
      .onChange(of: app.douban.status?.account, initial: true) { _, value in if let value { account = value } }
      .alert("全量同步豆瓣已看？", isPresented: $confirmFull) {
        Button("取消", role: .cancel) {}
        Button("开始全量同步") { start("full") }
      } message: { Text("将按限速分页读取整个豆瓣已看列表，数千条记录可能耗时较长。现有记录会保留，只有整批读取成功才更新数据与同步日期。") }
  }
  private func start(_ mode: String) {
    Task { if let client = app.client { await app.douban.action(client, path: "api/douban/sync", fields: ["mode": mode]) } }
  }
}

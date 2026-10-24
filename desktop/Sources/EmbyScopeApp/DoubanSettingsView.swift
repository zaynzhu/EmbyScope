import SwiftUI
import EmbyScopeCore

struct DoubanSettingsView: View {
  @Environment(AppModel.self) private var app
  @State private var account = ""
  @State private var confirmFull = false
  @State private var editingS3 = false
  private var disabled: Bool { app.offline || app.demo || app.douban.saving || app.douban.status?.syncing == true || app.douban.status?.posters?.running == true || app.douban.status == nil }
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
        if let posters = status.posters {
          Divider()
          Text("海报补全与存储").font(.headline)
          Text("待补图 \(posters.missing) · 本地已存 \(posters.cached) · S3 已存 \(posters.mirrored)").font(.caption).monospacedDigit()
          if posters.pendingMirror > 0 { Text("本地另有 \(posters.pendingMirror) 张尚未上传 S3，点击补全可重试上传。").font(.caption).foregroundStyle(Theme.accent) }
          Text(posters.s3Configured ? "S3 已配置 · 新图片下载后上传至映览独立目录，本机保留缓存。" : "图片下载后保存在映览本机数据库，尚未配置 S3。")
            .font(.caption).foregroundStyle(Theme.secondary)
          if let s3 = posters.s3, s3.configured {
            Text("端点：\(s3.endpoint)\n桶：\(s3.bucket) · 区域：\(s3.region)").font(.caption).foregroundStyle(Theme.secondary).textSelection(.enabled)
          }
          Button(posters.s3Configured ? "编辑 S3 配置…" : "配置 S3 存储…") { editingS3 = true }.disabled(disabled)
          HStack {
            Button("补全缺失海报") { posterAction("fill") }.disabled(disabled || (posters.missing == 0 && posters.pendingMirror == 0))
            if posters.running {
              ProgressView().controlSize(.small)
              Button("停止补图") { posterAction("cancel") }.disabled(app.douban.saving)
            }
          }
          if let run = posters.lastRun {
            Text("\(run.stateLabel) · 已处理 \(run.processed)/\(run.total) · 已保存 \(run.saved) · 未匹配 \(run.unmatched)").font(.caption).monospacedDigit()
            if let error = run.error { Text(error).font(.caption).foregroundStyle(Theme.accent).textSelection(.enabled) }
          }
          Text("只按豆瓣 ID 精确补图，不修改评分、短评或同步日期。停止后已保存的图片保留，再次补图优先处理未尝试条目；未匹配不代表作品没有海报。")
            .font(.caption).foregroundStyle(Theme.secondary)
        }
      } else { Text("正在读取豆瓣同步设置…").font(.callout) }
      if let error = app.douban.statusError {
        HStack { Text(error).font(.caption); Button("重试") { Task { if let client = app.client { await app.douban.loadStatus(client) } } } }.foregroundStyle(Theme.accent)
      }
      Text("增量从上次成功进度继续；全量重读已看列表并补充空字段，不删除历史记录或覆盖原评分、短评。同步成功后自动补全本次涉及的缺失海报，配置 S3 时同时上传；补图失败保留已看记录和同步进度，可在下方重试。来源未明确类型的新条目标为未分类。请求至少间隔两秒，失败或取消保留原进度。")
        .font(.caption).foregroundStyle(Theme.secondary)
    }.padding(22).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
      .onChange(of: app.douban.status?.account, initial: true) { _, value in if let value { account = value } }
      .sheet(isPresented: $editingS3) { S3PosterSettingsView() }
      .alert("全量同步豆瓣已看？", isPresented: $confirmFull) {
        Button("取消", role: .cancel) {}
        Button("开始全量同步") { start("full") }
      } message: { Text("将按限速分页读取整个豆瓣已看列表，数千条记录可能耗时较长。现有记录会保留，只有整批读取成功才更新数据与同步日期。") }
  }
  private func start(_ mode: String) {
    Task { if let client = app.client { await app.douban.action(client, path: "api/douban/sync", fields: ["mode": mode]) } }
  }
  private func posterAction(_ action: String) {
    Task { if let client = app.client { await app.douban.action(client, path: "api/douban/posters/\(action)") } }
  }
}

private struct S3PosterSettingsView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var endpoint = ""
  @State private var bucket = ""
  @State private var region = "us-east-1"
  @State private var accessKey = ""
  @State private var secretKey = ""
  @State private var error: String?
  private var existing: DoubanStatus.Posters.S3? { app.douban.status?.posters?.s3 }
  private var destinationChanged: Bool {
    guard let existing, existing.configured else { return false }
    return endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/ ")) != existing.endpoint || bucket.trimmingCharacters(in: .whitespacesAndNewlines) != existing.bucket
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("S3 海报存储配置").font(.title3.weight(.semibold))
      Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 14) {
        GridRow { Text("端点"); TextField("https://s3.example.com", text: $endpoint) }
        GridRow { Text("桶名"); TextField("海报存储桶", text: $bucket) }
        GridRow { Text("区域"); TextField("us-east-1", text: $region) }
        GridRow { Text("Access Key"); SecureField(existing?.credentialsConfigured == true ? "已配置，留空保留" : "填写 Access Key", text: $accessKey) }
        GridRow { Text("Secret Key"); SecureField(existing?.credentialsConfigured == true ? "已配置，留空保留" : "填写 Secret Key", text: $secretKey) }
      }.textFieldStyle(.roundedBorder)
      Text("密钥加密保存在映览本机，不显示已有明文。保存只更新本地配置，不发起连接测试或补图。").font(.caption).foregroundStyle(Theme.secondary)
      if destinationChanged {
        Text("更换端点或桶需重填两项密钥。原桶图片会保留，本地缓存可继续显示；之后通过“补全缺失海报”上传到新桶。").font(.caption).foregroundStyle(Theme.accent)
      }
      if let error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      HStack {
        Spacer()
        Button("取消") { dismiss() }.disabled(app.douban.saving)
        Button("保存配置") { save() }.buttonStyle(GoldButton())
          .disabled(app.douban.saving || endpoint.isEmpty || bucket.isEmpty || ((destinationChanged || existing?.credentialsConfigured != true) && (accessKey.isEmpty || secretKey.isEmpty)))
      }
    }.padding(28).frame(width: 580).background(Theme.background)
      .interactiveDismissDisabled(app.douban.saving)
      .onAppear {
        endpoint = existing?.endpoint ?? ""
        bucket = existing?.bucket ?? ""
        region = existing?.region ?? "us-east-1"
      }
  }
  private func save() {
    Task {
      guard let client = app.client else { return }
      await app.douban.action(client, path: "api/douban/posters/settings", method: "PUT", fields: [
        "endpoint": endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
        "bucket": bucket.trimmingCharacters(in: .whitespacesAndNewlines),
        "region": region.trimmingCharacters(in: .whitespacesAndNewlines),
        "accessKey": accessKey, "secretKey": secretKey
      ])
      if let failure = app.douban.statusError { error = failure }
      else { accessKey = ""; secretKey = ""; dismiss() }
    }
  }
}

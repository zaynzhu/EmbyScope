import SwiftUI
import ImageIO
import EmbyScopeCore

struct DoubanView: View {
  @Environment(AppModel.self) private var app
  @State private var selected: DoubanItem?
  var body: some View {
    @Bindable var model = app.douban
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        SectionTitle(title: "豆瓣已看", subtitle: "你的观影记录 · 按豆瓣标记日期排列")
        Spacer()
        if let total = model.status?.total { Text("共 \(total) 条").font(.caption.monospacedDigit()).foregroundStyle(Theme.secondary) }
        Button("同步设置") { app.navigate(to: .settings) }
      }
      HStack {
        TextField("搜索片名或别名", text: $model.query).textFieldStyle(.roundedBorder).frame(maxWidth: 330)
        Picker("类型", selection: $model.type) {
          Text("全部影视").tag(""); Text("电影").tag("Movie"); Text("剧集").tag("Series"); Text("未分类").tag("Unknown")
        }.frame(width: 170)
        Spacer()
        if let checkpoint = model.status?.checkpoint { Text("增量进度至 \(checkpoint)").font(.caption).foregroundStyle(Theme.secondary) }
      }
      if let error = model.error {
        HStack { Text(error).font(.callout); Button("重试") { Task { if let client = app.client { await model.load(client, page: model.retryPage) } } } }.foregroundStyle(Theme.accent)
      }
      ScrollView {
        if let result = model.result {
          if result.items.isEmpty { EmptyState(title: "没有匹配的已看记录", message: result.total == 0 && model.status?.total == 0 ? "在设置中配置豆瓣账号并同步，已有 PixelReel 数据可一次性迁入。" : "试试其他片名或类型。") }
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 290), spacing: 18)], spacing: 18) {
            ForEach(result.items) { item in
              Button { selected = item } label: {
                HStack(alignment: .top, spacing: 14) {
                  DoubanPoster(item: item).frame(width: 78, height: 112).clipShape(RoundedRectangle(cornerRadius: 6))
                  VStack(alignment: .leading, spacing: 8) {
                    Text(item.title).font(.headline).lineLimit(2).foregroundStyle(Theme.text)
                    Text(item.ratingLabel).font(.caption).foregroundStyle(Theme.accent)
                    Text("\(item.typeLabel) · \(item.date ?? "日期未知")").font(.caption).foregroundStyle(Theme.secondary)
                    Text(item.commentNeedsReview ? "原短评与影视信息相同，待核对" : item.comment?.isEmpty == false ? item.comment! : "没有短评").font(.caption).foregroundStyle(Theme.secondary).lineLimit(2)
                  }.frame(maxWidth: .infinity, alignment: .leading)
                }.frame(height: 120, alignment: .top).padding(16).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
              }.buttonStyle(.plain)
            }
          }
        } else if model.loading { ProgressView("正在读取豆瓣已看…").frame(maxWidth: .infinity, minHeight: 200) }
      }
      HStack {
        Text("\(model.result?.total ?? 0) 条匹配记录 · 与服务器片库独立").font(.caption).foregroundStyle(Theme.secondary)
        Spacer()
        if model.loading { ProgressView().controlSize(.small) }
        Button("上一页") { Task { if let client = app.client { await model.load(client, page: (model.result?.page ?? 1) - 1) } } }.disabled(model.loading || (model.result?.page ?? 1) <= 1)
        Text("\(model.result?.page ?? 1) / \(model.result?.pages ?? 1)").font(.caption.monospacedDigit()).frame(minWidth: 60)
        Button("下一页") { Task { if let client = app.client { await model.load(client, page: (model.result?.page ?? 1) + 1) } } }.disabled(model.loading || model.result == nil || (model.result?.page ?? 1) >= (model.result?.pages ?? 1))
      }
    }.padding(28)
      .task { if let client = app.client { await model.loadStatus(client) } }
      .task(id: "\(model.query)\u{0}\(model.type)") {
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        if let client = app.client { await model.load(client, clearResults: true) }
      }
      .sheet(item: $selected) { item in DoubanDetail(item: item) }
  }
}

private struct DoubanPoster: View {
  @Environment(AppModel.self) private var app
  let item: DoubanItem
  @State private var image: NSImage?
  @State private var loading = true
  @State private var error: String?
  @State private var retry = 0
  var body: some View {
    GeometryReader { size in
      ZStack {
        Theme.line
        if let image { Image(nsImage: image).resizable().scaledToFill().frame(width: size.size.width, height: size.size.height).clipped() }
        else if loading { ProgressView().controlSize(.small) }
        else { VStack(spacing: 6) {
          Image(systemName: "film").font(.title2).foregroundStyle(Theme.secondary)
          Text(error == nil ? "暂无海报" : "加载失败").font(.system(size: 10)).foregroundStyle(Theme.secondary)
          if error != nil { Button("重试") { retry += 1 }.font(.system(size: 10)).buttonStyle(.borderless) }
        }.help(error ?? "在同步设置中补全海报") }
      }
    }.accessibilityLabel("\(item.title)海报")
      .task(id: "\(item.id)-\(retry)") {
        loading = true
        error = nil
        defer { loading = false }
        guard let client = app.client else { return }
        do {
          let data = try await client.data("api/douban/items/\(item.id)/poster")
          guard !Task.isCancelled else { return }
          let thumbnail = await Task.detached(priority: .utility) { () -> CGImage? in
            guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 400, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary)
          }.value
          if let thumbnail, !Task.isCancelled { image = NSImage(cgImage: thumbnail, size: .zero) }
          else if !Task.isCancelled { error = "图片内容无法解码" }
        } catch let failure as APIError {
          if !Task.isCancelled && failure.status != 404 { error = failure.localizedDescription }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
      }
  }
}

private struct DoubanDetail: View {
  @Environment(\.dismiss) private var dismiss
  let item: DoubanItem
  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      HStack { Text("豆瓣已看详情").font(.title3.weight(.semibold)); Spacer(); Button("关闭") { dismiss() } }
      ScrollView {
        HStack(alignment: .top, spacing: 24) {
          DoubanPoster(item: item).frame(width: 150, height: 215).clipShape(RoundedRectangle(cornerRadius: 8))
          VStack(alignment: .leading, spacing: 12) {
            Text(item.title).font(.title2.weight(.semibold))
            if let alt = item.altTitle { Text(alt).font(.callout).foregroundStyle(Theme.secondary) }
            Text("\(item.typeLabel) · 标记已看 \(item.date ?? "日期未知")").font(.callout)
            Text("我的豆瓣评分：\(item.ratingLabel)").foregroundStyle(Theme.accent)
            if let average = item.averageRating { Text("豆瓣均分：\(average, specifier: "%.1f")").font(.caption) }
            Link("在豆瓣查看条目 ↗", destination: item.link)
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
        VStack(alignment: .leading, spacing: 12) {
          Text("我的豆瓣短评").font(.headline)
          if item.commentNeedsReview { Text("这条迁入的短评与影视信息相同，可能是旧采集结果，以下保留原文供核对。").font(.caption).foregroundStyle(Theme.accent) }
          Text(item.comment?.isEmpty == false ? item.comment! : "没有短评").font(.callout)
          if let intro = item.intro { Text("影视信息").font(.headline); Text(intro).font(.callout).foregroundStyle(Theme.secondary) }
          if let overview = item.overview { Text("简介").font(.headline); Text(overview).font(.callout).foregroundStyle(Theme.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
      }.textSelection(.enabled)
    }.padding(28).frame(width: 720, height: 580).background(Theme.background)
  }
}

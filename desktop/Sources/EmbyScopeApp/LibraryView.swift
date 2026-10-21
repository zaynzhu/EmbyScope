import SwiftUI
import EmbyScopeCore

struct LibraryView: View {
  @Environment(AppModel.self) private var app
  var body: some View {
    @Bindable var app = app
    VStack(alignment: .leading, spacing: 20) {
      HStack {
        SectionTitle(title: app.page == .duplicates ? "重复与刮削排查" : "你的片库", subtitle: app.page == .duplicates ? "分开核对资源重复线索与元数据疑点。不同季不直接算重复，证据不足保留待确认。" : "电影与剧集 · 每张卡片保留来源")
        Spacer()
        if let total = app.library?.total { Text("\(total) 个\(app.page == .duplicates ? "关联组" : "作品分组")").font(.caption.monospacedDigit()).foregroundStyle(Theme.secondary) }
      }
      if app.page == .duplicates {
        Picker("排查范围", selection: $app.reviewFilter) {
          Text("需核对").tag("issues")
          Text("资源重复线索").tag("resources")
          Text("元数据疑点").tag("metadata")
          Text("季范围待确认").tag("unknown")
          Text("全部关联（含不同季）").tag("all")
        }.pickerStyle(.segmented)
          .onChange(of: app.reviewFilter) { _, _ in app.libraryPage = 1; Task { await app.loadLibrary() } }
        Text("只分析本地缓存；译名、不同版本和不完整季集都可能产生提示。提示不是删除依据，也不代表已确认刮削错误。")
          .font(.caption).foregroundStyle(Theme.secondary)
      }
      HStack(spacing: 16) {
        TextField("搜索片名", text: $app.query).textFieldStyle(.roundedBorder).frame(maxWidth: 330)
          .onSubmit { app.libraryPage = 1; Task { await app.loadLibrary() } }
        Picker("类型", selection: $app.mediaType) { Text("全部类型").tag(""); Text("电影").tag("Movie"); Text("电视剧").tag("Series") }.frame(width: 180)
          .onChange(of: app.mediaType) { _, _ in app.libraryPage = 1; Task { await app.loadLibrary() } }
        Button("搜索") { app.libraryPage = 1; Task { await app.loadLibrary() } }.buttonStyle(.bordered)
        Spacer()
      }
      ScrollView {
        if let result = app.library {
          if result.items.isEmpty { EmptyState(title: "没有找到匹配条目", message: "试试其他片名、媒体类型或服务器。") }
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 210), spacing: 20)], alignment: .leading, spacing: 28) {
            ForEach(result.items, id: \.key) { item in MediaCard(item: item) }
          }.padding(.vertical, 6)
        } else { ProgressView("正在读取片库…").frame(maxWidth: .infinity, minHeight: 240) }
      }
      HStack {
        Text("仅展示当前账号可访问的数据").font(.caption).foregroundStyle(Theme.secondary)
        Spacer()
        Button("上一页") { app.libraryPage = max(1, app.libraryPage - 1); Task { await app.loadLibrary() } }.disabled(app.libraryPage <= 1)
        Text("\(app.library?.page ?? 1) / \(app.library?.pages ?? 1)").font(.caption.monospacedDigit()).frame(minWidth: 60)
        Button("下一页") { app.libraryPage += 1; Task { await app.loadLibrary() } }.disabled(app.libraryPage >= (app.library?.pages ?? 1))
      }
    }.padding(28).task(id: app.page) { await app.loadLibrary() }
  }
}

struct OverviewView: View {
  @Environment(AppModel.self) private var app
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 28) {
        SectionTitle(title: "一览你的收藏", subtitle: "条目、作品与来源，分别统计。缺失数据不会记作零。")
        if let overview = app.overview {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: 155), spacing: 18)], spacing: 18) {
            metric("电影条目", overview.stats.movies)
            metric("电视剧条目", overview.stats.series)
            metric("单集", overview.stats.episodes)
            metric("媒体库", overview.stats.libraries)
          }
          HStack(spacing: 34) {
            metric("各服条目合计", overview.stats.entries)
            metric("去重作品数", overview.stats.uniqueWorks)
            Button { app.navigate(to: .duplicates) } label: {
              metric("有多条记录的作品 →", overview.stats.duplicateGroups)
            }.buttonStyle(.plain)
          }
          Text("去重作品数按整部电影或整部剧计数，不是重复文件数；不同季也可能属于同一作品。排查页另外核对季范围与编号冲突。")
            .font(.caption).foregroundStyle(Theme.secondary)
          if !overview.stats.complete { Label("统计未完整，详情见各服务器状态。", systemImage: "info.circle").font(.caption).foregroundStyle(Theme.accent) }
          SectionTitle(title: "服务器", subtitle: "状态来自上次请求；在线不表示正在持续探测")
          ForEach(overview.servers) { server in
            VStack(alignment: .leading, spacing: 10) {
              HStack { Text(server.name).font(.headline); Spacer(); Text(server.statusLabel).font(.caption).foregroundStyle(Theme.accent) }
              if let error = server.error { Text(error).font(.caption).foregroundStyle(Theme.secondary) }
              ForEach(server.datasets.keys.sorted(), id: \.self) { kind in
                if let data = server.datasets[kind] {
                  HStack {
                    Text(["catalog": "片库", "views": "媒体库", "latest": "最近入库", "resume": "继续观看"][kind] ?? kind).frame(width: 75, alignment: .leading)
                    Text(data.available ? displayDate(data.updatedAt) : "不可用")
                    if data.stale { Text("缓存可能过期").foregroundStyle(Theme.accent) }
                    if let error = data.error { Text(error).lineLimit(2) }
                  }.font(.system(size: 11)).foregroundStyle(Theme.secondary)
                }
              }
            }.padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
          }
          SectionTitle(title: "媒体库", subtitle: "按来源展示")
          ForEach(overview.views, id: \.key) { library in
            Label("\(library.name) · \(library.serverName ?? "来源未知")", systemImage: "folder").font(.callout).foregroundStyle(Theme.secondary)
          }
          SectionTitle(title: "最近入库", subtitle: "入库时间与观看时间是两件事")
          ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 20) { ForEach(overview.latest, id: \.key) { item in MediaCard(item: item).frame(width: 150) } }.padding(.vertical, 4)
          }
          Text(overview.stats.historyReason).font(.caption).foregroundStyle(Theme.secondary)
        }
      }.padding(30).frame(maxWidth: 1300).frame(maxWidth: .infinity)
    }
  }
  private func metric(_ label: String, _ value: Int?) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(label).font(.caption).foregroundStyle(Theme.secondary)
      Text(value.map { $0.formatted() } ?? "不可用").font(.system(size: value == nil ? 22 : 32, weight: .medium, design: .rounded)).monospacedDigit()
    }.frame(maxWidth: .infinity, alignment: .leading).padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
  }
}

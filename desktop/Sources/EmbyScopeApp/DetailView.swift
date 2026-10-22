import SwiftUI
import EmbyScopeCore

struct DetailView: View {
  @Environment(AppModel.self) private var app
  let selected: Media
  @State private var season = ""
  var body: some View {
    let item = app.detail ?? selected
    VStack(spacing: 0) {
      HStack {
        Text("条目详情").font(.headline)
        Spacer()
        Button { withAnimation(app.animation) { app.closeDetail() } } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("关闭详情")
      }.padding(22)
      Divider().overlay(Theme.line)
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          PosterView(item: item).frame(height: 180).clipped().clipShape(RoundedRectangle(cornerRadius: 12))
          VStack(alignment: .leading, spacing: 9) {
            Text(item.title).font(.system(size: 25, weight: .bold))
            Text(item.metadata).font(.caption).foregroundStyle(Theme.secondary)
            Text(item.genres?.joined(separator: " / ") ?? "类型未知").font(.caption).foregroundStyle(Theme.accent)
          }
          if let overview = item.overview { Text(overview).font(.system(size: 13)).lineSpacing(5).foregroundStyle(Theme.secondary).textSelection(.enabled) }
          if app.detailLoading { ProgressView("读取详情…") }
          if let error = app.detailError { Text(error).foregroundStyle(Theme.accent).font(.caption) }
          Divider().overlay(Theme.line)
          let sources = (item.duplicateSources ?? [item]).sorted { a, b in
            if a.key == selected.key { return b.key != selected.key }
            if b.key == selected.key { return false }
            return a.key < b.key
          }
          VStack(alignment: .leading, spacing: 9) {
            Text("关联记录 · \(sources.count) 条").font(.headline)
            Text("范围：全部连接的缓存。下方保留每条记录的原始标题、季范围和编号；补充线索不代表同一作品。整部剧的相同编号不代表同一季重复。")
              .font(.caption).foregroundStyle(Theme.secondary)
            if item.duplicateConflict == true { Text("编号冲突，当前条目保留独立，未自动归并。").font(.caption).foregroundStyle(Theme.accent) }
          }
          if let comparison = item.comparison { ComparisonView(comparison: comparison, sources: sources) }
          ForEach(sources, id: \.key) { source in
            sourceRow(source, current: source.key == selected.key)
          }
          if item.type == "Series" || item.type == "Episode" {
            Divider().overlay(Theme.line)
            Text("季集信息").font(.headline)
            Picker("季", selection: $season) {
              Text("全部季").tag("")
              ForEach(item.seasons ?? [], id: \.self) { number in Text("第 \(number) 季").tag(String(number)) }
            }.onChange(of: season) { _, value in Task { await app.loadEpisodes(page: 1, season: value) } }
            if let total = item.episodeTotal { Text("已读取 \(total) 个单集").font(.caption).foregroundStyle(Theme.secondary) }
            else { Text("单集总数不可用").font(.caption).foregroundStyle(Theme.secondary) }
            if let error = item.episodeError { Text(error).font(.caption).foregroundStyle(Theme.accent) }
            ForEach(item.episodes ?? [], id: \.key) { episode in
              VStack(alignment: .leading, spacing: 4) { Text(episode.title).font(.caption); Text(episode.mediaLabel).font(.system(size: 10)).foregroundStyle(Theme.secondary) }
            }
            if (item.episodePages ?? 1) > 1 {
              HStack {
                Button("上一页") { Task { await app.loadEpisodes(page: (item.episodePage ?? 1) - 1, season: season) } }.disabled((item.episodePage ?? 1) <= 1)
                Text("\(item.episodePage ?? 1) / \(item.episodePages ?? 1)").font(.caption)
                Button("下一页") { Task { await app.loadEpisodes(page: (item.episodePage ?? 1) + 1, season: season) } }.disabled((item.episodePage ?? 1) >= (item.episodePages ?? 1))
              }
            }
          }
        }.padding(22)
      }
    }.frame(width: 350).background(Theme.surface)
      .onChange(of: selected.key) { _, _ in season = "" }
  }
  private func sourceRow(_ source: Media, current: Bool) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(source.serverName ?? app.servers.first(where: { $0.id == source.serverId })?.name ?? "来源未知").font(.system(size: 12, weight: .semibold))
        Spacer()
        if current { Text("当前条目").font(.system(size: 10)).foregroundStyle(Theme.accent) }
      }
      Text(source.title).font(.system(size: 14, weight: .semibold)).textSelection(.enabled)
      Text(source.metadata).font(.caption).foregroundStyle(Theme.secondary)
      if let scope = source.scope { Text(scope.label).font(.caption).foregroundStyle(Theme.accent) }
      if let overview = source.overview, !overview.isEmpty {
        DisclosureGroup("此记录的简介") { Text(overview).font(.caption).textSelection(.enabled) }
          .font(.caption)
      }
      Text("条目标识：\(source.id)").font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.secondary).textSelection(.enabled)
      if let ids = source.providerIds, !ids.isEmpty {
        Text(ids.keys.sorted().map { "\($0.uppercased()) \(ids[$0]!)" }.joined(separator: " · ")).font(.system(size: 10)).foregroundStyle(Theme.secondary)
      }
      if let locations = app.resources[source.key] {
        ForEach(locations.locations, id: \.path) { location in
          VStack(alignment: .leading, spacing: 6) {
            Text(location.label).font(.system(size: 10)).foregroundStyle(Theme.secondary)
            Text(location.path).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            Button("复制位置") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(location.path, forType: .string) }.font(.caption)
          }
        }
        if locations.locations.isEmpty { Text(locations.updatedAt == nil ? "尚未读取资源位置" : "接口未提供可展示的本地路径").font(.caption).foregroundStyle(Theme.secondary) }
        if locations.hiddenRemote { Text("含远程地址或敏感参数的路径已隐藏。").font(.caption).foregroundStyle(Theme.secondary) }
        if let time = locations.updatedAt { Text("位置缓存：\(displayDate(time))\(locations.stale == true ? " · 可能过期" : "")").font(.system(size: 10)).foregroundStyle(Theme.secondary) }
        if let error = locations.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      }
      if let error = app.resourceErrors[source.key] { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      Button(app.resourceLoading.contains(source.key) ? "读取中…" : "读取资源位置") { Task { await app.loadResources(source) } }.font(.caption).disabled(app.resourceLoading.contains(source.key))
      if !current { Button("查看此记录的季集与详情") { Task { await app.select(source) } }.font(.caption) }
    }.padding(14).background(Theme.background, in: RoundedRectangle(cornerRadius: 10))
  }
}

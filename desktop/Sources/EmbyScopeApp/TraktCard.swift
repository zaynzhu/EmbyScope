import SwiftUI
import EmbyScopeCore

struct TraktCard: View {
  @Environment(AppModel.self) private var app
  let item: TraktItem
  @State private var image: NSImage?
  @State private var loading = false
  @State private var retry = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      GeometryReader { geometry in
        ZStack(alignment: .bottomLeading) {
          Theme.surface
          if let image {
            Image(nsImage: image).resizable().scaledToFill()
              .frame(width: geometry.size.width, height: geometry.size.height).clipped()
          } else {
            VStack(spacing: 12) {
              Image(systemName: item.type == "movie" ? "film" : "tv").font(.system(size: 30, weight: .ultraLight))
              if loading {
                ProgressView().controlSize(.small)
                Text("正在载入海报").font(.caption)
              } else {
                Text("海报暂不可用").font(.caption)
                if item.posterPath != nil && !app.offline { Button("重试海报") { retry += 1 }.font(.caption) }
              }
            }.foregroundStyle(Theme.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
          }
          if let progress = item.progress {
            VStack(alignment: .leading, spacing: 8) {
              Text("已看 \(progress, specifier: "%.1f")%").font(.caption.weight(.semibold)).foregroundStyle(.white)
              ProgressView(value: progress, total: 100).tint(Theme.gold)
            }.padding(12).background(LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom))
          }
        }.clipShape(RoundedRectangle(cornerRadius: 10))
      }.aspectRatio(2 / 3, contentMode: .fit)
        .accessibilityLabel("\(item.displayTitle)海报")
      Text(item.displayTitle).font(.system(size: 14, weight: .semibold)).lineLimit(1).help(item.displayTitle)
      Text(item.subtitle).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1).help(item.subtitle)
      Text("\(item.pausedAt == nil ? "已看" : "进度更新") · \(displayDate(item.pausedAt ?? item.watchedAt))")
        .font(.system(size: 10)).foregroundStyle(Theme.secondary).lineLimit(1)
      if let plays = item.plays { Text("累计观看 \(plays) 次").font(.system(size: 10)).foregroundStyle(Theme.secondary) }
    }
    .task(id: "\(item.posterPath ?? item.id)-\(app.trakt.status?.updatedAt ?? "")-\(retry)-\(app.trakt.imagesRevision)") {
      guard let path = item.posterPath, let client = app.client else { return }
      image = nil; loading = true
      let result = await PosterCache.shared.load(path: path, key: path, client: client)
      guard !Task.isCancelled else { return }
      image = result; loading = false
    }
  }
}

struct TraktHomeSection: View {
  @Environment(AppModel.self) private var app
  var body: some View {
    if let home = app.trakt.home {
      VStack(alignment: .leading, spacing: 28) {
        HStack(alignment: .top) {
          SectionTitle(title: "最近看过的故事", subtitle: "Trakt · \(home.status.account ?? "") · 同一部剧展示最近看过的一集")
          Spacer()
          if home.status.busy { ProgressView().controlSize(.small) }
          Button("同步观看记录") {
            Task { if let client = app.client { await app.trakt.action(client, path: "api/trakt/sync") } }
          }.buttonStyle(GoldButton()).disabled(home.status.busy || app.trakt.saving || app.offline || app.demo || !home.status.connected)
          Button("全部记录", systemImage: "arrow.up.right") { showAll("recent") }
        }
        if let error = app.trakt.statusError ?? home.status.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
        if home.recent.isEmpty {
          EmptyState(title: "暂无最近观看", message: "同步后会显示 Infuse 已上传到 Trakt 的已看记录。")
        } else { shelf(home.recent) }
        HStack {
          SectionTitle(title: "还没看完", subtitle: "Infuse 等播放器上传到 Trakt 的进度快照")
          Spacer()
          Button("全部续播", systemImage: "arrow.up.right") { showAll("playback") }
        }
        if home.playback.isEmpty {
          EmptyState(title: "暂无续播进度", message: "这里展示已经上报的进度，不代表当前正在播放。")
        } else { shelf(home.playback) }
        Text("海报由 TMDB / Trakt 提供；本应用未经 TMDB 认可或认证。")
          .font(.caption2).foregroundStyle(Theme.secondary)
        Text("最近同步 \(displayDate(home.status.updatedAt)) · 来源为 Trakt 账号，可能包含其他播放器的记录")
          .font(.caption).foregroundStyle(Theme.secondary)
      }
    }
  }
  private func shelf(_ items: [TraktItem]) -> some View {
    ScrollView(.horizontal, showsIndicators: true) {
      LazyHStack(alignment: .top, spacing: 20) {
        ForEach(items) { item in TraktCard(item: item).frame(width: 165) }
      }.padding(.bottom, 10)
    }
  }
  private func showAll(_ kind: String) {
    app.trakt.kind = kind; app.trakt.query = ""; app.trakt.type = ""
    app.navigate(to: .trakt)
  }
}

import SwiftUI
import AppKit
import ImageIO
import EmbyScopeCore

enum Theme {
  static let background = Color(red: 0.965, green: 0.957, blue: 0.937)
  static let surface = Color(red: 0.995, green: 0.990, blue: 0.978)
  static let text = Color(red: 0.17, green: 0.18, blue: 0.17)
  static let line = text.opacity(0.10)
  static let accent = Color(red: 0.56, green: 0.34, blue: 0.13)
  static let gold = Color(red: 0.90, green: 0.72, blue: 0.40)
  static let secondary = Color(red: 0.40, green: 0.41, blue: 0.38)
}

@MainActor
final class PosterCache {
  static let shared = PosterCache()
  private let images = NSCache<NSString, NSImage>()
  private var pending: [String: Task<NSImage?, Never>] = [:]
  init() { images.totalCostLimit = 24 * 1024 * 1024; images.countLimit = 64 }
  func clear() { pending.values.forEach { $0.cancel() }; pending.removeAll(); images.removeAllObjects() }
  func load(_ item: Media, client: APIClient, hero: Bool = false) async -> NSImage? {
    let maxPixels = hero ? 1280 : 480
    let key = item.key + ":" + (item.imageTag ?? "") + ":\(maxPixels)"
    if let image = images.object(forKey: key as NSString) { return image }
    if let task = pending[key] { return await task.value }
    let task = Task<NSImage?, Never> {
      guard item.imageTag != nil,
            let data = try? await client.data(await client.itemPath(item, suffix: "/poster")), !Task.isCancelled else { return nil }
      let thumbnail = await Task.detached(priority: .utility) { () -> CGImage? in
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
      }.value
      guard let thumbnail, !Task.isCancelled else { return nil }
      let image = NSImage(cgImage: thumbnail, size: .zero)
      images.setObject(image, forKey: key as NSString, cost: thumbnail.bytesPerRow * thumbnail.height)
      return image
    }
    pending[key] = task
    let image = await task.value
    pending[key] = nil
    return image
  }
}

struct PosterView: View {
  @Environment(AppModel.self) private var app
  let item: Media
  var hero = false
  @State private var image: NSImage?
  @State private var failed = false
  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Theme.surface
        if let image {
          Image(nsImage: image).resizable().scaledToFill()
            .frame(width: geometry.size.width, height: geometry.size.height).clipped()
            .blur(radius: app.isHidden(item) ? 24 : 0)
        } else {
          LinearGradient(colors: [Theme.accent.opacity(0.12), Theme.surface], startPoint: .topLeading, endPoint: .bottomTrailing)
          VStack(spacing: 12) {
            Image(systemName: "film.stack").font(.system(size: hero ? 45 : 23, weight: .ultraLight))
            if !hero { Text(failed ? "海报暂不可用" : "暂无海报").font(.caption) }
          }.foregroundStyle(Theme.secondary)
        }
        if app.isHidden(item) {
          Color.black.opacity(0.25)
          Button { withAnimation(app.animation) { _ = app.revealed.insert(item.key) } } label: {
            Label("显示这张海报", systemImage: "eye.slash").font(.caption.weight(.medium))
              .padding(10).background(.ultraThinMaterial, in: Capsule())
          }.buttonStyle(.plain)
        }
      }
    }
    .accessibilityLabel(app.isHidden(item) ? "已遮挡的海报" : "\(item.title)海报")
    .task(id: item.key + (item.imageTag ?? "")) {
      image = nil; failed = false
      guard let client = app.client else { return }
      let result = await PosterCache.shared.load(item, client: client, hero: hero)
      guard !Task.isCancelled else { return }
      image = result; failed = item.imageTag != nil && result == nil
    }
  }
}

struct GoldButton: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.system(size: 12, weight: .semibold)).padding(.horizontal, 16).padding(.vertical, 10)
      .foregroundStyle(Theme.text).background(Theme.gold.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 8))
  }
}

struct SectionTitle: View {
  let title: String
  let subtitle: String
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.system(size: 21, weight: .semibold))
      if !subtitle.isEmpty { Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.secondary) }
    }
  }
}

struct EmptyState: View {
  let title: String
  let message: String
  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "rectangle.stack.badge.minus").font(.system(size: 30, weight: .light)).foregroundStyle(Theme.accent)
      Text(title).font(.title3.weight(.medium))
      Text(message).font(.callout).foregroundStyle(Theme.secondary).multilineTextAlignment(.center).frame(maxWidth: 420)
    }.frame(maxWidth: .infinity).padding(40)
  }
}

struct MediaCard: View {
  @Environment(AppModel.self) private var app
  let item: Media
  var compact = false
  @State private var hovering = false
  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      PosterView(item: item).aspectRatio(compact ? 1.65 : 0.7, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(alignment: .bottom) {
          if compact, let progress = item.progress {
            GeometryReader { geo in
              Rectangle().fill(Theme.accent).frame(width: geo.size.width * progress)
            }.frame(height: 3).background(.white.opacity(0.13))
          }
        }
      Button { Task { await app.select(item) } } label: {
        VStack(alignment: .leading, spacing: 5) {
          Text(item.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
          Text(item.metadata).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
          HStack(spacing: 5) {
            Text(item.serverName ?? "来源未知").lineLimit(1)
            if let count = item.sources?.count, count > 1 { Text("· \(count) 条记录").foregroundStyle(Theme.accent) }
          }.font(.system(size: 10)).foregroundStyle(Theme.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
      }.buttonStyle(.plain)
    }
    .scaleEffect(hovering && !app.reduceMotion ? 1.018 : 1)
    .animation(app.animation, value: hovering)
    .onHover { hovering = $0 }
    .onTapGesture { if !app.isHidden(item) { Task { await app.select(item) } } }
    .accessibilityElement(children: .contain)
  }
}

import Foundation

public struct Media: Codable, Identifiable, Hashable {
  public let id: String
  public let serverId: String
  public let title: String
  public let type: String?
  public let serverName: String?
  public let overview: String?
  public let year: Int?
  public let rating: Double?
  public let genres: [String]?
  public let imageTag: String?
  public let providerIds: [String: String]?
  public let runtimeTicks: Double?
  public let positionTicks: Double?
  public let lastPlayed: String?
  public let observedAt: String?
  public let nsfw: Bool?
  public let season: Int?
  public let episode: Int?
  public let seriesName: String?
  public let sources: [Media]?
  public let conflict: Bool?
  public let duplicateSources: [Media]?
  public let duplicateConflict: Bool?
  public let comparison: Comparison?
  public let scope: MediaScope?
  public let resources: Resources?
  public let episodes: [Media]?
  public let seasons: [Int]?
  public let episodeTotal: Int?
  public let episodePage: Int?
  public let episodePages: Int?
  public let episodeError: String?
  public var key: String { "\(serverId):\(id)" }
  public var sensitive: Bool { nsfw == true || sources?.contains(where: { $0.nsfw == true }) == true || duplicateSources?.contains(where: { $0.nsfw == true }) == true }
  public var progress: Double? {
    guard let runtimeTicks, runtimeTicks > 0, let positionTicks, positionTicks >= 0 else { return nil }
    return min(1, positionTicks / runtimeTicks)
  }
  public var mediaLabel: String {
    if type == "Episode" { return "\(seriesName ?? title) · S\(season.map(String.init) ?? "?") E\(episode.map(String.init) ?? "?")" }
    return type == "Series" ? "电视剧" : "电影"
  }
  public var metadata: String {
    [year.flatMap { $0 > 0 ? String($0) : nil }, type == "Episode" ? mediaLabel : (type == "Series" ? "电视剧" : "电影"), rating.flatMap { $0 > 0 && $0 <= 10 ? String(format: "%.1f 分", $0) : nil }].compactMap { $0 }.joined(separator: "  ·  ")
  }
}
public struct MediaScope: Codable, Hashable {
  public let seasons: [Int]
  public let origin: String
  public let label: String
  public let mismatch: Bool
}
public struct Comparison: Codable, Hashable {
  public struct Counts: Codable, Hashable { public let candidate: Int; public let distinct: Int; public let unknown: Int }
  public struct Pair: Codable, Hashable { public let leftKey: String; public let rightKey: String; public let kind: String; public let reason: String; public let basis: [String]? }
  public let label: String
  public let reasons: [String]
  public let counts: Counts
  public let hasMetadata: Bool
  public let supplemental: Bool?
  public let pairs: [Pair]
  public let truncated: Bool
}

public struct Resources: Codable, Hashable {
  public struct Location: Codable, Hashable { public let path: String; public let label: String }
  public let locations: [Location]
  public let hiddenRemote: Bool
  public let error: String?
  public let updatedAt: String?
  public let stale: Bool?
}
public struct Dataset: Codable, Hashable {
  public let available: Bool
  public let updatedAt: String?
  public let error: String?
  public let stale: Bool
  public let warning: String?
}

public func resourceComparison(leftServer: String, rightServer: String, left: Resources?, right: Resources?) -> String {
  guard let left, let right, !left.locations.isEmpty, !right.locations.isEmpty else {
    return "位置证据不足：请逐条核对下方已有路径，或按需读取位置。"
  }
  let stale = left.stale == true || right.stale == true || left.error != nil || right.error != nil
  let prefix = stale ? "旧缓存线索：" : "位置线索："
  // 目录及未知类型不能当作文件身份；扩展名也只是文件路径线索。
  let extensions: Set<String> = ["mkv", "mp4", "avi", "mov", "m4v", "wmv", "ts", "m2ts", "iso", "strm"]
  func filePaths(_ resource: Resources) -> Set<String> {
    Set(resource.locations.map(\.path).filter { path in
      !path.hasSuffix("/") && !path.hasSuffix("\\") && extensions.contains((path as NSString).pathExtension.lowercased())
    })
  }
  let leftFiles = filePaths(left)
  let rightFiles = filePaths(right)
  guard !leftFiles.isEmpty, !rightFiles.isEmpty else {
    return prefix + "位置证据不足：包含目录或未知类型路径，不能据此推断重复文件。"
  }
  let shared = !leftFiles.isDisjoint(with: rightFiles)
  if leftServer != rightServer {
    return prefix + (shared ? "跨服务器出现相同路径文本，不能据此认定共用文件或存了多份。" : "跨服务器路径不同，可能是同一存储的不同映射，也可能是多份资源。")
  }
  return prefix + (shared ? "同服务器存在重合的媒体文件路径文本，可能重复入库；其余路径仍需核对。" : "同服务器媒体文件路径文本不同，可能是版本或映射差异；未确认有多份视频。")
}
public struct Server: Codable, Identifiable, Hashable {
  public struct CatalogProgress: Codable, Hashable {
    public let directories: Int
    public let discovered: Int
    public let items: Int
  }
  public struct EpisodeSync: Codable, Hashable {
    public let completed: Int
    public let series: Int
    public let failed: Int
    public let knownEpisodes: Int
    public let syncing: Bool
    public let stale: Bool
  }
  public let id: String
  public let name: String
  public let url: String
  public let proxyUrl: String?
  public let status: String
  public let error: String?
  public let nsfw: Bool
  public let lightMinutes: Int
  public let fullHours: Int
  public let syncing: Bool
  public let attemptedAt: String?
  public let catalogProgress: CatalogProgress?
  public let episodeSync: EpisodeSync?
  public let datasets: [String: Dataset]
  public var statusLabel: String {
    if syncing { return "正在更新" }
    return ["online": "在线", "partial": "部分可用", "offline": "离线缓存", "denied": "访问受限", "pending": "等待连接", "error": "连接异常"][status] ?? "状态未知"
  }
}
public struct PlaybackResponse: Decodable {
  public struct Session: Decodable, Identifiable {
    public let id: String
    public let itemId: String
    public let title: String
    public let client: String?
    public let device: String?
    public let state: String
    public let observedAt: String?
    public let positionTicks: Double?
    public let runtimeTicks: Double?
    public func hasRecentActivity(at now: Date) -> Bool {
      guard state == "activity", let observedAt,
        let date = ISO8601DateFormatter.withMilliseconds.date(from: observedAt) else { return false }
      return now.timeIntervalSince(date) >= 0 && now.timeIntervalSince(date) < 60
    }
    public var progress: Double? {
      guard let positionTicks, let runtimeTicks, positionTicks.isFinite, runtimeTicks.isFinite,
        positionTicks >= 0, runtimeTicks > 0 else { return nil }
      return min(positionTicks / runtimeTicks, 1)
    }
    public var progressLabel: String {
      func timestamp(_ ticks: Double?) -> String {
        guard let ticks, ticks.isFinite, ticks >= 0, ticks / 10_000_000 < Double(Int.max) else { return "未知" }
        let seconds = Int(ticks / 10_000_000)
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
          : String(format: "%d:%02d", seconds / 60, seconds % 60)
      }
      return "\(timestamp(positionTicks)) / \(timestamp(runtimeTicks))"
    }
  }
  public struct Source: Decodable {
    public let serverId: String
    public let serverName: String
    public let nsfw: Bool
    public let available: Bool
    public var stale: Bool
    public let checkedAt: String?
    public let error: String?
    public let sessions: [Session]
    public let mode: String?
    public let activityStatus: String?
    public let maxAgeSeconds: Double?
    public var isCompatibility: Bool { mode == "activity" }
    public func activityLabel(at now: Date) -> String {
      guard isFresh(at: now) else { return "状态未知" }
      if activityStatus == "activity" {
        let recent = sessions.contains { $0.hasRecentActivity(at: now) }
        return recent ? "检测到播放活动" : "状态未知"
      }
      return ["warming": "观察中，等待连续样本", "no_activity": "未检测到播放活动"][activityStatus ?? ""] ?? "状态未知"
    }
    public func isFresh(at now: Date) -> Bool {
      guard !stale, let checkedAt, let date = ISO8601DateFormatter.withMilliseconds.date(from: checkedAt) else { return false }
      return now.timeIntervalSince(date) >= 0 && now.timeIntervalSince(date) <= (maxAgeSeconds ?? 60)
    }
  }
  public var servers: [Source]
  public mutating func invalidate() {
    for index in servers.indices { servers[index].stale = true }
  }
}
private extension ISO8601DateFormatter {
  static var withMilliseconds: ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }
}
public struct HomeResponse: Decodable {
  public var playback: PlaybackResponse?

  public struct Source: Decodable { public let serverId: String; public let serverName: String; public let kind: String; public let updatedAt: String?; public let error: String?; public let available: Bool; public let stale: Bool }
  public let recent: [Media]
  public let resume: [Media]
  public let sources: [Source]
  public let historyAvailable: Bool
  public let historyNote: String
  public let emptyReason: String?
}
public struct LibraryResponse: Decodable {
  public let items: [Media]
  public let total: Int?
  public let page: Int
  public let pages: Int
  public let servers: [Server]
}
public struct OverviewResponse: Decodable {
  public struct Stats: Decodable {
    public let movies: Int?; public let series: Int?; public let episodes: Int?; public let libraries: Int?
    public let entries: Int?; public let uniqueWorks: Int?; public let duplicateGroups: Int?; public let extraEntries: Int?
    public let complete: Bool; public let historyReason: String
  }
  public struct Library: Decodable, Identifiable { public let id: String; public let serverId: String; public let name: String; public let serverName: String?; public var key: String { "\(serverId):\(id)" } }
  public let servers: [Server]
  public let stats: Stats
  public let views: [Library]
  public let latest: [Media]
  public let resume: [Media]
}
public struct AuthStatus: Decodable { public let initialized: Bool; public let authenticated: Bool; public let passwordRequired: Bool? }
public struct AppSettings: Codable { public var automaticUpdates: Bool; public var offline: Bool?; public var canExitOffline: Bool? }
public struct OK: Decodable { public let ok: Bool }

public func displayDate(_ value: String?) -> String {
  guard let value else { return "时间未知" }
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  var date = formatter.date(from: value)
  if date == nil { formatter.formatOptions = [.withInternetDateTime]; date = formatter.date(from: value) }
  guard let date else { return "时间未知" }
  return date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute().locale(Locale(identifier: "zh_CN")))
}

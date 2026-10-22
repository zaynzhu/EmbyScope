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
}

public func resourceComparison(leftServer: String, rightServer: String, left: Resources?, right: Resources?) -> String {
  guard let left, let right, !left.locations.isEmpty, !right.locations.isEmpty else {
    return "位置证据不足：请逐条核对下方已有路径，或按需读取位置。"
  }
  let stale = left.stale == true || right.stale == true || left.error != nil || right.error != nil
  let prefix = stale ? "旧缓存线索：" : "位置线索："
  let shared = !Set(left.locations.map(\.path)).isDisjoint(with: Set(right.locations.map(\.path)))
  if leftServer != rightServer {
    return prefix + (shared ? "跨服务器出现相同路径文本，不能据此认定共用文件或存了多份。" : "跨服务器路径不同，可能是同一存储的不同映射，也可能是多份资源。")
  }
  return prefix + (shared ? "同服务器记录有重合路径，可能是同一资源被重复入库；其余路径仍需核对。" : "同服务器记录指向不同路径，可能有多份资源或不同版本；需核对文件本体。")
}
public struct Server: Codable, Identifiable, Hashable {
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
    public let positionTicks: Double?
    public let runtimeTicks: Double?
  }
  public struct Source: Decodable {
    public let serverId: String
    public let serverName: String
    public let nsfw: Bool
    public let available: Bool
    public let stale: Bool
    public let checkedAt: String?
    public let error: String?
    public let sessions: [Session]
    public func isFresh(at now: Date) -> Bool {
      guard !stale, let checkedAt, let date = ISO8601DateFormatter.withMilliseconds.date(from: checkedAt) else { return false }
      return now.timeIntervalSince(date) >= 0 && now.timeIntervalSince(date) <= 60
    }
  }
  public let servers: [Source]
}
private extension ISO8601DateFormatter {
  static var withMilliseconds: ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }
}
public struct HomeResponse: Decodable {
  public let playback: PlaybackResponse?

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
public struct AuthStatus: Decodable { public let initialized: Bool; public let authenticated: Bool }
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

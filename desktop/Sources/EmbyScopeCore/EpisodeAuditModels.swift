import Foundation

public struct EpisodeRange: Decodable {
  public let start: Int
  public let end: Int
  public var label: String { start == end ? "E\(start)" : "E\(start)–E\(end)" }
}
public struct EpisodeAuditSource: Decodable {
  public struct Season: Decodable {
    public struct Alternative: Decodable {
      public let serverId: String
      public let seriesId: String
      public let serverName: String
      public let ranges: [EpisodeRange]
    }
    public let number: Int
    public let count: Int
    public let present: [EpisodeRange]
    public let gaps: [EpisodeRange]
    public let missingCount: Int
    public let start: Int?
    public let end: Int?
    public let alternatives: [Alternative]
  }
  public let serverId: String
  public let seriesId: String
  public let title: String
  public let serverName: String
  public let updatedAt: String?
  public let error: String?
  public let stale: Bool
  public let running: Bool
  public let excluded: Int
  public let eligible: Bool
  public let reasons: [String]
  public let seasons: [Season]
  public var key: String { "\(serverId):\(seriesId)" }
}
public struct EpisodeAudit: Decodable {
  public struct Item: Decodable {
    public let key: String
    public let title: String
    public let conflict: Bool
    public let sources: [EpisodeAuditSource]
    public let missingCount: Int
    public let state: String
    public var label: String {
      switch state {
      case "gaps": "发现编号缺口"
      case "continuous": "已检查范围内连续"
      default: "待确认"
      }
    }
  }
  public struct Counts: Decodable { public let gaps: Int; public let unknown: Int; public let continuous: Int }
  public let items: [Item]
  public let total: Int
  public let page: Int
  public let pages: Int
  public let counts: Counts
  public let running: Bool
  public let offline: Bool
  public let knownServers: Int
  public let totalServers: Int
}

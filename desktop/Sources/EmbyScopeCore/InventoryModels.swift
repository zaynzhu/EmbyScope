import Foundation

public struct InventorySnapshot: Decodable {
  public struct Counts: Decodable {
    public let resources: Int?
    public let metadata: Int?
    public let unknown: Int?
  }
  public let servers: [Server]
  public let automaticUpdates: Bool
  public let offline: Bool
  public let knownServers: Int
  public let totalServers: Int
  public let complete: Bool
  public let counts: Counts
}

public struct SyncHistoryResponse: Decodable {
  public let available: Bool
  public let limit: Int
  public let retained: Int
  public let items: [SyncRun]
}
public struct SyncRun: Decodable, Identifiable {
  public struct Step: Decodable {
    public let kind: String
    public let state: String
    public let count: Int?
    public let error: String?
    public var label: String { ["catalog": "完整片库", "views": "媒体库", "latest": "最近入库", "resume": "继续观看", "seasons": "单部剧的季信息"][kind] ?? kind }
  }
  public let id: Int
  public let serverId: String
  public let serverName: String
  public let mode: String
  public let trigger: String
  public let startedAt: String
  public let finishedAt: String?
  public let state: String
  public let steps: [Step]
  public let message: String?
  public var modeLabel: String { ["full": "完整校准", "light": "轻量更新", "seasons": "季集补齐"][mode] ?? mode }
  public var triggerLabel: String { ["manual": "手动", "automatic": "自动", "connection": "连接配置"][trigger] ?? trigger }
  public var stateLabel: String { ["running": "进行中", "completed": "已完成", "partial": "部分完成", "failed": "失败", "cancelled": "已暂停", "interrupted": "已中断", "superseded": "连接已变更"][state] ?? "未知" }
  public var durationLabel: String {
    if state == "interrupted" { return "持续时间未确认" }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let finishedAt, let start = formatter.date(from: startedAt), let end = formatter.date(from: finishedAt) else { return "尚未结束" }
    let seconds = max(0, Int(end.timeIntervalSince(start)))
    return seconds < 60 ? "\(seconds) 秒" : "\(seconds / 60) 分 \(seconds % 60) 秒"
  }
}

import Foundation

public struct DoubanItem: Codable, Identifiable, Hashable {
  public let id: String
  public let type: String
  public let title: String
  public let altTitle: String?
  public let intro: String?
  public let rating: Int?
  public let date: String?
  public let comment: String?
  public let posterUrl: String?
  public let overview: String?
  public let releaseDate: String?
  public let averageRating: Double?
  public let personalRating: Int?
  public let personalComment: String?
  public var typeLabel: String { ["Movie": "电影", "Series": "剧集"][type] ?? "未分类" }
  public var ratingLabel: String { rating.map { String(repeating: "★", count: max(0, min(5, $0))) + " · \($0) / 5" } ?? "未评分" }
  public var commentNeedsReview: Bool {
    guard let comment, let intro else { return false }
    let text = comment.trimmingCharacters(in: .whitespacesAndNewlines)
    return !text.isEmpty && text == intro.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  public var link: URL { URL(string: "https://movie.douban.com/subject/\(id)/")! }
}
public struct DoubanList: Decodable {
  public let items: [DoubanItem]
  public let total: Int
  public let page: Int
  public let pages: Int
}
public struct DoubanStatus: Decodable {
  public struct Run: Decodable {
    public let mode: String
    public let state: String
    public let scanned: Int
    public let pages: Int
    public let imported: Int
    public let updated: Int
    public let skipped: Int
    public let startedAt: String?
    public let finishedAt: String?
    public let error: String?
    public let migrated: Bool?
    public var stateLabel: String {
      ["running": "正在同步", "completed": "已完成", "failed": "失败", "cancelled": "已取消", "interrupted": "已中断"][state] ?? "状态未知"
    }
  }
  public let account: String
  public let checkpoint: String?
  public let importedAt: String?
  public let source: String?
  public let lastRun: Run?
  public let total: Int
  public let movies: Int
  public let series: Int
  public let unknown: Int
  public let syncing: Bool
  public let offline: Bool
  public let canIncremental: Bool
}

import Foundation

public struct TraktStatus: Decodable {
  public struct Device: Decodable {
    public let userCode: String
    public let verificationUrl: String
    public let expiresAt: String
  }
  public struct Counts: Decodable {
    public let recent: Int
    public let watched: Int
    public let playback: Int
  }
  public let posterConfigured: Bool?
  public let automaticSync: Bool?
  public let configured: Bool
  public let connected: Bool
  public let account: String?
  public let state: String
  public let offline: Bool
  public let error: String?
  public let updatedAt: String?
  public let counts: Counts
  public let device: Device?
  public var busy: Bool { state != "idle" }
}

public struct TraktItem: Decodable, Identifiable {
  public let id: String
  public let type: String
  public let title: String
  public let year: Int?
  public let showTitle: String?
  public let season: Int?
  public let episode: Int?
  public let watchedAt: String?
  public let pausedAt: String?
  public let progress: Double?
  public let plays: Int?
  public let posterPath: String?
  public var displayTitle: String { showTitle ?? title }
  public var subtitle: String {
    if type == "episode" {
      let number = "第 \(episode ?? 0) 集"
      let position = "第 \(season ?? 0) 季 · \(number)"
      return title == number ? position : "\(position) · \(title)"
    }
    return year.map { "电影 · \($0)" } ?? "电影"
  }
}

public struct TraktList: Decodable {
  public let items: [TraktItem]
  public let total: Int
  public let page: Int
  public let pages: Int
  public let updatedAt: String?
  public let available: Bool
}

public struct TraktHome: Decodable {
  public let status: TraktStatus
  public let recent: [TraktItem]
  public let playback: [TraktItem]
}

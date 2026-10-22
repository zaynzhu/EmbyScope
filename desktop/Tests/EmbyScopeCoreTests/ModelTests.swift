import Foundation
import Testing
@testable import EmbyScopeCore

struct ModelTests {
  func media(_ fields: [String: Any]) throws -> Media {
    try JSONDecoder().decode(Media.self, from: JSONSerialization.data(withJSONObject: fields))
  }
  @Test func testCompositeIdentityAndUnknownProgress() throws {
    let a = try media(["id": "same", "serverId": "a", "title": "电影"])
    let b = try media(["id": "same", "serverId": "b", "title": "电影"])
    #expect(a.key != b.key)
    #expect(a.progress == nil)
    #expect(try media(["id": "x", "serverId": "a", "title": "电影", "runtimeTicks": 0, "positionTicks": 0]).progress == nil)
    #expect(try media(["id": "x", "serverId": "a", "title": "电影", "runtimeTicks": 100, "positionTicks": 150]).progress == 1)
  }
  @Test func testSensitiveSourceProtectsAggregatedPoster() throws {
    let movie = try media(["id": "x", "serverId": "a", "title": "电影", "nsfw": false, "sources": [["id": "x", "serverId": "b", "title": "电影", "nsfw": true]]])
    #expect(movie.sensitive)
  }
  @Test func testPathKeepsItemAsOneComponent() async throws {
    let item = try media(["id": "a/b?中文", "serverId": "server", "title": "电影"])
    let client = APIClient(port: 1234, key: "fixture")
    let path = await client.itemPath(item)
    #expect(path == "api/items/server/a%2Fb%3F%E4%B8%AD%E6%96%87")
  }
  @Test func testPlaceholderMetadataIsHidden() throws {
    let item = try media(["id": "x", "serverId": "a", "title": "电影", "year": 0, "rating": 0, "type": "Movie"])
    #expect(item.metadata == "电影")
    let valid = try media(["id": "x", "serverId": "a", "title": "电影", "year": 2026, "rating": 8.5, "type": "Movie"])
    #expect(valid.metadata == "2026  ·  电影  ·  8.5 分")
  }
  @Test func testPlaybackSnapshotExpiresAndAcceptsMissingProxy() throws {
    let now = Date(timeIntervalSince1970: 1792560000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let data: [String: Any] = ["serverId": "a", "serverName": "甲", "nsfw": false, "available": true, "stale": false, "checkedAt": formatter.string(from: now), "sessions": []]
    let source = try JSONDecoder().decode(PlaybackResponse.Source.self, from: JSONSerialization.data(withJSONObject: data))
    #expect(source.isFresh(at: now.addingTimeInterval(30)))
    #expect(!source.isFresh(at: now.addingTimeInterval(61)))
    #expect(!source.isFresh(at: now.addingTimeInterval(-1)))
  }
  @Test func testPlaybackProgressUsesReportedValuesOnly() throws {
    func session(_ position: Double?, _ duration: Double?) throws -> PlaybackResponse.Session {
      var fields: [String: Any] = ["id": "session", "itemId": "item", "title": "模拟播放", "state": "playing"]
      fields["positionTicks"] = position
      fields["runtimeTicks"] = duration
      return try JSONDecoder().decode(PlaybackResponse.Session.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    let valid = try session(87529109941, 97129040000)
    #expect(valid.progressLabel == "2:25:52 / 2:41:52")
    #expect(valid.progress != nil && valid.progress! > 0.9)
    #expect(try session(nil, 600000000).progress == nil)
    #expect(try session(nil, nil).progressLabel == "未知 / 未知")
    #expect(try session(0, 0).progress == nil)
    #expect(try session(-1, 100).progress == nil)
    #expect(try session(200, 100).progress == 1)
    #expect(try session(0, 600000000).progressLabel == "0:00 / 1:00")
  }
  @Test func testUnknownDateIsNotFabricated() {
    #expect(displayDate(nil) == "时间未知")
    #expect(displayDate("not-a-date") == "时间未知")
    #expect(displayDate("2026-10-20T12:00:00.000Z") != "时间未知")
  }
  @Test func compatibilityLabelsNeverClaimPlayingOrStoppedAndExpireLocally() throws {
    let now = Date(timeIntervalSince1970: 1792560000)
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    func source(_ status: String, observed: Date = now, stale: Bool = false) throws -> PlaybackResponse.Source {
      let data: [String: Any] = ["serverId": "a", "serverName": "极影视", "nsfw": false,
        "mode": "activity", "activityStatus": status, "available": true, "stale": stale,
        "maxAgeSeconds": 35, "checkedAt": formatter.string(from: now),
        "sessions": status == "activity" ? [["id": "x", "itemId": "x", "title": "模拟片名", "state": "activity", "observedAt": formatter.string(from: observed)]] : []]
      return try JSONDecoder().decode(PlaybackResponse.Source.self, from: JSONSerialization.data(withJSONObject: data))
    }
    #expect(try source("warming").activityLabel(at: now) == "观察中，等待连续样本")
    #expect(try source("no_activity").activityLabel(at: now) == "未检测到播放活动")
    #expect(try source("unknown").activityLabel(at: now) == "状态未知")
    #expect(try source("activity").activityLabel(at: now) == "检测到播放活动")
    #expect(try source("activity").sessions[0].progress == nil)
    #expect(try source("activity").activityLabel(at: now.addingTimeInterval(36)) == "状态未知")
    #expect(try source("activity", observed: now.addingTimeInterval(-60)).activityLabel(at: now) == "状态未知")
    #expect(try source("activity", stale: true).activityLabel(at: now) == "状态未知")
    #expect(try source("activity", observed: now.addingTimeInterval(1)).activityLabel(at: now) == "状态未知")
  }
  @Test func testResourceEvidenceDoesNotClaimPhysicalCopies() throws {
    func resource(_ path: String, stale: Bool = false) throws -> Resources {
      try JSONDecoder().decode(Resources.self, from: JSONSerialization.data(withJSONObject: [
        "locations": [["path": path, "label": "位置"]], "hiddenRemote": false, "stale": stale
      ]))
    }
    let local = try resource("/media/video.strm")
    #expect(resourceComparison(leftServer: "a", rightServer: "a", left: local, right: local).contains("重复入库"))
    #expect(resourceComparison(leftServer: "a", rightServer: "b", left: local, right: local).contains("不能据此认定"))
    #expect(resourceComparison(leftServer: "a", rightServer: "a", left: local, right: try resource("/other/video.strm", stale: true)).hasPrefix("旧缓存线索"))
    #expect(resourceComparison(leftServer: "a", rightServer: "b", left: local, right: nil).contains("证据不足"))
    let directory = try resource("/media/series")
    #expect(resourceComparison(leftServer: "a", rightServer: "a", left: directory, right: directory).contains("目录或未知类型"))
    #expect(!resourceComparison(leftServer: "a", rightServer: "a", left: directory, right: directory).contains("重复入库"))
    #expect(resourceComparison(leftServer: "a", rightServer: "a", left: directory, right: local).contains("证据不足"))
    let namedDirectory = try resource("/media/movie.mkv/")
    #expect(resourceComparison(leftServer: "a", rightServer: "a", left: namedDirectory, right: namedDirectory).contains("目录或未知类型"))
    let mixed = try JSONDecoder().decode(Resources.self, from: JSONSerialization.data(withJSONObject: [
      "locations": [["path": "/media/series", "label": "目录"], ["path": "/media/a.mkv", "label": "文件"]], "hiddenRemote": false
    ]))
    #expect(!resourceComparison(leftServer: "a", rightServer: "a", left: mixed, right: directory).contains("重复入库"))
    #expect(resourceComparison(leftServer: "a", rightServer: "a", left: mixed, right: try resource("/media/b.mkv")).contains("未确认有多份"))
  }
  @Test func testSupplementalEvidenceSurvivesDetailDecoding() throws {
    let item = try media(["id": "a", "serverId": "s", "title": "电影", "comparison": [
      "label": "元数据待核对", "reasons": ["编号未关联"], "counts": ["candidate": 0, "distinct": 0, "unknown": 1],
      "hasMetadata": true, "supplemental": true, "truncated": false,
      "pairs": [["leftKey": "s:a", "rightKey": "s:b", "kind": "unknown", "reason": "不能推定同一作品", "basis": ["完整标题及年份相同"]]]
    ]])
    #expect(item.comparison?.supplemental == true)
    #expect(item.comparison?.pairs.first?.basis == ["完整标题及年份相同"])
    #expect(item.comparison?.counts.candidate == 0)
  }
}

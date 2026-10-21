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
  @Test func testUnknownDateIsNotFabricated() {
    #expect(displayDate(nil) == "时间未知")
    #expect(displayDate("not-a-date") == "时间未知")
    #expect(displayDate("2026-10-20T12:00:00.000Z") != "时间未知")
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
  }
}

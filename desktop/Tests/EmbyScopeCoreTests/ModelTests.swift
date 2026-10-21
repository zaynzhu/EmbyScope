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
  @Test func testUnknownDateIsNotFabricated() {
    #expect(displayDate(nil) == "时间未知")
    #expect(displayDate("not-a-date") == "时间未知")
    #expect(displayDate("2026-10-20T12:00:00.000Z") != "时间未知")
  }
}

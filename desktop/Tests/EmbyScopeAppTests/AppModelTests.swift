import Foundation
import Testing
@testable import EmbyScopeApp
import EmbyScopeCore

// 所有请求由 URLProtocol 截获，测试不会访问本机端口或 NAS。
private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
  static let lock = NSLock()
  static var handler: ((FixtureProtocol) -> Void)?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.lock.lock()
    let callback = Self.handler
    Self.lock.unlock()
    callback?(self)
  }
  override func stopLoading() {}
  func respond(_ object: Any, status: Int = 200) {
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: object))
    client?.urlProtocolDidFinishLoading(self)
  }
}

private actor Requests {
  private var queued: [FixtureProtocol] = []
  private var waiting: [CheckedContinuation<FixtureProtocol, Never>] = []
  func receive(_ request: FixtureProtocol) {
    if waiting.isEmpty { queued.append(request) }
    else { waiting.removeFirst().resume(returning: request) }
  }
  func next() async -> FixtureProtocol {
    if !queued.isEmpty { return queued.removeFirst() }
    return await withCheckedContinuation { waiting.append($0) }
  }
}

@Suite(.serialized) @MainActor
struct AppModelTests {
  private func fixture() -> (AppModel, Requests) {
    let requests = Requests()
    FixtureProtocol.lock.lock()
    FixtureProtocol.handler = { request in Task { await requests.receive(request) } }
    FixtureProtocol.lock.unlock()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [FixtureProtocol.self]
    let model = AppModel()
    model.client = APIClient(port: 1, key: "fixture", configuration: configuration)
    model.authenticated = true
    return (model, requests)
  }
  private func media(_ title: String) throws -> Media {
    try JSONDecoder().decode(Media.self, from: JSONSerialization.data(withJSONObject: ["id": "same", "serverId": "a", "title": title, "type": "Series"]))
  }
  private func library(_ title: String, page: Int = 1) -> [String: Any] {
    ["items": [["id": "same", "serverId": "a", "title": title]], "total": 1, "page": page, "pages": page, "servers": []]
  }

  private func playbackHome() throws -> HomeResponse {
    try JSONDecoder().decode(HomeResponse.self, from: JSONSerialization.data(withJSONObject: [
      "recent": [], "resume": [], "sources": [], "historyAvailable": false, "historyNote": "保留首页内容"
    ]))
  }
  private func traktStatus(updatedAt: String? = nil, account: String = "fixture-user") -> [String: Any] {
    var value: [String: Any] = ["configured": true, "connected": true, "account": account, "state": "idle", "offline": false, "counts": ["recent": 1, "watched": 1, "playback": 1]]
    if let updatedAt { value["updatedAt"] = updatedAt }
    return value
  }
  private func traktList(_ title: String, page: Int = 1) -> [String: Any] {
    ["items": [["id": "movie:1", "title": title, "type": "movie"]], "page": page, "pages": 3, "total": 60, "available": true]
  }
  @Test func traktHomeRejectsOldResponseAfterClearAndKeepsSnapshotOnFailure() async {
    let (app, requests) = fixture()
    let snapshot: [String: Any] = ["status": traktStatus(), "recent": [["id": "movie:1", "title": "首页电影", "type": "movie", "posterPath": "api/trakt/posters/movies/1"]], "playback": []]
    let first = Task { await app.trakt.loadHome(app.client!) }
    let request = await requests.next()
    request.respond(snapshot)
    await first.value
    #expect(app.trakt.home?.recent.first?.posterPath == "api/trakt/posters/movies/1")
    let failed = Task { await app.trakt.loadHome(app.client!) }
    let failedRequest = await requests.next()
    failedRequest.respond(["error": "模拟读取失败"], status: 503)
    await failed.value
    #expect(app.trakt.home?.recent.first?.title == "首页电影")
    #expect(app.trakt.homeError == "模拟读取失败")
    let stale = Task { await app.trakt.loadHome(app.client!) }
    let staleRequest = await requests.next()
    app.trakt.clear()
    staleRequest.respond(snapshot)
    await stale.value
    #expect(app.trakt.home == nil)
    #expect(app.trakt.status == nil)
  }

  @Test func traktRefreshKeepsPageAndFilterChangesResetPage() async {
    let (app, requests) = fixture()
    let first = Task { await app.trakt.load(app.client!, page: 2) }
    let request = await requests.next()
    request.respond(traktList("第二页", page: 2))
    await first.value
    let refresh = Task { await app.trakt.refreshList(app.client!) }
    let refreshRequest = await requests.next()
    #expect(refreshRequest.request.url?.query?.contains("page=2") == true)
    refreshRequest.respond(traktList("刷新后的第二页", page: 2))
    await refresh.value
    app.trakt.kind = "playback"
    let filtered = Task { await app.trakt.refreshList(app.client!) }
    let filterRequest = await requests.next()
    #expect(filterRequest.request.url?.query?.contains("page=1") == true)
    #expect(filterRequest.request.url?.query?.contains("kind=playback") == true)
    #expect(app.trakt.result == nil)
    filterRequest.respond(traktList("续播第一页"))
    await filtered.value
    #expect(app.trakt.result?.items.first?.title == "续播第一页")
  }
  @Test func traktOldResponseCannotReplaceFilterOrClearedSession() async {
    let (app, requests) = fixture()
    let first = Task { await app.trakt.load(app.client!) }
    let oldRequest = await requests.next()
    app.trakt.query = "新筛选"
    let second = Task { await app.trakt.refreshList(app.client!) }
    let newRequest = await requests.next()
    newRequest.respond(traktList("新的记录"))
    await second.value
    oldRequest.respond(traktList("旧的记录"))
    await first.value
    #expect(app.trakt.result?.items.first?.title == "新的记录")
    let status = Task { await app.trakt.loadStatus(app.client!) }
    let statusRequest = await requests.next()
    app.trakt.clear()
    statusRequest.respond(traktStatus())
    await status.value
    #expect(app.trakt.status == nil)
    #expect(app.trakt.result == nil)
  }
  @Test func traktStatusFailureKeepsSnapshotAndChangedAccountClearsList() async {
    let (app, requests) = fixture()
    let status = Task { await app.trakt.loadStatus(app.client!) }
    let statusRequest = await requests.next()
    statusRequest.respond(traktStatus(updatedAt: "2026-10-24T12:00:00Z"))
    await status.value
    let list = Task { await app.trakt.load(app.client!) }
    let listRequest = await requests.next()
    listRequest.respond(traktList("原账号记录"))
    await list.value
    let failed = Task { await app.trakt.loadStatus(app.client!) }
    let failureRequest = await requests.next()
    failureRequest.respond(["error": "模拟读取失败"], status: 500)
    await failed.value
    #expect(app.trakt.status?.account == "fixture-user")
    #expect(app.trakt.result?.items.first?.title == "原账号记录")
    #expect(app.trakt.statusError == "模拟读取失败")
    let changed = Task { await app.trakt.loadStatus(app.client!) }
    let changedRequest = await requests.next()
    changedRequest.respond(traktStatus(account: "other-user"))
    await changed.value
    #expect(app.trakt.result == nil)
    #expect(app.trakt.statusError == nil)
  }
  @Test func inventoryScopeChangeRejectsOldResponsesAndClearsOnSessionEnd() async {
    let (model, requests) = fixture()
    let first = Task { await model.inventory.load(model.client!, server: "a") }
    let oldRequest = await requests.next()
    #expect(oldRequest.request.url?.path == "/api/inventory")
    let second = Task { await model.inventory.load(model.client!, server: "b") }
    let newRequest = await requests.next()
    newRequest.respond(["servers": [], "automaticUpdates": false, "offline": true, "knownServers": 1, "totalServers": 1, "complete": true, "counts": ["resources": 7, "metadata": 0, "unknown": 0]])
    await second.value
    oldRequest.respond(["error": "旧范围失败"], status: 500)
    await first.value
    #expect(model.inventory.snapshot?.counts.resources == 7)
    #expect(model.inventory.error == nil)
    let history = Task { await model.inventory.loadHistory(model.client!, server: "b") }
    let historyRequest = await requests.next()
    #expect(historyRequest.request.url?.path == "/api/sync-history")
    #expect(historyRequest.request.httpMethod == "GET")
    model.inventory.clear()
    historyRequest.respond(["available": true, "limit": 100, "retained": 2000, "items": []])
    await history.value
    #expect(model.inventory.history == nil)
    #expect(model.inventory.snapshot == nil)
  }
  @Test func serverSwitchDoesNotDiscardAlreadyStartedInventoryRequest() async {
    let (model, requests) = fixture()
    let client = model.client!
    model.server = "b"
    let pending = Task { await model.inventory.load(client, server: model.server) }
    let request = await requests.next()
    // 模拟视图先启动新范围请求，随后异步执行切服清理。
    model.client = nil
    await model.switchServer()
    request.respond(["servers": [], "automaticUpdates": false, "offline": true, "knownServers": 1, "totalServers": 1, "complete": true, "counts": ["resources": 7, "metadata": 0, "unknown": 0]])
    await pending.value
    #expect(model.inventory.snapshot?.counts.resources == 7)
    model.server = "c"
    #expect(model.inventory.snapshot == nil)
  }
  @Test func issueShortcutUsesExistingReviewAndKeepsServerAndDoubanState() async {
    let (model, requests) = fixture()
    model.server = "selected-server"
    model.query = "原搜索"
    model.mediaType = "Series"
    model.libraryPage = 4
    model.douban.query = "独立豆瓣搜索"
    model.openReview("metadata")
    let request = await requests.next()
    let params = URLComponents(url: request.request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    #expect(params.contains(URLQueryItem(name: "review", value: "metadata")))
    #expect(params.contains(URLQueryItem(name: "server", value: "selected-server")))
    #expect(params.contains(URLQueryItem(name: "page", value: "1")))
    request.respond(library("待核对"))
    #expect(model.page == .duplicates)
    #expect(model.query.isEmpty && model.mediaType.isEmpty)
    #expect(model.douban.query == "独立豆瓣搜索")
  }
  @Test func doubanPaginationFailureKeepsOriginalPageAndRetryPosition() async {
    let (model, requests) = fixture()
    let first = Task { await model.douban.load(model.client!) }
    let firstRequest = await requests.next()
    #expect(firstRequest.request.url?.path == "/api/douban/items")
    firstRequest.respond(["items": [["id": "1", "type": "Movie", "title": "原记录"]], "total": 30, "page": 1, "pages": 2])
    await first.value
    let next = Task { await model.douban.load(model.client!, page: 2) }
    let nextRequest = await requests.next()
    nextRequest.respond(["error": "分页失败"], status: 500)
    await next.value
    #expect(model.douban.result?.page == 1)
    #expect(model.douban.result?.items.first?.title == "原记录")
    #expect(model.douban.error == "分页失败")
    #expect(model.douban.retryPage == 2)
  }
  @Test func doubanOldSearchAndClearedSessionCannotOverwriteNewResults() async {
    let (model, requests) = fixture()
    let old = Task { await model.douban.load(model.client!) }
    let oldRequest = await requests.next()
    model.douban.query = "新搜索"
    let new = Task { await model.douban.load(model.client!, clearResults: true) }
    let newRequest = await requests.next()
    newRequest.respond(["items": [["id": "2", "type": "Unknown", "title": "新结果"]], "total": 1, "page": 1, "pages": 1])
    await new.value
    oldRequest.respond(["error": "过时的错误"], status: 500)
    await old.value
    #expect(model.douban.result?.items.first?.title == "新结果")
    #expect(model.douban.error == nil)
    let pending = Task { await model.douban.load(model.client!) }
    let pendingRequest = await requests.next()
    model.douban.clear()
    pendingRequest.respond(["items": [], "total": 0, "page": 1, "pages": 1])
    await pending.value
    #expect(model.douban.result == nil)
  }
  private func doubanStatus(total: Int = 30, state: String = "running", run: String = "first", cached: Int = 0) -> [String: Any] {
    ["account": "fixture", "total": total, "movies": total, "series": 0, "unknown": 0,
      "syncing": state == "running", "offline": false, "canIncremental": true,
      "lastRun": ["mode": "incremental", "state": state, "scanned": 1, "pages": 1, "imported": 0, "updated": 1, "skipped": 0,
        "startedAt": run, "finishedAt": state == "running" ? NSNull() : (run + "-end") as Any],
      "posters": ["missing": total - cached, "cached": cached, "mirrored": 0, "pendingMirror": 0, "s3Configured": false, "running": cached < total]]
  }
  @Test func doubanSuccessfulCommitRefreshesEvenWithoutNewItemsButPosterProgressDoesNot() async {
    let (app, requests) = fixture()
    let model = app.douban
    func status(_ value: [String: Any]) async {
      let task = Task { await model.loadStatus(app.client!) }
      let request = await requests.next()
      #expect(request.request.url?.path == "/api/douban/status")
      request.respond(value)
      await task.value
    }
    await status(doubanStatus())
    let baseline = model.listRevision
    await status(doubanStatus(cached: 1))
    #expect(model.listRevision == baseline)
    await status(doubanStatus(state: "completed", cached: 1))
    #expect(model.listRevision == baseline + 1)
    await status(doubanStatus(state: "completed", cached: 2))
    #expect(model.listRevision == baseline + 1)
    await status(doubanStatus(state: "completed", run: "second", cached: 2))
    #expect(model.listRevision == baseline + 2)
    await status(doubanStatus(total: 31, state: "completed", run: "third", cached: 2))
    #expect(model.listRevision == baseline + 3)
    await status(doubanStatus(total: 31, state: "failed", run: "fourth", cached: 2))
    #expect(model.listRevision == baseline + 3)
  }
  @Test func doubanRefreshKeepsPageAndFiltersAndOnlyNewSearchResetsPage() async {
    let (app, requests) = fixture()
    let model = app.douban
    model.query = "原搜索"; model.type = "Movie"
    let first = Task { await model.load(app.client!, page: 2) }
    let firstRequest = await requests.next()
    firstRequest.respond(["items": [["id": "1", "type": "Movie", "title": "原搜索"]], "total": 30, "page": 2, "pages": 2])
    await first.value
    let refresh = Task { await model.refreshList(app.client!) }
    let refreshRequest = await requests.next()
    let params = URLComponents(url: refreshRequest.request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
    #expect(params.contains(URLQueryItem(name: "page", value: "2")))
    #expect(params.contains(URLQueryItem(name: "q", value: "原搜索")))
    #expect(params.contains(URLQueryItem(name: "type", value: "Movie")))
    refreshRequest.respond(["items": [["id": "1", "type": "Movie", "title": "原搜索", "comment": "补充短评"]], "total": 31, "page": 2, "pages": 2])
    await refresh.value
    #expect(model.result?.items.first?.comment == "补充短评")
    #expect(model.result?.total == 31)
    model.query = "新搜索"
    let search = Task { await model.refreshList(app.client!) }
    let searchRequest = await requests.next()
    #expect(model.result == nil)
    #expect(URLComponents(url: searchRequest.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(URLQueryItem(name: "page", value: "1")) == true)
    searchRequest.respond(["items": [], "total": 0, "page": 1, "pages": 1])
    await search.value
    #expect(model.query == "新搜索" && model.type == "Movie")
  }
  @Test func doubanCommitDuringListReadCannotBeOverwrittenByOlderSnapshot() async {
    let (app, requests) = fixture()
    let initial = Task { await app.douban.load(app.client!) }
    let initialRequest = await requests.next()
    initialRequest.respond(["items": [], "total": 30, "page": 1, "pages": 2])
    await initial.value
    let old = Task { await app.douban.load(app.client!, page: 2) }
    let oldRequest = await requests.next()
    let sync = Task { await app.douban.loadStatus(app.client!) }
    let statusRequest = await requests.next()
    statusRequest.respond(doubanStatus(state: "completed"))
    await sync.value
    let current = Task { await app.douban.refreshList(app.client!) }
    let newRequest = await requests.next()
    #expect(URLComponents(url: newRequest.request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(URLQueryItem(name: "page", value: "2")) == true)
    newRequest.respond(["items": [["id": "2", "type": "Movie", "title": "同步后的记录"]], "total": 31, "page": 2, "pages": 2])
    await current.value
    oldRequest.respond(["items": [], "total": 0, "page": 1, "pages": 1])
    await old.value
    #expect(app.douban.result?.items.first?.id == "2")
    #expect(app.douban.result?.total == 31)
    #expect(app.douban.result?.page == 2)
  }
  @Test func doubanStatusFailureRetainsSnapshotAndLateResponseAfterClearIsIgnored() async {
    let (app, requests) = fixture()
    let first = Task { await app.douban.loadStatus(app.client!) }
    let firstRequest = await requests.next()
    firstRequest.respond(doubanStatus())
    await first.value
    let revision = app.douban.listRevision
    let failing = Task { await app.douban.loadStatus(app.client!) }
    let failedRequest = await requests.next()
    failedRequest.respond(["error": "模拟状态读取失败"], status: 500)
    await failing.value
    #expect(app.douban.status?.syncing == true)
    #expect(app.douban.statusError == "模拟状态读取失败")
    #expect(app.douban.listRevision == revision)
    let pending = Task { await app.douban.loadStatus(app.client!) }
    let lateRequest = await requests.next()
    app.douban.clear()
    let clearedRevision = app.douban.listRevision
    lateRequest.respond(doubanStatus(state: "completed"))
    await pending.value
    #expect(app.douban.status == nil && app.douban.statusError == nil)
    #expect(app.douban.listRevision == clearedRevision)
  }
  @Test func serverStatusReadsOnlyLocalStateAndPreservesItOnFailure() async throws {
    let (model, requests) = fixture()
    model.automaticUpdates = true
    model.home = try playbackHome()
    let task = Task { await model.loadServerStatus() }
    let request = await requests.next()
    #expect(request.request.url?.path == "/api/servers")
    #expect(request.request.httpMethod == "GET")
    request.respond([["id": "a", "name": "模拟服务器", "url": "http://example.invalid", "status": "online", "nsfw": false,
      "lightMinutes": 60, "fullHours": 24, "syncing": false, "attemptedAt": "2026-10-23T05:13:00.000Z", "datasets": [:]]])
    await task.value
    #expect(model.servers.first?.attemptedAt == "2026-10-23T05:13:00.000Z")
    #expect(model.automaticUpdates)
    #expect(model.home?.historyNote == "保留首页内容")
    let failing = Task { await model.loadServerStatus() }
    let failedRequest = await requests.next()
    failedRequest.respond(["error": "模拟本地读取失败"], status: 500)
    await failing.value
    #expect(model.servers.first?.id == "a")
    #expect(model.serverStatusError?.contains("保留上次结果") == true)
  }
  @Test func olderServerStatusCannotOverwriteNewerRead() async {
    let (model, requests) = fixture()
    let old = Task { await model.loadServerStatus() }
    let oldRequest = await requests.next()
    let new = Task { await model.loadServerStatus() }
    let newRequest = await requests.next()
    newRequest.respond([])
    await new.value
    oldRequest.respond(["error": "过时的错误"], status: 500)
    await old.value
    #expect(model.serverStatusError == nil)
  }
  @Test func passwordSettingUsesLocalEndpointAndRetainsStateOnFailure() async throws {
    let (model, requests) = fixture()
    let task = Task { try await model.setPasswordRequired(true, password: "fixture-password") }
    let request = await requests.next()
    #expect(request.request.url?.path == "/api/auth/desktop-lock")
    #expect(request.request.httpMethod == "PUT")
    request.respond(["initialized": true, "authenticated": true, "passwordRequired": true])
    try await task.value
    #expect(model.passwordRequired)
    #expect(model.initialized)
    let failing = Task { try await model.setPasswordRequired(false) }
    let failedRequest = await requests.next()
    failedRequest.respond(["error": "模拟失败"], status: 500)
    do { try await failing.value; Issue.record("失败不应成功返回") } catch {}
    #expect(model.passwordRequired)
    #expect(model.authenticated)
  }
  @Test func lockingWithoutPasswordDoesNotHideHome() async {
    let (model, _) = fixture()
    await model.lock()
    #expect(model.authenticated)
  }
  @Test func playbackUpdatesOnlyItsSnapshotWithoutReloadingCatalog() async throws {
    let (model, requests) = fixture()
    model.home = try playbackHome()
    let task = Task { await model.refreshPlayback() }
    let request = await requests.next()
    #expect(request.request.url?.path == "/api/playback/refresh")
    #expect(request.request.httpMethod == "POST")
    request.respond(["ok": true, "servers": []])
    await task.value
    #expect(model.home?.playback != nil)
    #expect(model.home?.historyNote == "保留首页内容")
    #expect(!model.playbackLoading)
    #expect(!model.automaticUpdates)
  }
  @Test func playbackFromPreviousServerDoesNotOverwriteCurrentScope() async throws {
    let (model, requests) = fixture()
    model.home = try playbackHome()
    model.server = "a"
    let task = Task { await model.refreshPlayback() }
    let request = await requests.next()
    model.server = "b"
    request.respond(["ok": true, "servers": []])
    await task.value
    #expect(model.home?.playback == nil)
    #expect(!model.playbackLoading)
  }
  @Test func changingCompatibilityModeDiscardsPreviousResponse() async throws {
    let (model, requests) = fixture()
    model.home = try playbackHome()
    #expect(model.playbackCompatibility.isEmpty)
    model.playbackCompatibility = ["zspace"]
    let task = Task { await model.refreshPlayback(observationId: "test-observation") }
    let request = await requests.next()
    model.playbackCompatibility = []
    request.respond(["ok": true, "servers": []])
    await task.value
    #expect(model.home?.playback == nil)
    #expect(!model.automaticUpdates)
  }
  @Test func failedPlaybackReadInvalidatesPreviouslyFreshSnapshot() async throws {
    let (model, requests) = fixture()
    model.home = try playbackHome()
    model.home?.playback = try JSONDecoder().decode(PlaybackResponse.self, from: JSONSerialization.data(withJSONObject: [
      "servers": [["serverId": "a", "serverName": "模拟", "nsfw": false, "available": true, "stale": false, "sessions": []]]
    ]))
    let task = Task { await model.refreshPlayback() }
    let request = await requests.next()
    request.respond(["error": "模拟读取失败"], status: 503)
    await task.value
    #expect(model.home?.playback?.servers[0].stale == true)
    #expect(model.error != nil)
  }

  @Test func pageClampedByBackendUpdatesNavigation() async {
    let (model, requests) = fixture()
    model.page = .library
    model.libraryPage = 5
    let task = Task { await model.loadLibrary() }
    let request = await requests.next()
    request.respond(library("缩小后的片库", page: 2))
    await task.value
    #expect(model.library?.page == 2)
    #expect(model.libraryPage == 2)
  }

  @Test func latestLibraryRequestWinsEvenWithSameFilters() async {
    let (model, requests) = fixture()
    model.page = .library
    let old = Task { await model.loadLibrary() }
    let oldRequest = await requests.next()
    let new = Task { await model.loadLibrary() }
    let newRequest = await requests.next()
    newRequest.respond(library("较新数据"))
    await new.value
    oldRequest.respond(library("旧数据"))
    await old.value
    #expect(model.library?.items.first?.title == "较新数据")
  }

  @Test func latestSeasonWinsWhenResponsesArriveOutOfOrder() async throws {
    let (model, requests) = fixture()
    model.selected = try media("电视剧")
    let first = Task { await model.loadEpisodes(page: 1, season: "1") }
    let firstRequest = await requests.next()
    let second = Task { await model.loadEpisodes(page: 1, season: "2") }
    let secondRequest = await requests.next()
    secondRequest.respond(["id": "same", "serverId": "a", "title": "第二季结果"])
    await second.value
    firstRequest.respond(["id": "same", "serverId": "a", "title": "第一季旧结果"])
    await first.value
    #expect(model.detail?.title == "第二季结果")
  }

  @Test func obsoleteFailureDoesNotReplaceSuccessfulResult() async {
    let (model, requests) = fixture()
    model.page = .library
    let old = Task { await model.loadLibrary() }
    let oldRequest = await requests.next()
    model.query = "新搜索"
    let new = Task { await model.loadLibrary() }
    let newRequest = await requests.next()
    newRequest.respond(library("新搜索结果"))
    await new.value
    oldRequest.respond(["error": "旧请求失败"], status: 500)
    await old.value
    #expect(model.error == nil)
    #expect(model.library?.items.first?.title == "新搜索结果")
  }

  @Test func navigatingClearsDetailAndDuplicatePagination() throws {
    let (model, _) = fixture()
    model.page = .library
    model.libraryPage = 5
    model.selected = try media("已打开的详情")
    model.navigate(to: .duplicates)
    #expect(model.libraryPage == 1)
    #expect(model.selected == nil)
    model.libraryPage = 2
    model.navigate(to: .library)
    #expect(model.libraryPage == 1)
    model.libraryPage = 3
    model.navigate(to: .home)
    model.navigate(to: .library)
    #expect(model.libraryPage == 3)
  }

  @Test func closedDetailRejectsPendingSeasonResponse() async throws {
    let (model, requests) = fixture()
    model.selected = try media("电视剧")
    let task = Task { await model.loadEpisodes(page: 1, season: "1") }
    let request = await requests.next()
    model.closeDetail()
    request.respond(["id": "same", "serverId": "a", "title": "已关闭的旧结果"])
    await task.value
    #expect(model.detail == nil)
    #expect(!model.detailLoading)
  }
  @Test func exitingOfflineKeepsAutomaticUpdatesOffAndOnlyReloadsLocalSnapshots() async {
    let (model, requests) = fixture()
    model.offline = true
    model.canExitOffline = true
    model.page = .settings
    let task = Task { await model.exitOffline() }
    let exit = await requests.next()
    #expect(exit.request.url?.path == "/api/settings/exit-offline")
    #expect(exit.request.httpMethod == "POST")
    exit.respond(["automaticUpdates": false, "offline": false, "canExitOffline": false])
    let servers = await requests.next()
    #expect(servers.request.url?.path == "/api/servers")
    #expect(servers.request.httpMethod == "GET")
    servers.respond([])
    let settings = await requests.next()
    #expect(settings.request.url?.path == "/api/settings")
    settings.respond(["automaticUpdates": false, "offline": false, "canExitOffline": false])
    let home = await requests.next()
    #expect(home.request.url?.path == "/api/home")
    home.respond(["recent": [], "resume": [], "sources": [], "historyAvailable": false, "historyNote": "模拟"])
    let overview = await requests.next()
    #expect(overview.request.url?.path == "/api/overview")
    overview.respond(["servers": [], "stats": ["complete": false, "historyReason": "模拟"], "views": [], "latest": [], "resume": []])
    await task.value
    #expect(!model.offline)
    #expect(!model.automaticUpdates)
    #expect(!model.canExitOffline)
    #expect(!model.exitingOffline)
    #expect(model.error == nil)
  }
  @Test func failedExitKeepsOfflineAndReportsError() async {
    let (model, requests) = fixture()
    model.offline = true
    model.canExitOffline = true
    let task = Task { await model.exitOffline() }
    let request = await requests.next()
    request.respond(["error": "无法保存模式"], status: 409)
    await task.value
    #expect(model.offline)
    #expect(!model.exitingOffline)
    #expect(model.error == "无法保存模式")
  }
}

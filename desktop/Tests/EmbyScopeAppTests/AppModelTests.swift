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
  func respond(_ object: [String: Any], status: Int = 200) {
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
}

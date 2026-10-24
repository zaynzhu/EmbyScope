import Foundation
import Observation
import EmbyScopeCore

@MainActor @Observable
final class DoubanModel {
  var result: DoubanList?
  var status: DoubanStatus?
  var query = ""
  var type = ""
  var loading = false
  var retryPage = 1
  var saving = false
  var error: String?
  var statusError: String?
  private(set) var listRevision = 0
  private var generation = 0
  private var statusGeneration = 0
  private var loadedQuery: String?
  private var loadedType: String?

  func clear() {
    generation += 1
    statusGeneration += 1
    result = nil; status = nil; error = nil; statusError = nil
    query = ""; type = ""; loading = false
    retryPage = 1
    loadedQuery = nil; loadedType = nil
    listRevision += 1
  }
  func refreshList(_ client: APIClient) async {
    let filtersChanged = loadedQuery != query || loadedType != type
    let page = loading ? retryPage : result?.page ?? 1
    await load(client, page: filtersChanged ? 1 : page, clearResults: filtersChanged)
  }
  func load(_ client: APIClient, page: Int = 1, clearResults: Bool = false) async {
    generation += 1
    let request = generation
    let requestedQuery = query
    let requestedType = type
    retryPage = page
    if clearResults { result = nil }
    loading = true
    defer { if request == generation { loading = false } }
    do {
      let next: DoubanList = try await client.get("api/douban/items", query: ["q": requestedQuery, "type": requestedType, "page": String(page)])
      guard !Task.isCancelled, request == generation, query == requestedQuery, type == requestedType else { return }
      result = next; error = nil
      loadedQuery = requestedQuery; loadedType = requestedType
    } catch {
      guard !Task.isCancelled, request == generation, query == requestedQuery, type == requestedType else { return }
      self.error = error.localizedDescription
    }
  }
  func loadStatus(_ client: APIClient) async {
    statusGeneration += 1
    let request = statusGeneration
    do {
      let next: DoubanStatus = try await client.get("api/douban/status")
      guard !Task.isCancelled, request == statusGeneration else { return }
      acceptStatus(next)
    } catch {
      guard !Task.isCancelled, request == statusGeneration else { return }
      statusError = error.localizedDescription
    }
  }
  func action(_ client: APIClient, path: String, method: String = "POST", fields: [String: Any] = [:]) async {
    guard !saving else { return }
    saving = true
    statusGeneration += 1
    let request = statusGeneration
    defer { saving = false }
    do {
      let next: DoubanStatus = try await client.send(path, method: method, fields: fields)
      guard request == statusGeneration else { return }
      acceptStatus(next)
    } catch {
      guard request == statusGeneration else { return }
      statusError = error.localizedDescription
    }
  }
  private func acceptStatus(_ next: DoubanStatus) {
    // 总数不变也可能补充短评；一次成功提交只触发一次列表重读。
    let completed = next.lastRun?.state == "completed" &&
      (status?.lastRun?.state != "completed" || next.lastRun?.startedAt != status?.lastRun?.startedAt || next.lastRun?.finishedAt != status?.lastRun?.finishedAt)
    if next.account != status?.account || next.total != status?.total || completed { listRevision += 1 }
    status = next; statusError = nil
  }
}

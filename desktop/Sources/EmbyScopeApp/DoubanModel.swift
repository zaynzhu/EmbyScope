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
  private var generation = 0
  private var statusGeneration = 0

  func clear() {
    generation += 1
    statusGeneration += 1
    result = nil; status = nil; error = nil; statusError = nil
    query = ""; type = ""; loading = false
    retryPage = 1
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
      status = next; statusError = nil
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
      status = next; statusError = nil
    } catch {
      guard request == statusGeneration else { return }
      statusError = error.localizedDescription
    }
  }
}

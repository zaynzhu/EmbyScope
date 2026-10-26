import Foundation
import Observation
import EmbyScopeCore

@MainActor @Observable
final class TraktModel {
  var status: TraktStatus?
  var result: TraktList?
  var imagesRevision = 0
  var home: TraktHome?
  var homeError: String?
  private var homeGeneration = 0
  var kind = "recent"
  var query = ""
  var type = ""
  var loading = false
  var saving = false
  var error: String?
  var statusError: String?
  var retryPage = 1
  private(set) var listRevision = 0
  private(set) var pollRevision = 0
  private var generation = 0
  private var statusGeneration = 0
  private var actionGeneration = 0
  private var loadedFilters: [String]?

  func clear() {
    generation += 1; statusGeneration += 1; actionGeneration += 1; homeGeneration += 1
    home = nil; homeError = nil
    status = nil; result = nil; error = nil; statusError = nil
    loading = false; saving = false; retryPage = 1
    kind = "recent"; query = ""; type = ""; loadedFilters = nil
    listRevision += 1; pollRevision += 1
  }
  private func accept(_ next: TraktStatus) {
    if next.account != status?.account || next.connected != status?.connected {
      homeGeneration += 1; home = nil
      generation += 1; result = nil; loadedFilters = nil; loading = false
    }
    if next.updatedAt != status?.updatedAt || next.account != status?.account || next.connected != status?.connected { listRevision += 1 }
    status = next; statusError = nil
  }
  func loadStatus(_ client: APIClient) async {
    statusGeneration += 1
    let request = statusGeneration
    do {
      let next: TraktStatus = try await client.get("api/trakt/status")
      guard !Task.isCancelled, request == statusGeneration else { return }
      accept(next)
    } catch {
      guard !Task.isCancelled, request == statusGeneration else { return }
      statusError = error.localizedDescription
    }
  }
  func loadHome(_ client: APIClient) async {
    homeGeneration += 1; statusGeneration += 1
    let request = homeGeneration
    let statusRequest = statusGeneration
    do {
      let next: TraktHome = try await client.get("api/trakt/home")
      guard !Task.isCancelled, request == homeGeneration, statusRequest == statusGeneration else { return }
      accept(next.status)
      home = next; homeError = nil
    } catch {
      guard !Task.isCancelled, request == homeGeneration, statusRequest == statusGeneration else { return }
      homeError = error.localizedDescription
    }
  }
  func refreshList(_ client: APIClient) async {
    let changed = loadedFilters != [kind, query, type]
    await load(client, page: changed ? 1 : loading ? retryPage : result?.page ?? 1, clearResults: changed)
  }
  func load(_ client: APIClient, page: Int = 1, clearResults: Bool = false) async {
    generation += 1
    let request = generation
    let filters = [kind, query, type]
    loading = true; retryPage = page
    if clearResults { result = nil }
    defer { if request == generation { loading = false } }
    do {
      let next: TraktList = try await client.get("api/trakt/items", query: ["kind": kind, "q": query, "type": type, "page": String(page)])
      guard !Task.isCancelled, request == generation, filters == [kind, query, type] else { return }
      result = next; loadedFilters = filters; error = nil
    } catch {
      guard !Task.isCancelled, request == generation, filters == [kind, query, type] else { return }
      self.error = error.localizedDescription
    }
  }
  func action(_ client: APIClient, path: String, method: String = "POST", fields: [String: Any] = [:]) async {
    guard !saving else { return }
    actionGeneration += 1; statusGeneration += 1; homeGeneration += 1
    let request = actionGeneration
    saving = true
    defer { if request == actionGeneration { saving = false } }
    do {
      let next: TraktStatus = try await client.send(path, method: method, fields: fields)
      guard !Task.isCancelled, request == actionGeneration else { return }
      statusGeneration += 1
      accept(next); pollRevision += 1
    } catch {
      guard !Task.isCancelled, request == actionGeneration else { return }
      statusError = error.localizedDescription
    }
  }
  func retryStatus() { pollRevision += 1 }
}

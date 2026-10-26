import Foundation
import Observation
import EmbyScopeCore

@MainActor @Observable
final class EpisodeAuditModel {
  var result: EpisodeAudit?
  var query = ""
  var state = "all"
  var page = 1
  var loading = false
  var saving = false
  var error: String?
  var actionError: String?
  var pollRevision = 0
  private var generation = 0
  private var actionGeneration = 0
  private var scope: [String]?

  func clear() {
    generation += 1; actionGeneration += 1
    result = nil; error = nil; actionError = nil; scope = nil
    loading = false; saving = false; page = 1
  }
  func load(_ client: APIClient, server: String) async {
    let filters = [server, query, state]
    if scope != filters { result = nil; page = 1; scope = filters }
    generation += 1
    let request = generation
    loading = true
    defer { if request == generation { loading = false } }
    do {
      let value: EpisodeAudit = try await client.get("api/episode-audit", query: ["server": server, "q": query, "state": state, "page": String(page)])
      guard !Task.isCancelled, request == generation, scope == filters else { return }
      result = value; page = value.page; error = nil
    } catch {
      guard !Task.isCancelled, request == generation else { return }
      self.error = error.localizedDescription
    }
  }
  func refresh(_ client: APIClient, source: EpisodeAuditSource) async {
    guard !saving else { return }
    actionGeneration += 1
    let request = actionGeneration
    saving = true
    defer { if request == actionGeneration { saving = false } }
    do {
      let _: OK = try await client.send("api/episode-audit/refresh", fields: ["serverId": source.serverId, "seriesId": source.seriesId])
      guard !Task.isCancelled, request == actionGeneration else { return }
      actionError = nil; pollRevision += 1
    } catch {
      guard !Task.isCancelled, request == actionGeneration else { return }
      actionError = error.localizedDescription
    }
  }
}

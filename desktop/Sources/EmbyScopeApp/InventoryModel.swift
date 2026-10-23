import Foundation
import Observation
import EmbyScopeCore

@MainActor @Observable
final class InventoryModel {
  var snapshot: InventorySnapshot?
  var history: SyncHistoryResponse?
  var error: String?
  var historyError: String?
  private var scope: String?
  private var historyScope: String?
  private var generation = 0
  private var historyGeneration = 0
  func clear() {
    generation += 1; historyGeneration += 1
    snapshot = nil; history = nil; error = nil; historyError = nil
    scope = nil; historyScope = nil
  }
  func load(_ client: APIClient, server: String) async {
    generation += 1
    let request = generation
    if scope != server { snapshot = nil; error = nil }
    scope = server
    do {
      let value: InventorySnapshot = try await client.get("api/inventory", query: ["server": server])
      guard !Task.isCancelled, request == generation, scope == server else { return }
      snapshot = value; error = nil
    } catch {
      guard !Task.isCancelled, request == generation, scope == server else { return }
      self.error = "本地统计读取失败，已有结果可能过期：\(error.localizedDescription)"
    }
  }
  func loadHistory(_ client: APIClient, server: String) async {
    historyGeneration += 1
    let request = historyGeneration
    if historyScope != server { history = nil; historyError = nil }
    historyScope = server
    do {
      let value: SyncHistoryResponse = try await client.get("api/sync-history", query: ["server": server])
      guard !Task.isCancelled, request == historyGeneration, historyScope == server else { return }
      history = value; historyError = nil
    } catch {
      guard !Task.isCancelled, request == historyGeneration, historyScope == server else { return }
      historyError = "记录读取失败，已有结果可能过期：\(error.localizedDescription)"
    }
  }
}

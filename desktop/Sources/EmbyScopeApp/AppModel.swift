import SwiftUI
import Observation
import EmbyScopeCore

enum Page: String, CaseIterable {
  case home = "此刻", overview = "概览", library = "片库", duplicates = "重复与刮削排查", settings = "服务器设置"
  var symbol: String {
    switch self { case .home: "sparkles.tv"; case .overview: "square.grid.2x2"; case .library: "rectangle.stack"; case .duplicates: "square.on.square"; case .settings: "externaldrive" }
  }
}

@MainActor @Observable
final class AppModel {
  let backend = BackendProcess()
  let demo = CommandLine.arguments.contains("--demo")
  var client: APIClient?
  var initialized = false
  var passwordRequired = false
  var authenticated = false
  var starting = true
  var loading = false
  var error: String?
  var page: Page = .home
  var server = "all"
  var servers: [Server] = []
  var serverStatusError: String?
  private var serverStatusGeneration = 0
  var home: HomeResponse?
  var overview: OverviewResponse?
  var library: LibraryResponse?
  var automaticUpdates = false
  var offline = false
  var canExitOffline = false
  var exitingOffline = false
  var playbackLoading = false
  var playbackCompatibility: Set<String> = []
  var query = ""
  var mediaType = ""
  var reviewFilter = "issues"
  var libraryPage = 1
  var selected: Media?
  var detail: Media?
  var detailError: String?
  var detailLoading = false
  var resources: [String: Resources] = [:]
  var resourceErrors: [String: String] = [:]
  var resourceLoading: Set<String> = []
  var revealAll = false
  var revealed: Set<String> = []
  var reduceMotion = false
  private var generation = 0
  private var detailGeneration = 0
  private var libraryGeneration = 0
  private var episodeGeneration = 0
  private var loadedLibraryKey: String?
  private var started = false
  var scopeName: String { server == "all" ? "全部服务器" : servers.first(where: { $0.id == server })?.name ?? "服务器" }
  var animation: Animation? { reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86) }

  func start() async {
    guard !started else { return }
    started = true
    backend.onUnexpectedExit = { [weak self] in self?.error = "本地内核已停止，请退出后重新打开应用。" }
    do {
      let port = try await backend.start(demo: demo)
      let client = APIClient(port: port, key: backend.key)
      self.client = client
      let status: AuthStatus = try await client.get("api/auth/status")
      initialized = status.initialized
      authenticated = status.authenticated
      passwordRequired = status.passwordRequired ?? true
      if authenticated { await loadScope() }
    } catch { report(error) }
    starting = false
  }
  func login(password: String) async {
    guard let client else { return }
    loading = true
    defer { loading = false }
    do {
      let _: OK = try await client.send(initialized ? "api/auth/login" : "api/auth/setup", fields: ["password": password])
      authenticated = true; initialized = true; error = nil
      await loadScope()
    } catch { report(error) }
  }
  func setPasswordRequired(_ enabled: Bool, password: String = "") async throws {
    guard let client else { return }
    let status: AuthStatus = try await client.send("api/auth/desktop-lock", method: "PUT", fields: ["enabled": enabled, "password": password])
    passwordRequired = status.passwordRequired ?? true
    initialized = status.initialized
    authenticated = status.authenticated
  }
  func lock() async {
    guard passwordRequired, let client else { return }
    do {
      let _: OK = try await client.send("api/auth/logout", fields: [:])
      clearSession()
    } catch { report(error) }
  }
  private func clearSession() {
    generation += 1
    serverStatusError = nil
    detailGeneration += 1
    authenticated = false
    loading = false
    home = nil; overview = nil; library = nil
    selected = nil; detail = nil; detailError = nil
    servers = []; resources = [:]; resourceErrors = [:]; resourceLoading = []
    revealed = []; revealAll = false; loadedLibraryKey = nil
    playbackCompatibility = []
    PosterCache.shared.clear()
  }
  func report(_ failure: Error) {
    if let failure = failure as? APIError, failure.status == 401 { clearSession() }
    error = failure.localizedDescription
  }
  func loadScope() async {
    guard let client else { return }
    generation += 1
    serverStatusGeneration += 1
    let current = generation
    let scope = server
    loading = true
    defer { if current == generation { loading = false } }
    do {
      let updatedServers: [Server] = try await client.get("api/servers")
      let settings: AppSettings = try await client.get("api/settings")
      let snapshot: HomeResponse = try await client.get("api/home", query: ["server": scope])
      let stats: OverviewResponse = try await client.get("api/overview", query: ["server": scope])
      guard current == generation else { return }
      servers = updatedServers; automaticUpdates = settings.automaticUpdates
      offline = settings.offline == true
      canExitOffline = settings.canExitOffline == true
      home = snapshot; overview = stats; error = nil
      loadedLibraryKey = nil
      if page == .library || page == .duplicates { await loadLibrary() }
    } catch { if current == generation { report(error) } }
  }
  func loadServerStatus() async {
    guard let client, authenticated, !Task.isCancelled else { return }
    serverStatusGeneration += 1
    let request = serverStatusGeneration
    let scopeGeneration = generation
    do {
      let updated: [Server] = try await client.get("api/servers")
      guard !Task.isCancelled, authenticated, request == serverStatusGeneration, scopeGeneration == generation else { return }
      servers = updated
      serverStatusError = nil
    } catch {
      guard !Task.isCancelled, authenticated, request == serverStatusGeneration, scopeGeneration == generation else { return }
      serverStatusError = "本地状态读取失败，以下保留上次结果：\(error.localizedDescription)"
      if let failure = error as? APIError, failure.status == 401 { clearSession() }
    }
  }
  func switchServer() async {
    closeDetail()
    home = nil; overview = nil; library = nil; libraryPage = 1
    selected = nil; detail = nil; revealed = []; revealAll = false
    await loadScope()
  }
  func loadLibrary() async {
    guard let client else { return }
    let current = generation
    libraryGeneration += 1
    let request = libraryGeneration
    let params = ["server": server, "q": query, "type": mediaType, "page": String(libraryPage), "pageSize": "24", "duplicates": page == .duplicates ? "true" : "false", "review": reviewFilter]
    let key = params.sorted { $0.key < $1.key }.description
    if loadedLibraryKey == key, library != nil { return }
    do {
      let result: LibraryResponse = try await client.get("api/library", query: params)
      guard authenticated, current == generation, request == libraryGeneration, params["server"] == server, params["q"] == query, params["type"] == mediaType, params["page"] == String(libraryPage), params["review"] == reviewFilter, params["duplicates"] == (page == .duplicates ? "true" : "false") else { return }
      library = result
      libraryPage = result.page
      var acceptedParams = params
      acceptedParams["page"] = String(result.page)
      loadedLibraryKey = acceptedParams.sorted { $0.key < $1.key }.description
      error = nil
    } catch { if current == generation, request == libraryGeneration { report(error) } }
  }
  func navigate(to destination: Page) {
    if destination == .duplicates || page == .duplicates {
      libraryPage = 1; library = nil; loadedLibraryKey = nil
    }
    libraryGeneration += 1
    closeDetail()
    page = destination
  }
  func closeDetail() {
    detailGeneration += 1
    episodeGeneration += 1
    selected = nil; detail = nil; detailError = nil; detailLoading = false
    resources = [:]; resourceErrors = [:]; resourceLoading = []
  }
  func select(_ item: Media) async {
    guard let client else { return }
    selected = item; detail = nil; detailError = nil
    resources = [:]; resourceErrors = [:]; resourceLoading = []
    detailGeneration += 1
    let request = detailGeneration
    detailLoading = true
    defer { if request == detailGeneration { detailLoading = false } }
    do {
      let result: Media = try await client.get(await client.itemPath(item))
      guard request == detailGeneration, selected?.key == item.key else { return }
      detail = result
      for source in result.duplicateSources ?? [] { if let resource = source.resources { resources[source.key] = resource } }
      if let resource = result.resources { resources[item.key] = resource }
    } catch { if request == detailGeneration { detailError = error.localizedDescription } }
  }
  func loadResources(_ item: Media) async {
    guard let client, !resourceLoading.contains(item.key) else { return }
    resourceLoading.insert(item.key)
    let request = detailGeneration
    defer { if request == detailGeneration { resourceLoading.remove(item.key) } }
    do {
      let result: Resources = try await client.get(await client.itemPath(item, suffix: "/resources"))
      if request == detailGeneration { resources[item.key] = result; resourceErrors[item.key] = nil }
    } catch { if request == detailGeneration { resourceErrors[item.key] = error.localizedDescription } }
  }
  func loadEpisodes(page: Int, season: String = "") async {
    guard let client, let item = selected else { return }
    let request = detailGeneration
    episodeGeneration += 1
    let episodeRequest = episodeGeneration
    detailError = nil
    detailLoading = true
    defer { if request == detailGeneration, episodeRequest == episodeGeneration { detailLoading = false } }
    do {
      var parameters = ["page": String(page)]
      if !season.isEmpty { parameters["season"] = season }
      let result: Media = try await client.get(await client.itemPath(item), query: parameters)
      if request == detailGeneration, episodeRequest == episodeGeneration { detail = result }
    } catch { if request == detailGeneration, episodeRequest == episodeGeneration { detailError = error.localizedDescription } }
  }
  func setAutomaticUpdates(_ enabled: Bool) async {
    guard let client else { return }
    do { let settings: AppSettings = try await client.send("api/settings", method: "PUT", fields: ["automaticUpdates": enabled]); automaticUpdates = settings.automaticUpdates } catch { report(error) }
  }
  func exitOffline() async {
    guard let client, offline, canExitOffline, !exitingOffline, !demo else { return }
    exitingOffline = true
    defer { exitingOffline = false }
    do {
      let settings: AppSettings = try await client.send("api/settings/exit-offline", fields: ["confirm": true])
      offline = settings.offline == true
      canExitOffline = settings.canExitOffline == true
      automaticUpdates = settings.automaticUpdates
      await loadScope()
    } catch { report(error) }
  }
  func refresh(full: Bool) async {
    guard let client else { return }
    do {
      let _: OK = try await client.send("api/refresh", fields: ["server": server, "mode": full ? "full" : "light"])
      await loadScope()
    } catch { report(error) }
  }
  func refreshPlayback(observationId: String = UUID().uuidString) async {
    guard let client, authenticated, !offline, !demo, !playbackLoading, !Task.isCancelled else { return }
    playbackLoading = true
    let current = generation
    let scope = server
    let compatibility = playbackCompatibility
    defer { playbackLoading = false }
    do {
      let snapshot: PlaybackResponse = try await client.send("api/playback/refresh", fields: [
        "server": scope, "compatibilityServers": compatibility.sorted(), "observationId": observationId
      ])
      if current == generation, scope == server, compatibility == playbackCompatibility, authenticated, !Task.isCancelled { home?.playback = snapshot }
    } catch {
      if current == generation, scope == server, compatibility == playbackCompatibility, !Task.isCancelled {
        home?.playback?.invalidate()
        report(error)
      }
    }
  }
  func saveProxy(_ target: Server, url: String) async throws {
    guard let client else { return }
    let _: Server = try await client.send("api/servers/\(target.id)/proxy", method: "PUT", fields: ["proxyUrl": url])
    await loadScope()
  }
  func saveServer(id: String?, fields: [String: Any]) async throws {
    guard let client else { return }
    let _: Server = try await client.send(id.map { "api/servers/\($0)" } ?? "api/servers", method: id == nil ? "POST" : "PUT", fields: fields)
    if let id { playbackCompatibility.remove(id) }
    PosterCache.shared.clear()
    await loadScope()
  }
  func deleteServer(_ target: Server) async {
    guard let client else { return }
    do {
      let _: OK = try await client.send("api/servers/\(target.id)", method: "DELETE", fields: [:])
      playbackCompatibility.remove(target.id)
      if server == target.id { server = "all" }
      PosterCache.shared.clear(); await switchServer()
    } catch { report(error) }
  }
  func isHidden(_ item: Media) -> Bool { item.sensitive && !revealAll && !revealed.contains(item.key) }
}

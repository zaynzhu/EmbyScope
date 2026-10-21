import Foundation

public struct APIError: LocalizedError {
  public let message: String
  public let status: Int
  public var errorDescription: String? { message }
}

public actor APIClient {
  private let base: URL
  private let key: String
  private let session: URLSession
  public init(port: Int, key: String) {
    base = URL(string: "http://127.0.0.1:\(port)")!
    self.key = key
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    configuration.httpMaximumConnectionsPerHost = 4
    configuration.urlCache = nil
    session = URLSession(configuration: configuration)
  }
  private func request(_ path: String, query: [String: String], method: String, body: Data?) -> URLRequest {
    var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    components.percentEncodedPath = "/" + path
    components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    var request = URLRequest(url: components.url!)
    request.httpMethod = method
    request.httpBody = body
    request.setValue(key, forHTTPHeaderField: "X-EmbyScope-Desktop")
    request.setValue("1", forHTTPHeaderField: "X-EmbyScope")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(base.absoluteString, forHTTPHeaderField: "Origin")
    return request
  }
  public func data(_ path: String, query: [String: String] = [:], method: String = "GET", body: Data? = nil) async throws -> Data {
    let (data, response) = try await session.data(for: request(path, query: query, method: method, body: body))
    guard let response = response as? HTTPURLResponse else { throw APIError(message: "本地服务响应无效", status: 0) }
    guard (200..<300).contains(response.statusCode) else {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "本地服务暂不可用"
      throw APIError(message: message, status: response.statusCode)
    }
    return data
  }
  public func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
    try JSONDecoder().decode(T.self, from: await data(path, query: query))
  }
  public func send<T: Decodable>(_ path: String, method: String = "POST", fields: [String: Any]) async throws -> T {
    let body = try JSONSerialization.data(withJSONObject: fields)
    return try JSONDecoder().decode(T.self, from: await data(path, method: method, body: body))
  }
  public func itemPath(_ item: Media, suffix: String = "") -> String {
    // 路径组件使用百分号编码；服务器和条目标识始终一起传递。
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
    return "api/items/\(item.serverId)/\(item.id.addingPercentEncoding(withAllowedCharacters: allowed)!)\(suffix)"
  }
}

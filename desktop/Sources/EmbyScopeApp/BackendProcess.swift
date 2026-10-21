import AppKit
import Foundation
import Security

@MainActor
final class BackendProcess {
  private var process: Process?
  private var input: Pipe?
  private var demoDirectory: URL?
  private(set) var key = ""
  var onUnexpectedExit: (() -> Void)?
  private var stopping = false

  func start(demo: Bool) async throws -> Int {
    guard let resources = Bundle.main.resourceURL else { throw failure() }
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw failure() }
    key = bytes.map { String(format: "%02x", $0) }.joined()
    let directory: URL
    if demo {
      directory = FileManager.default.temporaryDirectory.appendingPathComponent("embyscope-preview-\(UUID().uuidString)")
      demoDirectory = directory
    } else {
      directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("EmbyScope")
    }
    let task = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    task.executableURL = resources.appendingPathComponent("runtime/node")
    task.arguments = [resources.appendingPathComponent("service/desktop/backend/main.js").path]
    task.currentDirectoryURL = resources.appendingPathComponent("service")
    // 不继承开发机的 NODE_OPTIONS、代理或 fnm 环境。
    task.environment = ["PATH": "/usr/bin:/bin", "NODE_NO_WARNINGS": "1", "HOME": NSHomeDirectory()]
    task.standardInput = stdin
    task.standardOutput = stdout
    task.standardError = FileHandle.nullDevice
    task.terminationHandler = { [weak self] _ in
      Task { @MainActor in
        guard let self, !self.stopping else { return }
        self.onUnexpectedExit?()
      }
    }
    try task.run()
    process = task
    input = stdin
    let config: [String: Any] = ["key": key, "dataDir": directory.path, "demo": demo, "artwork": resources.appendingPathComponent("demo-cover.jpg").path]
    var data = try JSONSerialization.data(withJSONObject: config)
    data.append(10)
    try stdin.fileHandleForWriting.write(contentsOf: data)
    let timeout = Task { @MainActor in
      try? await Task.sleep(for: .seconds(15))
      if !Task.isCancelled, task.isRunning { task.terminate() }
    }
    defer { timeout.cancel() }
    let response: Data = await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        var line = Data()
        while line.count < 1024 {
          let byte = stdout.fileHandleForReading.readData(ofLength: 1)
          if byte.isEmpty || byte.first == 10 { break }
          line.append(byte)
        }
        continuation.resume(returning: line)
      }
    }
    guard let object = try? JSONSerialization.jsonObject(with: response) as? [String: Int], let port = object["port"], (1...65535).contains(port) else { throw failure() }
    return port
  }

  func stop() async {
    stopping = true
    try? input?.fileHandleForWriting.close()
    guard let process else { return }
    // 后端取消远端请求并关闭 SQLite 后退出；主线程保持响应。
    for _ in 0..<100 {
      if !process.isRunning { break }
      try? await Task.sleep(for: .milliseconds(100))
    }
    if process.isRunning { process.terminate() }
    for _ in 0..<20 {
      if !process.isRunning { break }
      try? await Task.sleep(for: .milliseconds(100))
    }
    if !process.isRunning, let demoDirectory { try? FileManager.default.removeItem(at: demoDirectory) }
    input = nil
  }
  private func failure() -> NSError { NSError(domain: "EmbyScope", code: 1, userInfo: [NSLocalizedDescriptionKey: "本地内核未能启动。请检查应用是否完整，或是否已有另一个实例。现有数据不会被覆盖。"] ) }
}

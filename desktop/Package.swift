// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "EmbyScope",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "EmbyScope", targets: ["EmbyScopeApp"])],
  targets: [
    .target(name: "EmbyScopeCore"),
    .executableTarget(name: "EmbyScopeApp", dependencies: ["EmbyScopeCore"]),
    .testTarget(name: "EmbyScopeCoreTests", dependencies: ["EmbyScopeCore"]),
    .testTarget(name: "EmbyScopeAppTests", dependencies: ["EmbyScopeApp", "EmbyScopeCore"])
  ]
)

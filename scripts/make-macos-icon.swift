import AppKit

// 延续项目原有取景框图标，适配桌面版的深色与琥珀色。
let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let size = points * scale
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let edge = CGFloat(size)
    NSColor(red: 0.07, green: 0.075, blue: 0.09, alpha: 1).setFill()
    NSBezierPath(roundedRect: CGRect(x: edge * 0.06, y: edge * 0.06, width: edge * 0.88, height: edge * 0.88), xRadius: edge * 0.20, yRadius: edge * 0.20).fill()
    let gold = NSColor(red: 0.85, green: 0.65, blue: 0.32, alpha: 1)
    gold.setStroke()
    let path = NSBezierPath()
    path.lineWidth = edge * 0.045
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    for (x, y, dx, dy) in [(0.28, 0.28, 1.0, 1.0), (0.72, 0.28, -1.0, 1.0), (0.28, 0.72, 1.0, -1.0), (0.72, 0.72, -1.0, -1.0)] {
      path.move(to: CGPoint(x: (x + dx * 0.13) * edge, y: y * edge))
      path.line(to: CGPoint(x: x * edge, y: y * edge))
      path.line(to: CGPoint(x: x * edge, y: (y + dy * 0.13) * edge))
    }
    path.stroke()
    gold.setFill()
    NSBezierPath(ovalIn: CGRect(x: edge * 0.44, y: edge * 0.44, width: edge * 0.12, height: edge * 0.12)).fill()
    NSGraphicsContext.restoreGraphicsState()
    let name = "icon_\(points)x\(points)\(scale == 2 ? "@2x" : "").png"
    try rep.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(name))
  }
}

import SwiftUI
import EmbyScopeCore

struct ComparisonView: View {
  @Environment(AppModel.self) private var app
  let comparison: Comparison
  let sources: [Media]
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(comparison.label).font(.headline).foregroundStyle(Theme.accent)
      ForEach(comparison.reasons, id: \.self) { reason in
        Label(reason, systemImage: "exclamationmark.magnifyingglass").font(.caption)
      }
      Text("\(comparison.counts.candidate) 对候选 · \(comparison.counts.distinct) 对季范围无重叠 · \(comparison.counts.unknown) 对待确认")
        .font(.caption).foregroundStyle(Theme.secondary)
      Text("这里统计记录之间的配对，不是文件份数。例如 3 条记录可形成 3 对；候选仍需核对位置、版本与单集。")
        .font(.caption).foregroundStyle(Theme.secondary)
      DisclosureGroup("逐对核对依据与位置线索") {
        ForEach(Array(comparison.pairs.enumerated()), id: \.offset) { _, pair in
          if let left = sources.first(where: { $0.key == pair.leftKey }), let right = sources.first(where: { $0.key == pair.rightKey }) {
            VStack(alignment: .leading, spacing: 7) {
              Text("\(left.title)（\(left.serverName ?? "来源未知")）\n↔ \(right.title)（\(right.serverName ?? "来源未知")）")
                .font(.system(size: 12, weight: .medium))
              Text(pair.reason).font(.caption).foregroundStyle(Theme.secondary)
              ForEach(pair.basis ?? [], id: \.self) { basis in
                Text("依据：\(basis)").font(.caption).foregroundStyle(Theme.secondary)
              }
              if pair.kind == "candidate" {
                Text(resourceComparison(leftServer: left.serverId, rightServer: right.serverId,
                  left: app.resources[left.key] ?? left.resources, right: app.resources[right.key] ?? right.resources))
                  .font(.caption).foregroundStyle(Theme.accent)
              }
            }.padding(.vertical, 8)
            Divider()
          }
        }
      }
      if comparison.truncated { Text("关联过多，只展示前 200 对；计数包含全部组合。").font(.caption) }
      Text("不同路径可能是不同版本、STRM 或挂载映射；相同路径也不等于相同物理文件。未读取文件内容、计算哈希或验证云盘对象。")
        .font(.caption).foregroundStyle(Theme.secondary)
    }
  }
}

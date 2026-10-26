import SwiftUI
import EmbyScopeCore

struct EpisodeAuditView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var active = NSApplication.shared.isActive
  @State private var model = EpisodeAuditModel()
  private var visible: Bool { active && scenePhase == .active && app.authenticated }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        SectionTitle(title: "缺集检查", subtitle: "\(app.scopeName) · 按剧集与季号核对收录记录")
        Spacer()
        Button("刷新本地检查") { model.pollRevision += 1 }.disabled(model.loading)
        Button("完成") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      Text("检查已读取单集的编号缺口，并对照同一作品的其他来源。范围由已有编号决定；不判断未播出集、整季缺失或末尾是否齐全，也不验证文件能否播放。")
        .font(.callout).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
      HStack {
        TextField("搜索剧集", text: $model.query).textFieldStyle(.roundedBorder).frame(width: 260)
        Picker("检查结果", selection: $model.state) {
          Text("全部").tag("all"); Text("有编号缺口").tag("gaps")
          Text("待确认").tag("unknown"); Text("范围内连续").tag("continuous")
        }.frame(width: 220)
        Spacer()
        if model.loading || model.result?.running == true { ProgressView().controlSize(.small) }
      }
      if let result = model.result {
        Text("\(result.counts.gaps) 组有缺口 · \(result.counts.unknown) 组待确认 · \(result.counts.continuous) 组范围内连续 · 已有片库 \(result.knownServers)/\(result.totalServers) 个来源")
          .font(.caption).foregroundStyle(Theme.secondary)
      }
      if let error = model.actionError ?? model.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if model.result?.items.isEmpty == true {
            EmptyState(title: "暂无匹配剧集", message: "调整筛选或先读取服务器片库；没有结果不代表片库已经齐全。")
          }
          ForEach(model.result?.items ?? [], id: \.key) { item in
            DisclosureGroup {
              if item.conflict { Text("作品编号冲突，已分开检查，不提供跨来源互补判断。").font(.caption).foregroundStyle(Theme.accent) }
              ForEach(item.sources, id: \.key) { source in sourceView(source) }
            } label: {
              HStack {
                Text(item.title).font(.headline)
                Spacer()
                Text(item.label).font(.caption).foregroundStyle(Theme.accent)
                Text("\(item.sources.count) 个来源").font(.caption).foregroundStyle(Theme.secondary)
              }
            }.padding(16).background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
          }
        }.padding(.vertical, 4)
      }
      HStack {
        Text("按需读取仅访问所选剧集，每次读取后冷却 1 分钟；不会自动扫全库。").font(.caption).foregroundStyle(Theme.secondary)
        Spacer()
        Button("上一页") { model.page -= 1; model.pollRevision += 1 }.disabled(model.loading || model.page <= 1)
        Text("\(model.result?.page ?? 1) / \(model.result?.pages ?? 1)").font(.caption.monospacedDigit())
        Button("下一页") { model.page += 1; model.pollRevision += 1 }.disabled(model.loading || model.page >= (model.result?.pages ?? 1))
      }
    }.padding(26).frame(width: 900, height: 680)
      .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in active = true }
      .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in active = false }
      .onChange(of: app.authenticated) { _, value in if !value { model.clear(); dismiss() } }
      .task(id: "\(visible)-\(app.server)-\(model.query)-\(model.state)-\(model.pollRevision)") {
        guard visible, let client = app.client else { return }
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        repeat {
          await model.load(client, server: app.server)
          guard model.error == nil, model.result?.running == true else { return }
          do { try await Task.sleep(for: .seconds(2)) } catch { return }
        } while !Task.isCancelled
      }
  }
  private func sourceView(_ source: EpisodeAuditSource) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("\(source.serverName) · \(source.title)").font(.callout.weight(.medium))
        Spacer()
        Button(source.running ? "正在读取…" : "读取本剧单集") {
          Task { if let client = app.client { await model.refresh(client, source: source) } }
        }.disabled(app.offline || app.demo || model.saving || model.result?.running == true)
      }
      Text("快照：\(displayDate(source.updatedAt))").font(.caption).foregroundStyle(Theme.secondary)
      ForEach(source.reasons, id: \.self) { Text($0).font(.caption).foregroundStyle(Theme.accent) }
      if let error = source.error { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      ForEach(source.seasons, id: \.number) { season in
        VStack(alignment: .leading, spacing: 6) {
          Text("第 \(season.number) 季 · 已收录 \(season.count) 个编号").font(.callout.weight(.medium))
          Text("已有：\(ranges(season.present))").font(.caption).foregroundStyle(Theme.secondary).textSelection(.enabled)
          if source.eligible, let start = season.start, let end = season.end {
            Text("对照范围：E\(start)–E\(end)").font(.caption).foregroundStyle(Theme.secondary)
            Text(season.gaps.isEmpty ? "此范围内编号连续，不代表全季齐全" : "本来源未收录：\(ranges(season.gaps))")
              .font(.callout).foregroundStyle(Theme.accent).textSelection(.enabled)
            ForEach(Array(season.alternatives.enumerated()), id: \.offset) { _, other in
              Text("\(other.serverName) 的另一条记录已收录：\(ranges(other.ranges))")
                .font(.caption).foregroundStyle(Theme.secondary).textSelection(.enabled)
            }
          }
        }.padding(.vertical, 6)
      }
      if source.excluded > 0 { Text("已排除 \(source.excluded) 条特别篇、零号集或虚拟条目。").font(.caption).foregroundStyle(Theme.secondary) }
    }.padding(.top, 14)
  }
  private func ranges(_ values: [EpisodeRange]) -> String { values.map(\.label).joined(separator: "、") }
}

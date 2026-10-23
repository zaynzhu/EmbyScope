import SwiftUI
import EmbyScopeCore

struct InventoryPanel: View {
  @Environment(AppModel.self) private var app
  @Environment(\.scenePhase) private var scenePhase
  @State private var showHistory = false
  private var active: Bool { scenePhase == .active && app.authenticated && (app.page == .library || app.page == .duplicates) }
  // 只在缓存状态变更时重算问题统计，普通五秒轮询仅读取服务器状态。
  private var snapshotKey: String {
    app.server + app.servers.filter { app.server == "all" || $0.id == app.server }.map {
      "\($0.id):\($0.datasets["catalog"]?.updatedAt ?? ""):\($0.datasets["catalog"]?.error ?? ""):\($0.episodeSync?.updatedAt ?? "")"
    }.joined(separator: "|")
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("\(app.scopeName) · 片库状态").font(.callout.weight(.medium))
        Spacer()
        Text(app.offline ? "离线预览" : app.automaticUpdates ? "自动更新已开启" : "自动更新已暂停").font(.caption).foregroundStyle(Theme.secondary)
        Button("同步记录") { showHistory = true }
        Button("更新设置") { app.navigate(to: .settings) }
        Button("刷新统计") { Task { if let client = app.client { await app.inventory.load(client, server: app.server) } } }
      }
      ForEach(app.servers.filter { app.server == "all" || $0.id == app.server }) { server in
        let catalog = server.datasets["catalog"]
        HStack {
          Text(server.name).fontWeight(.medium)
          Text(server.syncing ? "正在更新" : server.episodeSync?.syncing == true ? "正在补齐季集" : catalog?.available != true ? "片库尚未读取" : catalog?.error != nil ? "更新失败，保留旧片库" : catalog?.stale == true ? "片库待更新" : "已读取片库")
          Spacer()
          Text("片库成功读取：\(catalog?.updatedAt?.isEmpty == false ? displayDate(catalog?.updatedAt) : "暂无")")
        }.font(.caption).foregroundStyle(Theme.secondary)
      }
      if let snapshot = app.inventory.snapshot {
        HStack(spacing: 20) {
          issue("资源重复线索", count: snapshot.counts.resources, filter: "resources")
          issue("元数据疑点", count: snapshot.counts.metadata, filter: "metadata")
          issue("待确认", count: snapshot.counts.unknown, filter: "unknown")
          Spacer()
        }
        Text("当前服务器全部缓存中的关联组数，不受片名或类型筛选影响；各类可能重叠。\(snapshot.complete ? "" : "已读取 \(snapshot.knownServers)/\(snapshot.totalServers) 台，结果可能不完整。")")
          .font(.system(size: 10)).foregroundStyle(Theme.secondary)
      } else { Text("正在读取本地问题统计…").font(.caption).foregroundStyle(Theme.secondary) }
      if let error = app.inventory.error ?? app.serverStatusError { Text(error).font(.caption).foregroundStyle(Theme.accent) }
    }.padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
      .task(id: snapshotKey) { if let client = app.client { await app.inventory.load(client, server: app.server) } }
      .task(id: active) {
        guard active else { return }
        while !Task.isCancelled && active {
          await app.loadServerStatus()
          do { try await Task.sleep(for: .seconds(5)) } catch { return }
        }
      }
      .sheet(isPresented: $showHistory) { SyncHistoryView() }
  }
  private func issue(_ label: String, count: Int?, filter: String) -> some View {
    Button { app.openReview(filter) } label: {
      HStack(spacing: 8) { Text(label); Text(count.map { String($0) } ?? "未读取").fontWeight(.semibold); Image(systemName: "arrow.up.right").font(.caption2) }
    }.buttonStyle(.plain).font(.callout).foregroundStyle(Theme.accent).disabled(count == nil)
  }
}

struct SyncHistoryView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  private var active: Bool { scenePhase == .active && app.authenticated }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("同步记录 · \(app.scopeName)").font(.title3.weight(.semibold))
        Spacer()
        Button("刷新记录") { Task { if let client = app.client { await app.inventory.loadHistory(client, server: app.server) } } }
        Button("关闭") { dismiss() }
      }
      Text("从本版本开始记录服务器更新；不补造旧历史。全局保留最近 2,000 次，本页展示当前范围最近 100 次。每 5 秒读取本机记录，不触发远端同步。").font(.caption).foregroundStyle(Theme.secondary)
      if let error = app.inventory.historyError { Text(error).font(.caption).foregroundStyle(Theme.accent) }
      if app.inventory.history?.available == false { Text("部分执行记录写入失败，历史可能不完整；同步流程仍按原规则执行。").font(.caption).foregroundStyle(Theme.accent) }
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if let history = app.inventory.history, history.items.isEmpty {
            EmptyState(title: "暂无同步记录", message: "下一次手动或自动服务器更新会记录在这里。豆瓣同步结果仍在原同步设置中查看。")
          } else if app.inventory.history == nil { ProgressView("正在读取本地记录…") }
          ForEach(app.inventory.history?.items ?? []) { run in
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                Text("\(run.serverName) · \(run.modeLabel)").font(.callout.weight(.medium))
                Spacer()
                Text(run.stateLabel).foregroundStyle(run.state == "completed" ? Theme.secondary : Theme.accent)
              }
              Text("\(displayDate(run.startedAt)) · \(run.triggerLabel) · \(run.durationLabel)").font(.caption).foregroundStyle(Theme.secondary)
              if let message = run.message { Text(message).font(.caption).foregroundStyle(Theme.accent) }
              if !run.steps.isEmpty {
                DisclosureGroup("读取结果 · \(run.steps.count) 项") {
                  ForEach(Array(run.steps.enumerated()), id: \.offset) { _, step in
                    Text("\(step.label)：\(step.error ?? "已读取 \(step.count ?? 0) 条")").font(.caption).frame(maxWidth: .infinity, alignment: .leading)
                  }
                }.font(.caption)
              }
            }.padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
          }
        }
      }
    }.padding(24).frame(width: 760, height: 580).background(Theme.background)
      .task(id: "\(app.server)-\(active)") {
        guard active else { return }
        while !Task.isCancelled && active {
          if let client = app.client { await app.inventory.loadHistory(client, server: app.server) }
          do { try await Task.sleep(for: .seconds(5)) } catch { return }
        }
      }
  }
}

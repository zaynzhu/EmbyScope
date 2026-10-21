import SwiftUI
import EmbyScopeCore

struct HomeView: View {
  @Environment(AppModel.self) private var app
  @State private var appeared = false
  var body: some View {
    ScrollViewReader { scroll in
      ScrollView {
        VStack(alignment: .leading, spacing: 26) {
          HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 8) {
              Text("你的私人观影空间").font(.system(size: 11, weight: .medium)).tracking(2).foregroundStyle(Theme.accent)
              Text("故事，停在这里。").font(.system(size: 34, weight: .bold)).tracking(-1)
            }
            Spacer()
            Text(Date.now.formatted(.dateTime.month().day().weekday(.wide).locale(Locale(identifier: "zh_CN"))))
              .font(.system(size: 12)).foregroundStyle(Theme.secondary)
          }
          if let home = app.home {
            HStack(spacing: 16) {
              ForEach(app.servers.filter { app.server == "all" || $0.id == app.server }) { server in
                Label("\(server.name) · \(server.statusLabel)", systemImage: server.status == "online" ? "externaldrive" : "externaldrive.badge.exclamationmark")
                  .font(.system(size: 10)).foregroundStyle(server.status == "online" ? Theme.secondary : Theme.accent)
              }
              Spacer()
              Text(app.automaticUpdates ? "自动更新已开启" : "自动更新已暂停").font(.system(size: 10)).foregroundStyle(Theme.secondary)
            }
            if let featured = home.recent.first ?? home.resume.first {
              ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 26) {
                  HeroView(item: featured, hasTime: home.recent.contains { $0.key == featured.key }).frame(minWidth: 530)
                  recentPreview(home) { withAnimation(app.animation) { scroll.scrollTo("recent", anchor: .top) } }
                    .frame(width: 260)
                }
                HeroView(item: featured, hasTime: home.recent.contains { $0.key == featured.key })
              }
            } else {
              EmptyState(title: "下一段故事，从这里开始", message: home.emptyReason ?? "添加服务器后，在这里查看账号的观看信息。")
                .frame(height: 250).background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
            }
            if app.demo {
              Label("演示数据 · 虚构作品与原创封面 · 未连接 NAS", systemImage: "testtube.2")
                .font(.caption).foregroundStyle(Theme.accent)
            }
            if let playback = home.playback { PlaybackView(snapshot: playback) }
            VStack(alignment: .leading, spacing: 18) {
              SectionTitle(title: "还没看完的故事", subtitle: "当前账号的继续观看 · 这里只展示信息，不提供播放")
              if home.resume.isEmpty {
                EmptyState(title: "暂无继续观看", message: "账号接口可能没有内容，或没有读取权限。具体状态可在概览查看。")
              } else {
                ScrollView(.horizontal, showsIndicators: false) {
                  LazyHStack(alignment: .top, spacing: 18) {
                    ForEach(home.resume, id: \.key) { item in MediaCard(item: item, compact: true).frame(width: 218) }
                  }.padding(.vertical, 4)
                }
              }
            }
            VStack(alignment: .leading, spacing: 18) {
              SectionTitle(title: "最近观看", subtitle: "按账号最后播放时间排列 · 每个条目保留最后一次")
              if home.recent.isEmpty {
                EmptyState(title: "观看时间暂不可用", message: home.emptyReason ?? home.historyNote)
              } else {
                ForEach(home.recent, id: \.key) { item in
                  Button { Task { await app.select(item) } } label: {
                    HStack(spacing: 18) {
                      Text(displayDate(item.lastPlayed)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondary).frame(width: 132, alignment: .leading)
                      Rectangle().fill(Theme.accent.opacity(0.5)).frame(width: 2, height: 26)
                      VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.system(size: 14, weight: .medium))
                        Text(item.type == "Episode" ? item.mediaLabel : item.metadata).font(.caption).foregroundStyle(Theme.secondary)
                      }
                      Spacer()
                      Text(item.serverName ?? "").font(.caption).foregroundStyle(Theme.secondary)
                      Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(Theme.accent)
                    }.padding(.vertical, 8).contentShape(Rectangle())
                  }.buttonStyle(.plain)
                }
                Text(home.historyNote).font(.caption).foregroundStyle(Theme.secondary).padding(.top, 4)
              }
            }.id("recent")
            VStack(alignment: .leading, spacing: 6) {
              ForEach(Array(home.sources.enumerated()), id: \.offset) { _, source in
                Text("\(source.serverName) · \(["catalog": "片库", "latest": "最近入库", "resume": "继续观看"][source.kind] ?? source.kind) · 缓存 \(displayDate(source.updatedAt))\(source.stale ? " · 可能已过期" : "")\(source.error.map { " · " + $0 } ?? "")")
                  .font(.system(size: 10)).foregroundStyle(Theme.secondary)
              }
            }
          } else if app.loading { ProgressView("正在读取本地快照…").frame(maxWidth: .infinity, minHeight: 300) }
        }.padding(30).frame(maxWidth: 1300).frame(maxWidth: .infinity)
          .opacity(appeared ? 1 : 0).offset(y: appeared ? 0 : 10)
      }
      .onAppear { withAnimation(app.reduceMotion ? nil : .easeOut(duration: 0.45)) { appeared = true } }
    }
  }
  private func recentPreview(_ home: HomeResponse, showAll: @escaping () -> Void) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text("观看足迹").font(.system(size: 20, weight: .semibold))
        Spacer()
        Image(systemName: "clock.arrow.circlepath").font(.system(size: 14, weight: .light)).foregroundStyle(Theme.accent)
      }.padding(.bottom, 6)
      Text("来自账号的最后播放记录").font(.system(size: 11)).foregroundStyle(Theme.secondary)
        .padding(.bottom, 16)
      if home.recent.isEmpty {
        Text("接口尚未提供观看时间。\n继续观看内容仍可在下方查看。")
          .font(.callout).lineSpacing(5).foregroundStyle(Theme.secondary).padding(.vertical, 24)
      } else {
        ForEach(Array(home.recent.prefix(4).enumerated()), id: \.element.key) { index, item in
          Button { Task { await app.select(item) } } label: {
            HStack(alignment: .top, spacing: 13) {
              Text(String(format: "%02d", index + 1)).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.accent).padding(.top, 3)
              VStack(alignment: .leading, spacing: 5) {
                Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Text("\(displayDate(item.lastPlayed)) · \(item.serverName ?? "来源未知")")
                  .font(.system(size: 10)).foregroundStyle(Theme.secondary).lineLimit(1)
              }
              Spacer(minLength: 0)
            }.padding(.vertical, 11).contentShape(Rectangle())
          }.buttonStyle(.plain)
          if index < min(home.recent.count, 4) - 1 { Rectangle().fill(Theme.line).frame(height: 1) }
        }
      }
      Spacer(minLength: 12)
      Button(action: showAll) {
        HStack { Text("查看全部记录"); Spacer(); Image(systemName: "arrow.down.right") }
          .font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.accent).contentShape(Rectangle())
      }.buttonStyle(.plain)
    }.frame(height: 330)
  }
}

private struct HeroView: View {
  @Environment(AppModel.self) private var app
  let item: Media
  let hasTime: Bool
  var body: some View {
    ZStack(alignment: .leading) {
      PosterView(item: item, hero: true)
      LinearGradient(stops: [.init(color: .black.opacity(0.91), location: 0), .init(color: .black.opacity(0.69), location: 0.38), .init(color: .black.opacity(0.05), location: 1)], startPoint: .leading, endPoint: .trailing).allowsHitTesting(false)
      VStack(alignment: .leading, spacing: 16) {
        Label(hasTime ? "上次看到这里" : "继续观看", systemImage: "clock.arrow.circlepath")
          .font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.gold)
        Text(item.title).font(.system(size: 43, weight: .bold)).tracking(-1.4).lineLimit(2)
        Text(item.metadata).font(.system(size: 12)).foregroundStyle(.white.opacity(0.78))
        if let description = item.overview { Text(description).font(.system(size: 13)).foregroundStyle(.white.opacity(0.72)).lineLimit(2).frame(maxWidth: 370, alignment: .leading) }
        HStack(spacing: 18) {
          Button { Task { await app.select(item) } } label: { Label("查看详情", systemImage: "arrow.up.right") }.buttonStyle(GoldButton())
          VStack(alignment: .leading, spacing: 5) {
            Text(item.serverName ?? "来源未知").font(.system(size: 11, weight: .medium))
            Text(hasTime ? "最后播放 \(displayDate(item.lastPlayed))" : "接口未提供观看时间").font(.system(size: 10)).foregroundStyle(.white.opacity(0.78))
            Text("缓存更新 \(displayDate(item.observedAt))").font(.system(size: 10)).foregroundStyle(.white.opacity(0.78))
          }
        }.padding(.top, 6)
      }.foregroundStyle(.white).padding(34).allowsHitTesting(!app.isHidden(item))
      if app.isHidden(item) {
        Button("显示这张海报") { withAnimation(app.animation) { _ = app.revealed.insert(item.key) } }
          .buttonStyle(GoldButton()).frame(maxWidth: .infinity, alignment: .trailing).padding(30)
      }
    }.frame(height: 330).clipShape(RoundedRectangle(cornerRadius: 16))
  }
}

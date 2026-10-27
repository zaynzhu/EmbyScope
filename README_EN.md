<div align="center">

<img src="public/favicon.svg" alt="EmbyScope icon" width="88">

# 映览 · EmbyScope

**Your libraries, viewing records, and media clues — together in a personal dashboard.**

[User guide](docs/macOS使用说明.md) · [Installation & backups](docs/macOS安装与备份.md) · [NAS deployment](docs/部署说明.md) · [Validation records](docs/macOS验收记录.md)

</div>

<div align="center">

[中文](README.md) | **English**

</div>

<div align="center">

![macOS](https://img.shields.io/badge/macOS-14%2B-161616?style=for-the-badge&logo=apple)
![SwiftUI](https://img.shields.io/badge/UI-SwiftUI-F39B39?style=for-the-badge&logo=swift&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.22.2-43853D?style=for-the-badge&logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/Storage-SQLite-39758C?style=for-the-badge&logo=sqlite)

</div>

EmbyScope is a personal dashboard for multiple Emby servers: one local administrator and one regular account per server. The Mac app provides a native SwiftUI interface, backed by a Node.js service and SQLite for settings, caches, and viewing snapshots. A separately deployable web interface is also available.

> [!NOTE]
> EmbyScope displays and checks media information. It does not play, proxy, or download videos, or modify Emby media or viewing data. The Mac app has more features; the web interface currently covers basic library browsing and resource inspection. Their local configurations are not automatically shared.

![Native Mac home screen with fictional demo data](docs/images/macos-home.png)

---

## ✨ Features

- **Multiple libraries in one place**: switch between a server and an aggregate view; search films and series, and inspect libraries, recent additions, continue-watching items, and sources.
- **Viewing records with clear provenance**: the Mac home screen shows Trakt history and playback progress, with an option to view server records; Douban ratings and short reviews remain separate.
- **Duplicate and metadata inspection**: associate sources using provider IDs, distinguish duplicate clues from season and metadata issues, and read resource paths on demand.
- **Episode checks on demand**: the Mac app checks gaps within observed episode-number ranges, handles combined episodes, and shows matching episodes on other sources. Insufficient evidence is marked unconfirmed.
- **Controlled updates**: Emby lightweight updates and full-library reconciliation are separate. Trakt automatic sync is independently enabled. Successful Douban sync continues with poster completion for that sync's scope.
- **Local caches and encrypted credentials**: reuse posters and complete snapshots, optionally mirror Douban posters to S3, and back up configuration together with caches.
- **Regular accounts and compatible interfaces**: no Emby API key or remote plugin is required. Tested Jiyingshi compatibility paths are supported, with explicit limitations when permissions or interfaces are insufficient.

### Choose how to use it

| Capability | Native Mac app | Web interface / NAS deployment |
| :--- | :--- | :--- |
| Multi-server overview, library, search, and details | Supported | Supported |
| Duplicate clues, metadata inspection, resource paths | Supported | Supported |
| Douban watched list and poster completion | Supported | No corresponding UI yet |
| Trakt history and playback progress | Supported | No corresponding UI yet |
| Episode audit and sync-history windows | Supported | No corresponding UI yet |
| Startup authentication | Optional password, off by default | Administrator password required |
| Runtime | Bundled Node.js, runs with the app | Separate Node.js service or container |

The current Mac build is **0.1.22 / build 23**, requiring **macOS 14 or later**; local validation used Apple Silicon. There is no native iOS or Android package. Remote reads still require network access to the relevant server.

---

## 🚀 Quick start

Try the web interface with simulated data first; no real Emby account is needed. These commands require Git and fnm, with fnm configured in your shell. No npm dependencies need to be installed.

```bash
git clone https://github.com/zaynzhu/EmbyScope.git
cd EmbyScope
fnm install
fnm use
npm run demo
```

Open `http://127.0.0.1:3900` and set a temporary administrator password. The demo contains two simulated Emby servers; one returns 403 for continue-watching requests to demonstrate partial availability. A normal `Ctrl+C` shutdown removes demo data without writing to the production configuration directory.

If you have already built the Mac app, you can also open its isolated demo:

```bash
open dist/EmbyScope.app --args --demo
```

---

## 📦 Installation

### Native Mac app

If you already have a DMG matching your Mac's architecture, drag `EmbyScope.app` into Applications. The package includes Node.js and needs no separate Docker or database installation. Read the [installation, upgrade, and backup guide](docs/macOS安装与备份.md) before installing.

Building from source requires macOS, a Swift toolchain, fnm, and ripgrep. Run from the repository root:

```bash
fnm install
fnm use
scripts/build-macos-dmg.sh
```

The script builds `dist/EmbyScope.app`, a DMG, and a SHA-256 checksum file for the host architecture. Builds use local ad hoc signing and are not notarized by Apple; local validation does not establish compatibility with every Mac. For development, run `scripts/build-macos-app.sh` if you only need the app.

### Local web interface

From the repository root, use the pinned Node.js version, **22.22.2**:

```bash
fnm use
npm start
```

Open `http://localhost:3000`, set an administrator password of at least 12 characters, and add your Emby connections. Configuration defaults to `data/`; override paths and listening settings with `DATA_DIR`, `PORT`, and `HOST`. Perform initial setup on a trusted network. For remote access, use an HTTPS reverse proxy and set `COOKIE_SECURE=true`.

Node.js 22 emits an experimental API warning for its built-in SQLite. The runtime version is pinned; no separate database or Redis is required.

### NAS / Docker

Manually run the [GitHub Actions offline-packaging workflow](https://github.com/zaynzhu/EmbyScope/actions/workflows/docker-offline.yml) to build a **linux/amd64** image for Intel x86_64 devices such as the ZSpace Z4S.

After both build and independent validation succeed, download the `embyscope-linux-amd64-verified` artifact. Follow the [deployment guide](docs/部署说明.md) to import the image and configure ports and the data directory. Artifacts are retained for 30 days; check the source commit before downloading. A `candidate` artifact has not passed the independent validation stage. Builds run in the cloud, so no local Docker build environment is needed.

---

## 💡 Usage

### Connect and browse libraries

In server settings (「服务器设置」), add the Emby address, username, and password. Preserve reverse-proxy subpaths, such as `https://media.example.com/emby`; do not enter `/web/index.html` or a URL containing a token. Each server can have an associated reverse-proxy address sharing the same identity and library.

Select one server or all servers at the top, then search and filter the library. Counts cover libraries, films, series, and episodes visible to the account. Episode rows are excluded from work-level deduplication, and matching titles alone do not establish identity. Recent additions and continue-watching requests retrieve at most 18 items per server and show at most 24 in aggregate; missing timestamps are not guessed.

### View watching records

On Mac, open 「Trakt 观看 → 账号与配置」 to authorize with your own Client ID and a device code. Apple TV Infuse records must first reach the same Trakt account. Douban sync separately stores ratings, short reviews, and posters, without needing PixelReel or WhatShot to run.

Emby, Trakt, and Douban remain separate rather than merging progress or claiming a unified history. Emby play counts, total viewing time, rankings, and trends are marked unavailable because no trusted history source is connected. Automatic TTD log integration is not implemented. Standard Emby sessions and Jiyingshi resume-activity detection are also explicitly distinguished.

### Inspect resources and episode gaps

Start in 「重复与刮削排查」 to compare sources, IDs, and season scope; read resource locations when needed. On Mac, open 「缺集检查」 from the library or inspection page and read one series from a selected source on demand. There is no batch read or automatic full-library episode audit.

A numbering gap does not prove a missing file. Continuity within the observed range does not establish a complete or playable season. Unconfirmed items do not need to be cleared, and matching episode numbers across sources do not guarantee identical edits.

<details>
<summary>Web interface: server filtering and NSFW posters</summary>

The library's server filter follows the top-level source selector. Changing server, search, or media type resets pagination. Mark a connection NSFW in 「服务器设置 → 编辑」 to blur its posters by default; aggregated works are blurred if any source is tagged. The top button reveals or blurs all posters. Clicking a blurred poster first reveals it; clicking it again opens details.

Titles and source links still open details directly, and detail posters use the same rules. Reveals last only for the current page session; reloading or signing out restores blurring, while tags persist. This is a display preference: the browser still loads the images.

</details>

---

## Data semantics

<details>
<summary>Expand: identity matching, complete caches, API limits, and resource paths</summary>

1. Libraries and views use `/Users/{UserId}/...`; seasons and episodes use `/Shows/{Id}/Seasons` and `/Shows/{Id}/Episodes` with the current user's identifier. No global-count or administrator user-list endpoint is used. Library counts reflect top-level views visible to that account.
2. Each connection has a UUID. Item IDs, user IDs, images, caches, details, and tokens are scoped to that connection; identical remote IDs on different servers are allowed.
3. Films and series are associated by media type and TMDB, IMDb, or TVDB IDs. If a connected group contains conflicting values for a provider, the entire group stays separate to avoid order-dependent merges. Items without valid IDs remain separate; titles alone are not used. Deduplicated counts are conservative, not a claim of perfect identification.
4. A library cache section is replaced only after all pages arrive. Timeouts, repeated pages, changing totals, or exceeding the one-million-item limit preserve the previous complete cache.
5. Availability is tracked per section. Permission denial clears that section's old data; invalid authentication clears all data and tokens for the connection. Network errors retain timestamped caches. New accounts do not inherit old accounts' data.
6. Partial counts include known available results only. When every source is unavailable, the result is unavailable rather than zero. Cached online status reflects the latest sync result, not continuous reachability.
7. Automatic Emby updates default to off for new configurations; existing settings are preserved, while offline imports pause updates. Once enabled, lightweight updates default to 60 minutes and full-library reconciliation to 24 hours, configurable per connection. Emby requests, including login, paging, details, and posters, share at least a two-second interval per origin, a default 12-second timeout, and at most one retry by default. Different origins have independent queues; connections sharing an origin conservatively share a queue.
8. Emby posters are limited to 400 pixels in width and cached by item and image tag in SQLite, with an approximate 256 MiB limit. Arbitrary proxy URLs, SVG, redirects, and video payloads are rejected. Initial posters may appear sequentially due to rate limiting. Douban posters have a separate cache and optional S3 mirror, outside this Emby cache limit.
9. If recursive queries return unexpected media types, traversal falls back to the user's views, paginating each library and collection by `ParentId`. Contradictory folder metadata is checked through user item details. Each directory is visited once, with a 10,000-directory limit. Only complete traversal replaces the cache; failures are not presented as success or allowed to erase old data.
10. In compatibility mode, episode totals sum season `ChildCount` values. Background batches check up to 20 series, at least five minutes apart, with seven-day freshness and restart continuation. Totals appear only after all checks finish; progress is shown meanwhile. Missing counts are not zero, and old counts retain their oldest check time and errors. Initial checks across thousands of series are spread over hours, retain two-second rate limits, and do not block other servers.
11. Compatibility-mode episode details are fetched and paginated on demand. Missing or timed-out details are reported independently of season counts; counts are never used to fabricate episode rows.
12. Resource locations are read from item `Path` and `MediaSources.Path` when opening details or requesting locations, and cached for 24 hours. Only absolute local paths are returned; remote URLs and credential-like paths are hidden. Paths may refer to containers, STRM files, or virtual directories rather than physical NAS files. Unsupported or unauthorized endpoints are explicit; 404 and 403 clear old paths, while network failures may retain timestamped data.

</details>

---

## Updates and duplicate entries

Automatic Emby updates default to paused; Trakt automatic sync has a separate setting. Pausing automatic updates is not offline mode.

<details>
<summary>Expand: schedules, pause boundaries, and duplicate-resource interpretation</summary>

The master switch at the top of server settings persists across restarts and defaults to paused. The web interface exposes schedules in each server card; on Mac they are in the connection's edit window. Saving a schedule does not enable the master switch.

Pausing covers lightweight updates, full reconciliation, startup scheduling, and background season checks. In-flight requests may finish, but subsequent automatic requests stop; incomplete pagination does not replace a complete library cache. Manual updates, initial reads after adding or changing connections, details, and uncached posters may still access remote servers. Mac live viewing has its own switch. Quit the app or use forced offline preview to prevent all remote reads.

The following schedules apply only when the master switch is enabled:

| Data | Default | Configurable range |
| :--- | :--- | :--- |
| Library views, recent additions, continue watching | The three lightweight endpoints every hour | 15–1440 minutes |
| Full library, work counts, deduplication | Full metadata reconciliation daily | 12 / 24 / 48 / 168 hours, or manual only |
| Compatibility-mode season counts | Up to 20 series every five minutes; seven-day freshness | Fixed low-frequency policy |
| File or directory locations | On demand, cached for 24 hours | No background batch scanning |

“Update overview” performs lightweight reads only. Full reconciliation rereads account-visible library metadata, including pagination and compatibility traversal. A new connection must establish its initial full cache even if later reconciliation is manual only. Renaming, changing tags, or editing schedules does not trigger remote sync; changing the address or account clears the old account cache and resyncs. Manual full reconciliation does not bypass the master switch for background season tasks. `CACHE_MINUTES` controls the default lightweight interval for new connections, bounded to 15–1440 minutes; existing connections retain their saved settings.

The scheduler checks due tasks at startup and every 30 seconds, using cache timestamps, recent attempts, and backoff. Enabling updates may immediately refresh stale data rather than wait a full hour. Reauthentication and season checks add requests beyond the three lightweight endpoints.

Recent additions cannot reliably detect deletions, renames, or changed IDs, so lightweight updates are not full incremental synchronization. Film counts, deduplicated counts, and duplicate lists use the latest complete library cache. After reorganizing a library, manually reconcile it. Reconciliation reads metadata; it does not invoke an Emby disk scan, metadata scrape, or library refresh. NAS process memory has not been measured, and zero server load is not guaranteed. A large, rarely changing library can use weekly reconciliation or manual-only updates.

On Mac, the library status area and server settings open sync history, including start time, trigger, result, duration, and read counts. Records accumulate from version 0.1.15, retaining the latest 2,000 runs globally plus active runs; the window shows the latest 100 in the selected scope. Old history is not reconstructed. Douban tasks, playback history, and TTD logs are excluded. History and status read local caches; see the [Mac guide](docs/macOS使用说明.md#0115片库状态问题入口与同步记录).

The web interface offers duplicate and metadata inspection through the overview or the library's scope filter; Mac has a dedicated page. Filters cover duplicate clues, metadata doubts, uncertain season scope, and missing ID associations. Work-level counts remain conservative; inspection clues do not merge works, and different seasons of one work are not automatically duplicate resources.

Server filtering scopes the list, while related entries in details compare all connection caches with an explicit scope notice. Counts include the current entry and list each source, provider ID, season scope, and on-demand path. Multiple paths or versions on one entry do not increase entry counts. Items without shared IDs can supply manual clues through matching title/year or identical paths on the same server. No match does not prove uniqueness. File contents are not compared, deletion safety is not inferred, and remote files are not changed. See the [Mac guide](docs/macOS使用说明.md).

</details>

---

## 🔒 Security and storage

Mac configuration lives in `~/Library/Application Support/EmbyScope/`, separate from the app. The web service defaults to the repository's `data/`. They do not sync automatically; see [installation and backups](docs/macOS安装与备份.md) for import and backup procedures.

- Administrator passwords use salted scrypt hashes. Sessions store only SHA-256 hashes of random tokens; browser cookies are HttpOnly and SameSite=Strict, with a default seven-day lifetime.
- Emby usernames, passwords, user IDs, and tokens use AES-256-GCM encryption. Responses expose only allowlisted metadata. Credential forms send input to the local backend, but read APIs never return stored credentials.
- Douban poster S3 settings are also encrypted, and keys are not returned by read APIs. Editing settings on Mac stores them locally without connecting remotely. See the [backup and bucket-change limitations](docs/macOS安装与备份.md#豆瓣已看).
- `secret.key` and `embyscope.sqlite` are stored together with 0600 permissions. If a database exists without its key, startup refuses to generate a replacement key; restore the complete backup.
- Encryption protects a database leaked alone. Anyone with the complete configuration directory can decrypt credentials, so protect the entire backup. Request bodies, remote responses, and raw exception objects are not logged.
- Web management APIs require login. Mac requires an administrator session only when its optional startup password is enabled, but all desktop requests still validate a per-launch key and local origin. Writes require JSON, a custom header, and same-origin checks. Login attempts are rate-limited; proxy-supplied client IPs are not trusted.
- Connections to NAS and private network addresses are deliberate administrator choices. This is not an arbitrary URL proxy for public visitors.
- HTTP Emby addresses transmit credentials without transport encryption; HTTPS is recommended for remote servers. TLS checks remain enabled, and redirects are not automatically followed with tokens.

---

## 📚 Documentation

The detailed guides below are currently in Chinese.

| Document | Contents |
| :--- | :--- |
| [Mac user guide](docs/macOS使用说明.md) | Navigation, viewing records, episode audits, and version-specific behavior |
| [Mac installation and backups](docs/macOS安装与备份.md) | Installation, upgrades, offline import, backup, and restore |
| [NAS deployment](docs/部署说明.md) | Cloud builds, ZSpace setup, environment variables, and troubleshooting |
| [Mac validation records](docs/macOS验收记录.md) | Native UI validation and remaining limits |
| [Web validation records](docs/验收记录.md) | Simulated interfaces, pages, and container checks |
| [Design reviews](docs/设计审查.md) | Design decisions, tradeoffs, and review evidence |
| [Project lessons](docs/lessons/INDEX.md) | Validated approaches, known problems, and applicability |

---

## 🤝 Development and validation

The business service uses JavaScript and the native interface uses SwiftUI. Read both [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) before making changes, and consult the lessons index before troubleshooting.

```bash
fnm use
npm test
npm run check
```

For native Mac changes, also run:

```bash
swift test --package-path desktop
```

Tests cover server isolation, identity matching, complete pagination, permission failures, credential protection, rate limits, caching, and episode classification. Simulated checks do not replace real-server validation; consult the records above for scope.

Use a separate branch and keep each commit focused. Follow the repository's `type: 中文描述` convention for commit messages. Include relevant validation results in pull requests, and never commit real credentials, configuration backups, or private library data.

<details>
<summary>Code structure</summary>

```text
src/server.js          HTTP、认证、会话、静态页面和 API
src/store.js           SQLite 与凭据加密
src/emby.js            Emby 请求、限流、超时与重试
src/service.js         连接、同步、缓存、统计与海报
src/identity.js        作品标识、数据白名单与保守归组
src/comparison.js      重复线索与元数据疑点
src/episode-audit.js   缺集检查与跨来源对照
src/resources.js       资源路径与敏感信息过滤
src/home.js            首页观看快照
src/playback*.js       会话读取与兼容活动检测
src/sync-history.js    服务器同步执行记录
src/douban*.js         豆瓣已看、列表解析与海报补全
src/trakt*.js          Trakt 授权、观看快照与海报缓存
src/poster-s3.js       S3 签名读取与镜像上传
desktop/              SwiftUI 界面、数据模型与桌面内核入口
public/               中文响应式网页界面
test/                 模拟 Emby 与业务测试
scripts/              演示、构建、迁移与容器验收
```

</details>

API references: [Emby authentication](https://dev.emby.media/doc/restapi/User-Authentication.html), [user-library browsing](https://dev.emby.media/doc/restapi/Browsing-the-Library.html), and [ItemsService](https://dev.emby.media/reference/RestAPI/ItemsService.html). The initial interface took inspiration from TTD’s media-overview information order; it neither reads nor copies TTD credentials and does not alter TTD configuration.

The project currently has no LICENSE file and declares no open-source license. Packaged Node.js runtimes retain their own license file.

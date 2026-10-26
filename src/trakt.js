import { setTimeout as sleep } from 'node:timers/promises'
import { RateLimiter, RemoteError } from './emby.js'
import { TraktPosters, posterUrl, withPoster } from './trakt-posters.js'

const API_ORIGIN = 'https://api.trakt.tv'
const AUTH_ORIGIN = 'https://auth.trakt.tv'
const KINDS = ['recent', 'watched', 'playback']
const MAX_PAGES = 1000
const MAX_ITEMS = 100000
const AUTOMATIC_SYNC_INTERVAL = 30 * 60 * 1000
const text = (value, max = 500) => typeof value === 'string' && value.length <= max ? value : null
const date = value => text(value, 40) && Number.isFinite(Date.parse(value)) ? value : null
const id = value => Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : null
const invalid = () => new RemoteError('Trakt 数据格式异常，原缓存已保留', 502)

// 只保留展示所需字段，不缓存原始响应、来源凭据或未经验证的外链。
export function traktItem(value, type) {
  const media = value?.[type]
  const mediaId = id(media?.ids?.trakt)
  if (!mediaId || !['movie', 'episode'].includes(type)) throw invalid()
  const title = text(media.title)
  if (!title) throw invalid()
  const show = type === 'episode' ? value.show : null
  if (type === 'episode' && (!id(show?.ids?.trakt) || !text(show?.title) || !Number.isInteger(media.season) || media.season < 0 || !Number.isInteger(media.number) || media.number < 0)) throw invalid()
  return {
    id: `${type}:${mediaId}`, type, title, year: Number.isInteger(media.year) ? media.year : null,
    showTitle: show?.title ?? null, showId: id(show?.ids?.trakt), showTmdbId: id(show?.ids?.tmdb),
    season: type === 'episode' ? media.season : null, episode: type === 'episode' ? media.number : null,
    traktId: mediaId, tmdbId: id(media.ids.tmdb), imdbId: /^tt\d+$/.test(media.ids.imdb ?? '') ? media.ids.imdb : null,
    posterUrl: posterUrl((show ?? media).images?.poster?.[0]),
    watchedAt: null, pausedAt: null, progress: null, plays: null
  }
}

export class TraktService {
  constructor(store, { fetchImpl = fetch, limiter = new RateLimiter(), offline = () => false, now = Date.now } = {}) {
    this.store = store
    this.fetchImpl = fetchImpl
    this.limiter = limiter
    this.offline = offline
    this.now = now
    this.revision = 0
    this.job = null
    this.controller = null
    this.device = null
    this.state = 'idle'
    this.stopping = false
    this.retryAt = this.read('traktRetryAt') || 0
    this.automaticJob = false
    this.store.db.exec('CREATE TABLE IF NOT EXISTS trakt_cache (kind TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt TEXT NOT NULL)')
    this.posters = new TraktPosters(this)
  }
  read(name, encrypted = false) {
    const row = this.store.db.prepare('SELECT value FROM settings WHERE name=?').get(name)
    return row ? encrypted ? this.store.decrypt(row.value) : JSON.parse(row.value) : null
  }
  write(name, value, encrypted = false) {
    this.store.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
      .run(name, encrypted ? this.store.encrypt(value) : JSON.stringify(value))
  }
  credentials() { return this.read('traktCredentials', true) || {} }
  status() {
    const credentials = this.credentials()
    const caches = this.store.db.prepare('SELECT kind, updatedAt, json_array_length(data) AS count FROM trakt_cache').all()
    return {
      automaticSync: this.read('traktAutomaticSync') === true,
      posterConfigured: !!this.read('traktPosterCredentials', true)?.tmdbToken,
      configured: !!credentials.clientId, connected: !!credentials.accessToken,
      account: credentials.account || null, state: this.state, offline: this.offline(),
      error: this.read('traktError'), updatedAt: caches[0]?.updatedAt ?? null,
      counts: Object.fromEntries(KINDS.map(kind => [kind, caches.find(row => row.kind === kind)?.count ?? 0])),
      device: this.device ? { userCode: this.device.userCode, verificationUrl: this.device.verificationUrl, expiresAt: this.device.expiresAt } : null
    }
  }
  list(params) {
    const kind = params.get('kind') || 'recent'
    if (!KINDS.includes(kind)) throw new RemoteError('Trakt 列表类型无效', 400)
    const row = this.store.db.prepare('SELECT data, updatedAt FROM trakt_cache WHERE kind=?').get(kind)
    const q = (params.get('q') || '').trim().toLocaleLowerCase().slice(0, 200)
    const type = params.get('type') || ''
    if (type && !['movie', 'episode'].includes(type)) throw new RemoteError('影视类型无效', 400)
    const items = (row ? JSON.parse(row.data) : []).filter(item => (!type || item.type === type) && (!q || `${item.title} ${item.showTitle || ''}`.toLocaleLowerCase().includes(q)))
    const pages = Math.max(1, Math.ceil(items.length / 24))
    const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page'), 10) || 1))
    return { items: items.slice((page - 1) * 24, page * 24).map(withPoster), total: items.length, pages, page, updatedAt: row?.updatedAt ?? null, available: !!row }
  }
  home() {
    const collection = kind => {
      const row = this.store.db.prepare('SELECT data FROM trakt_cache WHERE kind=?').get(kind)
      const seen = new Set()
      return (row ? JSON.parse(row.data) : []).map(withPoster).filter(item => {
        const key = item.posterPath || item.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 8)
    }
    return { status: this.status(), recent: collection('recent'), playback: collection('playback') }
  }
  ensureOnline() {
    if (this.stopping || this.offline()) throw new RemoteError('离线模式或应用退出中，未访问 Trakt', 409)
  }
  configure({ clientId }) {
    if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{16,200}$/.test(clientId.trim())) throw new RemoteError('请输入有效的 Trakt Client ID', 400)
    if (clientId.trim() === this.credentials().clientId) return this.status()
    this.disconnect()
    this.write('traktCredentials', { clientId: clientId.trim() }, true)
    return this.status()
  }
  configureAutomaticSync({ enabled }) {
    if (typeof enabled !== 'boolean') throw new RemoteError('自动同步开关必须是布尔值', 400)
    this.write('traktAutomaticSync', enabled)
    if (!enabled && this.automaticJob) this.cancel()
    return this.status()
  }
  startIfDue() {
    const status = this.status()
    if (!status.automaticSync || !status.connected || status.offline || this.stopping || this.job) return status
    const latest = Math.max(Date.parse(status.updatedAt) || 0, this.read('traktLastAttemptAt') || 0)
    if (this.now() < this.retryAt || this.now() - latest < AUTOMATIC_SYNC_INTERVAL) return status
    const next = this.start()
    this.automaticJob = true
    return next
  }
  disconnect() {
    this.cancel()
    this.posters.clear()
    const clientId = this.credentials().clientId
    this.store.db.exec('BEGIN')
    try {
      this.write('traktCredentials', { clientId }, true)
      this.write('traktError', null)
      this.write('traktLastAttemptAt', null)
      this.store.db.exec('DELETE FROM trakt_cache; COMMIT')
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
    return this.status()
  }
  cancel() {
    if (this.state === 'syncing') this.write('traktLastAttemptAt', this.now())
    this.revision++
    this.controller?.abort()
    this.device = null
    this.state = 'idle'
    return this.status()
  }
  check(revision, signal) {
    signal.throwIfAborted()
    this.ensureOnline()
    if (revision !== this.revision) throw new RemoteError('Trakt 连接已改变', 409)
  }
  async request(path, { body, token, signal, clientId, allowPending = false } = {}) {
    const oauth = ['/oauth/device/code', '/oauth/device/token', '/oauth/token'].includes(path)
    const pathname = path.split('?')[0]
    if (!oauth && !/^\/(movies|shows)\/[1-9]\d{0,19}$/.test(pathname) && !['/users/settings', '/sync/history', '/sync/watched/movies', '/sync/watched/shows', '/sync/playback'].includes(pathname)) throw new RemoteError('Trakt 请求不在只读白名单内', 400)
    if (!oauth && body) throw new RemoteError('不允许修改 Trakt 记录', 400)
    return this.limiter.run('trakt', async () => {
      this.ensureOnline()
      if (this.now() < this.retryAt) throw new RemoteError('Trakt 正在限流，请稍后重试', 429)
      const response = await this.fetchImpl(`${oauth ? AUTH_ORIGIN : API_ORIGIN}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'EmbyScope/0.1.19', 'trakt-api-version': '2', 'trakt-api-key': clientId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(25000)])
      })
      if (allowPending && response.status === 400) { await response.body?.cancel(); return { pending: true } }
      if (!response.ok) {
        if (response.status === 429) {
          const raw = response.headers.get('retry-after')
          const delay = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - this.now()
          this.retryAt = this.now() + Math.max(60000, Number.isFinite(delay) ? delay : 0)
          this.write('traktRetryAt', this.retryAt)
        }
        const html = (response.headers.get('content-type') || '').includes('text/html')
        await response.body?.cancel()
        const messages = { 400: 'Trakt 授权失效，请重新连接', 401: 'Trakt 授权失效，请重新连接', 403: html ? 'Trakt 请求被网络防护拦截，请检查连接后重试' : 'Trakt 拒绝访问，请核对应用授权', 404: 'Trakt 接口或授权码不可用', 409: 'Trakt 授权码已使用，请重新连接', 410: 'Trakt 授权码已过期，请重新连接', 418: 'Trakt 授权被拒绝', 429: 'Trakt 正在限流，请稍后重试' }
        const message = path === '/oauth/device/code' && response.status === 401
          ? 'Trakt 未识别此应用 Client ID，请核对开发者应用配置'
          : messages[response.status] || 'Trakt 返回异常，原缓存已保留'
        const error = new RemoteError(message, 502)
        error.remoteStatus = response.status
        throw error
      }
      if (!(response.headers.get('content-type') || '').includes('application/json')) { await response.body?.cancel(); throw invalid() }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) throw new RemoteError('Trakt 响应过大，原缓存已保留', 502)
        chunks.push(chunk)
      }
      let data
      try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { throw invalid() }
      return { data, headers: response.headers }
    }, signal)
  }
  launch(state, work) {
    this.ensureOnline()
    if (this.job) throw new RemoteError('Trakt 任务正在进行，请稍后重试', 409)
    this.controller = new AbortController()
    const signal = this.controller.signal
    const revision = ++this.revision
    this.state = state
    this.write('traktError', null)
    const job = Promise.resolve().then(() => work(revision, signal)).catch(error => {
      if (revision === this.revision && !signal.aborted) this.write('traktError', error instanceof RemoteError ? error.message : 'Trakt 连接失败或超时，原缓存已保留')
    }).finally(() => {
      if (revision === this.revision) {
        if (this.state === 'syncing') this.write('traktLastAttemptAt', this.now())
        this.state = 'idle'; this.device = null
      }
      if (this.job === job) { this.job = null; this.automaticJob = false }
    })
    this.job = job
    return this.status()
  }
  connect() {
    const { clientId } = this.credentials()
    if (!clientId) throw new RemoteError('请先配置 Trakt Client ID', 400)
    return this.launch('authorizing', async (revision, signal) => {
      const { data } = await this.request('/oauth/device/code', { body: { client_id: clientId }, clientId, signal })
      this.check(revision, signal)
      let verify
      try { verify = new URL(data.verification_url) } catch { throw invalid() }
      if (verify.protocol !== 'https:' || !['trakt.tv', 'www.trakt.tv', 'auth.trakt.tv'].includes(verify.hostname) || verify.username || verify.password || verify.port) throw invalid()
      if (!text(data.device_code, 4096) || !text(data.user_code, 64) || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 3600 || !Number.isFinite(data.interval) || data.interval <= 0 || data.interval > 3600) throw invalid()
      const expiresAt = this.now() + data.expires_in * 1000
      this.device = { userCode: data.user_code, verificationUrl: verify.href, expiresAt: new Date(expiresAt).toISOString() }
      while (this.now() < expiresAt) {
        await sleep(Math.max(2000, data.interval * 1000, this.retryAt - this.now()), undefined, { signal })
        this.check(revision, signal)
        if (this.now() >= expiresAt) break
        let result
        try {
          result = await this.request('/oauth/device/token', { body: { client_id: clientId, code: data.device_code }, clientId, signal, allowPending: true })
        } catch (error) { if (error.remoteStatus === 429) continue; throw error }
        if (result.pending) continue
        this.check(revision, signal)
        const tokens = this.tokens(result.data)
        const { data: settings } = await this.request('/users/settings', { token: tokens.accessToken, clientId, signal })
        this.check(revision, signal)
        if (!text(settings?.user?.username, 200) || !text(settings.user.ids?.slug, 200)) throw invalid()
        // 新账号完成身份确认后才替换授权，同时清掉旧账号快照。
        this.posters.clear()
        this.store.db.exec('BEGIN')
        try {
          this.write('traktCredentials', { clientId, ...tokens, account: settings.user.username, accountId: settings.user.ids.slug }, true)
          this.store.db.exec('DELETE FROM trakt_cache; COMMIT')
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
        this.device = null
        this.state = 'syncing'
        await this.sync(revision, signal)
        return
      }
      throw new RemoteError('Trakt 授权码已过期，请重新连接', 502)
    })
  }
  tokens(value) {
    if (!text(value?.access_token, 4096) || !text(value?.refresh_token, 4096) || value.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || !Number.isFinite(value.created_at)) throw invalid()
    return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: (value.created_at + value.expires_in) * 1000 }
  }
  start() {
    if (!this.credentials().accessToken) throw new RemoteError('请先连接 Trakt', 409)
    return this.launch('syncing', (revision, signal) => this.sync(revision, signal))
  }
  async authorized(revision, signal) {
    let credentials = this.credentials()
    if (!credentials.accessToken) throw new RemoteError('请重新连接 Trakt', 409)
    if (credentials.expiresAt > this.now() + 60000) return credentials
    try {
      const { data } = await this.request('/oauth/token', { clientId: credentials.clientId, signal, body: { client_id: credentials.clientId, refresh_token: credentials.refreshToken, grant_type: 'refresh_token' } })
      this.check(revision, signal)
      credentials = { ...credentials, ...this.tokens(data) }
      // 刷新令牌单次使用，必须先持久化新令牌，再读取资料或允许后续刷新。
      this.write('traktCredentials', credentials, true)
      return credentials
    } catch (error) {
      if ([400, 401].includes(error.remoteStatus) && revision === this.revision) {
        delete credentials.accessToken
        delete credentials.refreshToken
        this.write('traktCredentials', credentials, true)
      }
      throw error
    }
  }
  async pages(path, credentials, revision, signal, firstOnly = false) {
    const result = []
    const seen = new Set()
    let expectedPages, expectedCount
    const extended = path === '/sync/watched/shows' ? 'progress' : 'full'
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, headers } = await this.request(`${path}?page=${page}&limit=${firstOnly ? 50 : 100}&extended=${extended}`, { token: credentials.accessToken, clientId: credentials.clientId, signal })
      this.check(revision, signal)
      if (!Array.isArray(data)) throw invalid()
      const fingerprint = JSON.stringify(data)
      if (data.length && seen.has(fingerprint)) throw invalid()
      seen.add(fingerprint)
      result.push(...data)
      if (result.length > MAX_ITEMS) throw invalid()
      if (firstOnly) return result
      const pagination = ['page', 'page-count', 'item-count'].map(key => headers.get(`x-pagination-${key}`))
      if (pagination.every(value => value === null)) {
        // 老接口无分页头时可能返回全量；无法证明完整，拒绝覆盖已有集合。
        throw new RemoteError('Trakt 未返回完整分页信息，原缓存已保留', 502)
      }
      if (pagination.some(value => value === null || !/^\d+$/.test(value))) throw invalid()
      const [actualPage, totalPages, totalCount] = pagination.map(Number)
      if (actualPage !== page || totalPages > MAX_PAGES || totalCount > MAX_ITEMS || !Number.isSafeInteger(totalCount) || totalPages < 0 || (totalPages === 0 && totalCount !== 0)) throw invalid()
      if (page === 1) { expectedPages = totalPages; expectedCount = totalCount }
      if (totalPages !== expectedPages || totalCount !== expectedCount) throw new RemoteError('Trakt 分页期间记录变化，请重新同步', 502)
      if (page >= totalPages) {
        if (result.length !== totalCount) throw invalid()
        return result
      }
      if (!data.length) throw invalid()
    }
    throw invalid()
  }
  async sync(revision, signal) {
    this.check(revision, signal)
    // 手动与自动共用尝试时间，失败、取消及重启后也不会立即自动重试。
    this.write('traktLastAttemptAt', this.now())
    const credentials = await this.authorized(revision, signal)
    try {
      const history = await this.pages('/sync/history', credentials, revision, signal, true)
      const movies = await this.pages('/sync/watched/movies', credentials, revision, signal)
      const shows = await this.pages('/sync/watched/shows', credentials, revision, signal)
      const playback = await this.pages('/sync/playback', credentials, revision, signal)
      const recent = history.map(value => {
        const item = traktItem(value, value.type)
        if (!date(value.watched_at)) throw invalid()
        return { ...item, watchedAt: value.watched_at }
      })
      const watched = movies.map(value => {
        const item = traktItem(value, 'movie')
        if (!date(value.last_watched_at) || !Number.isInteger(value.plays) || value.plays < 1) throw invalid()
        return { ...item, watchedAt: value.last_watched_at, plays: value.plays }
      })
      for (const value of shows) {
        if (!id(value.show?.ids?.trakt) || !Array.isArray(value.seasons)) throw invalid()
        for (const season of value.seasons) {
          if (!Number.isInteger(season.number) || season.number < 0 || !Array.isArray(season.episodes)) throw invalid()
          for (const episode of season.episodes) {
            if (!Number.isInteger(episode.number) || episode.number < 0 || !Number.isInteger(episode.plays) || episode.plays < 1 || !date(episode.last_watched_at) || !text(value.show.title)) throw invalid()
            // 已看接口可能只有剧集编号和季集号，不能伪造单集 Trakt ID。
            watched.push({ id: `show:${id(value.show.ids.trakt)}:${season.number}:${episode.number}`, type: 'episode', title: `第 ${episode.number} 集`, showTitle: value.show.title, showId: id(value.show.ids.trakt), showTmdbId: id(value.show.ids.tmdb), season: season.number, episode: episode.number, year: null, traktId: null, tmdbId: null, imdbId: null, watchedAt: episode.last_watched_at, pausedAt: null, progress: null, plays: episode.plays })
            if (watched.length > MAX_ITEMS) throw invalid()
          }
        }
      }
      const progress = playback.map(value => {
        const item = traktItem(value, value.type)
        if (!date(value.paused_at) || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 100) throw invalid()
        return { ...item, pausedAt: value.paused_at, progress: value.progress }
      })
      const unique = (items, field) => [...new Map(items.sort((a, b) => Date.parse(b[field]) - Date.parse(a[field])).reverse().map(item => [item.id, item])).values()].sort((a, b) => Date.parse(b[field]) - Date.parse(a[field]))
      this.check(revision, signal)
      const updatedAt = new Date(this.now()).toISOString()
      this.store.db.exec('BEGIN')
      try {
        for (const [kind, items] of [['recent', unique(recent, 'watchedAt')], ['watched', unique(watched, 'watchedAt')], ['playback', unique(progress, 'pausedAt')]]) {
          this.store.db.prepare('INSERT INTO trakt_cache VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt').run(kind, JSON.stringify(items), updatedAt)
        }
        this.write('traktError', null)
        this.store.db.exec('COMMIT')
      } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
    } catch (error) {
      if (error.remoteStatus === 401 && revision === this.revision) {
        delete credentials.accessToken
        delete credentials.refreshToken
        this.write('traktCredentials', credentials, true)
      }
      throw error
    }
  }
  async close() { this.stopping = true; this.cancel(); await Promise.allSettled([this.job, this.posters.close()]) }
}

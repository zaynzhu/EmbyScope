import { RemoteError } from './emby.js'
import { imageMime } from './image.js'

export function posterUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value.startsWith('https://') ? value : `https://${value}`)
    return url.protocol === 'https:' && ['media.trakt.tv', 'walter-r2.trakt.tv'].includes(url.hostname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/images\/[\w/.-]+\.(webp|jpg|jpeg|png)$/.test(url.pathname) ? url.href : null
  } catch { return null }
}
export function withPoster(item) {
  const mediaId = item.type === 'movie' ? item.traktId : item.showId
  const { posterUrl: remote, ...result } = item
  return { ...result, posterPath: /^[1-9]\d{0,19}$/.test(mediaId ?? '') ? `api/trakt/posters/${item.type === 'movie' ? 'movies' : 'shows'}/${mediaId}` : null }
}

export class TraktPosters {
  constructor(service) {
    this.service = service
    this.jobs = new Map()
    this.retired = new Set()
    this.tmdbRetryAt = 0
    this.controller = new AbortController()
    service.store.db.exec('CREATE TABLE IF NOT EXISTS trakt_posters (key TEXT PRIMARY KEY, mime TEXT, data BLOB, checkedAt INTEGER NOT NULL)')
  }
  clear() {
    this.controller.abort()
    for (const job of this.jobs.values()) this.retired.add(job)
    this.jobs.clear()
    this.controller = new AbortController()
    this.service.store.db.exec('DELETE FROM trakt_posters')
  }
  async close() {
    this.controller.abort()
    await Promise.allSettled([...this.jobs.values(), ...this.retired])
  }
  configure({ tmdbToken }) {
    if (typeof tmdbToken !== 'string' || (tmdbToken.trim() && !/^[A-Za-z0-9_.-]{16,2048}$/.test(tmdbToken.trim()))) throw new RemoteError('请输入有效的 TMDB API 读取令牌或 API Key', 400)
    this.clear()
    this.service.write('traktPosterCredentials', { tmdbToken: tmdbToken.trim() }, true)
    return this.service.status()
  }
  async get(kind, mediaId) {
    const service = this.service
    const key = `${kind}/${mediaId}`
    const path = `api/trakt/posters/${key}`
    const matches = service.store.db.prepare('SELECT data FROM trakt_cache').all()
      .flatMap(row => JSON.parse(row.data)).filter(item => withPoster(item).posterPath === path)
    if (!matches.length) throw new RemoteError('没有这条 Trakt 记录', 404)
    const cached = service.store.db.prepare('SELECT * FROM trakt_posters WHERE key=?').get(key)
    if (cached?.data) return { buffer: Buffer.from(cached.data), mime: cached.mime }
    if (cached && service.now() - cached.checkedAt < 86400000) throw new RemoteError('Trakt 暂无此作品海报', 404)
    service.ensureOnline()
    if (this.jobs.has(key)) return this.jobs.get(key)
    const signal = this.controller.signal
    const job = this.download(kind, mediaId, matches, signal).finally(() => {
      this.retired.delete(job)
      if (this.jobs.get(key) === job) this.jobs.delete(key)
    })
    this.jobs.set(key, job)
    return job
  }
  async tmdbPoster(kind, mediaId, token, signal) {
    const service = this.service
    return service.limiter.run('tmdb', async () => {
      service.ensureOnline()
      signal.throwIfAborted()
      if (service.now() < this.tmdbRetryAt) throw new RemoteError('TMDB 正在限流，请稍后重试', 429)
      const url = new URL(`https://api.themoviedb.org/3/${kind === 'movies' ? 'movie' : 'tv'}/${mediaId}`)
      url.searchParams.set('language', 'zh-CN')
      const headers = { Accept: 'application/json', 'User-Agent': 'EmbyScope/0.1.19' }
      if (token.includes('.')) headers.Authorization = `Bearer ${token}`
      else url.searchParams.set('api_key', token)
      const response = await service.fetchImpl(url.href, { headers, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) })
      if (!response.ok) {
        if (response.status === 429) this.tmdbRetryAt = service.now() + Math.max(60000, (Number(response.headers.get('retry-after')) || 0) * 1000)
        await response.body?.cancel()
        throw new RemoteError([401, 403].includes(response.status) ? 'TMDB 图片授权不可用，请检查海报配置' : 'TMDB 海报信息暂不可用', 502)
      }
      if (!(response.headers.get('content-type') || '').includes('application/json')) { await response.body?.cancel(); throw new RemoteError('TMDB 数据格式异常', 502) }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) throw new RemoteError('TMDB 响应过大', 502)
        chunks.push(chunk)
      }
      let data
      try { data = JSON.parse(Buffer.concat(chunks)) } catch { throw new RemoteError('TMDB 数据格式异常', 502) }
      if (String(data?.id) !== mediaId) throw new RemoteError('TMDB 海报作品标识不符', 502)
      return /^\/[A-Za-z0-9_-]+\.(jpg|png)$/.test(data.poster_path ?? '') ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null
    }, signal)
  }
  async download(kind, mediaId, matches, signal) {
    const service = this.service
    const key = `${kind}/${mediaId}`
    const tmdbToken = service.read('traktPosterCredentials', true)?.tmdbToken
    let tmdbId = matches.map(item => kind === 'movies' ? item.tmdbId : item.showTmdbId).find(value => /^[1-9]\d{0,19}$/.test(value ?? ''))
    let url = tmdbToken ? null : matches.map(item => posterUrl(item.posterUrl)).find(Boolean)
    if (tmdbToken ? !tmdbId : !url) {
      const { data } = await service.request(`/${kind}/${mediaId}?extended=full`, { clientId: service.credentials().clientId, signal })
      signal.throwIfAborted()
      if (String(data?.ids?.trakt) !== mediaId) throw new RemoteError('Trakt 海报作品标识不符', 502)
      tmdbId = String(data.ids.tmdb ?? '')
      url = posterUrl(data.images?.poster?.[0])
    }
    if (tmdbToken) url = /^[1-9]\d{0,19}$/.test(tmdbId ?? '') ? await this.tmdbPoster(kind, tmdbId, tmdbToken, signal) : null
    if (!url) {
      signal.throwIfAborted()
      service.store.db.prepare('INSERT OR REPLACE INTO trakt_posters VALUES(?,NULL,NULL,?)').run(key, service.now())
      throw new RemoteError('Trakt 暂无此作品海报', 404)
    }
    return service.limiter.run(tmdbToken ? 'tmdb' : 'trakt', async () => {
      service.ensureOnline()
      signal.throwIfAborted()
      if (service.now() < (tmdbToken ? this.tmdbRetryAt : service.retryAt)) throw new RemoteError('Trakt 正在限流，请稍后重试', 429)
      const response = await service.fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': 'EmbyScope/0.1.19', Accept: 'image/webp,image/*' }, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) })
      if (!response.ok) {
        if (response.status === 429) {
          if (tmdbToken) this.tmdbRetryAt = service.now() + 60000
          else service.retryAt = service.now() + 60000
        }
        await response.body?.cancel()
        throw new RemoteError('Trakt 海报暂不可用', 502)
      }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new RemoteError('Trakt 海报过大', 502)
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)
      const mime = imageMime(buffer)
      if (!mime) throw new RemoteError('Trakt 海报格式无效', 502)
      signal.throwIfAborted()
      service.ensureOnline()
      service.store.db.prepare('INSERT OR REPLACE INTO trakt_posters VALUES(?,?,?,?)').run(key, mime, buffer, service.now())
      // 只下载可见作品；磁盘图片总量限制为 64 MiB，超限淘汰最早缓存。
      let total = service.store.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS total FROM trakt_posters').get().total
      for (const row of service.store.db.prepare('SELECT key, length(data) AS size FROM trakt_posters WHERE data IS NOT NULL ORDER BY checkedAt').all()) {
        if (total <= 64 * 1024 * 1024) break
        service.store.db.prepare('DELETE FROM trakt_posters WHERE key=?').run(row.key)
        total -= row.size
      }
      return { buffer, mime }
    }, signal)
  }
}

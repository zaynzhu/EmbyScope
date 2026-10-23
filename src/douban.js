import { RateLimiter, RemoteError } from './emby.js'
import { parseDoubanPage, validDoubanDate } from './douban-parser.js'
import { DoubanPosters } from './douban-posters.js'
import { PosterS3 } from './poster-s3.js'

export function readDoubanState(store) {
  const value = store.db.prepare("SELECT value FROM settings WHERE name='doubanState'").get()?.value
  return value ? JSON.parse(value) : { account: '', checkpoint: null, lastRun: null, importedAt: null }
}
export function saveDoubanState(store, state) {
  store.db.prepare("INSERT INTO settings VALUES('doubanState',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(JSON.stringify(state))
}
export function allowedPoster(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      (/^img\d+\.doubanio\.com$/.test(url.hostname) || /^img\d+\.douban\.com$/.test(url.hostname) || url.hostname === 'image.tmdb.org')
  } catch { return false }
}
export function imageMime(bytes) {
  bytes = Buffer.from(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

export class DoubanService {
  constructor(store, { fetchImpl = fetch, limiter = new RateLimiter(), offline = () => false } = {}) {
    this.store = store
    this.fetchImpl = fetchImpl
    this.limiter = limiter
    this.offline = offline
    this.job = null
    this.controller = null
    this.stopping = false
    this.posterJobs = new Map()
    this.posterController = new AbortController()
    this.s3 = new PosterS3(this)
    this.posters = new DoubanPosters(this, { allowed: allowedPoster, imageMime })
    const state = readDoubanState(store)
    if (state.lastRun?.state === 'running') {
      state.lastRun = { ...state.lastRun, state: 'interrupted', error: '上次同步因应用退出中断，原数据和同步日期已保留', finishedAt: new Date().toISOString() }
      saveDoubanState(store, state)
    }
  }
  status() {
    const state = readDoubanState(this.store)
    const counts = Object.fromEntries(this.store.db.prepare('SELECT type,count(*) AS count FROM douban_items GROUP BY type').all().map(row => [row.type, row.count]))
    return { ...state, posters: this.posters.status(), total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      movies: counts.Movie || 0, series: counts.Series || 0, unknown: counts.Unknown || 0,
      syncing: !!this.job, offline: this.offline(), canIncremental: !!state.account && validDoubanDate(state.checkpoint) }
  }
  configure({ account }) {
    if (this.job) throw new RemoteError('请先停止当前豆瓣同步', 409)
    if (typeof account !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(account)) throw new RemoteError('请填写豆瓣个人主页中的账号标识', 400)
    const state = readDoubanState(this.store)
    if (state.account && state.account !== account && this.status().total > 0) throw new RemoteError('已有数据绑定了原豆瓣账号，不能混入其他账号', 409)
    saveDoubanState(this.store, { ...state, account, checkpoint: state.account === account ? state.checkpoint : null })
    return this.status()
  }
  list(params) {
    const q = (params.get('q') || '').trim().slice(0, 200).toLocaleLowerCase()
    const type = params.get('type') || ''
    let rows = this.store.db.prepare('SELECT data FROM douban_items').all().map(row => JSON.parse(row.data))
    if (type) rows = rows.filter(item => item.type === type)
    if (q) rows = rows.filter(item => `${item.title} ${item.altTitle || ''}`.toLocaleLowerCase().includes(q))
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.id.localeCompare(b.id))
    const pages = Math.max(1, Math.ceil(rows.length / 24))
    const page = Math.min(pages, Math.max(1, Math.floor(Number(params.get('page')) || 1)))
    return { items: rows.slice((page - 1) * 24, page * 24), total: rows.length, page, pages }
  }
  start(mode) {
    if (!['full', 'incremental'].includes(mode)) throw new RemoteError('请选择全量或增量同步', 400)
    if (this.stopping || this.offline()) throw new RemoteError('离线模式不能同步豆瓣', 409)
    if (this.job) throw new RemoteError('豆瓣同步正在进行', 409)
    if (this.posters.job) throw new RemoteError('请先等待海报补全结束或停止补图', 409)
    const state = readDoubanState(this.store)
    if (!state.account) throw new RemoteError('请先设置豆瓣账号', 400)
    if (mode === 'incremental' && !validDoubanDate(state.checkpoint)) throw new RemoteError('缺少有效的增量进度，请先完成全量同步', 409)
    this.controller = new AbortController()
    const run = { mode, state: 'running', scanned: 0, pages: 0, imported: 0, updated: 0, skipped: 0,
      startedAt: new Date().toISOString(), finishedAt: null, error: null }
    saveDoubanState(this.store, { ...state, lastRun: run })
    this.job = this.sync(state, run, this.controller.signal).catch(error => {
      run.state = this.stopping ? 'interrupted' : this.controller.signal.aborted ? 'cancelled' : 'failed'
      run.error = this.controller.signal.aborted ? '同步已停止，原数据和同步日期已保留' : error instanceof RemoteError ? error.message : '豆瓣连接失败或请求超时，原进度已保留'
      run.finishedAt = new Date().toISOString()
      saveDoubanState(this.store, { ...state, lastRun: run })
    }).finally(() => { this.job = null; this.controller = null })
    return this.status()
  }
  cancel() { this.controller?.abort(); return this.status() }
  async read(url, signal, { image = false, json = false, missingIsNull = false } = {}) {
    const service = new URL(url).hostname === 'image.tmdb.org' ? 'tmdb-images' : 'douban'
    return this.limiter.run(service, async () => {
      signal.throwIfAborted()
      if (this.offline() || this.stopping) throw new RemoteError('当前模式不允许联网', 409)
      const response = await this.fetchImpl(url, { redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
        headers: { Accept: image ? 'image/*' : json ? 'application/json' : 'text/html,application/xhtml+xml',
          ...(image && service === 'douban' ? { Referer: 'https://movie.douban.com/' } : {}),
          'Accept-Language': 'zh-CN,zh;q=0.9', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.6 Safari/605.1.15',
          ...(new URL(url).hostname === 'm.douban.com' ? { Referer: 'https://m.douban.com/tv', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' } : {}) } })
      if (!response.ok) {
        await response.body?.cancel()
        if (missingIsNull && response.status === 404) return null
        throw new RemoteError([401, 403, 429].includes(response.status) ? `豆瓣限制访问或需要登录验证（HTTP ${response.status}），已停止，请稍后在浏览器检查` : `豆瓣返回异常或重定向（HTTP ${response.status}），已停止读取`, 502)
      }
      const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase()
      if (!image && !(json ? ['application/json'] : ['text/html', 'application/xhtml+xml']).includes(mime)) {
        await response.body?.cancel()
        throw new RemoteError(json ? '豆瓣未返回有效海报查询结果，已停止' : '豆瓣未返回有效列表网页', 502)
      }
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > (image ? 8 : 3) * 1024 * 1024) throw new RemoteError('响应过大，已停止读取', 502)
        chunks.push(chunk)
      }
      signal.throwIfAborted()
      return Buffer.concat(chunks)
    }, signal)
  }
  async sync(state, run, signal) {
    const seen = new Map()
    let offset = 0
    let previousDate = null
    let finished = false
    for (let page = 0; page < 500; page++) {
      signal.throwIfAborted()
      const url = new URL(`https://movie.douban.com/people/${encodeURIComponent(state.account)}/collect`)
      url.search = new URLSearchParams({ start: String(offset), sort: 'time', rating: 'all', filter: 'all', mode: 'list' })
      const items = parseDoubanPage((await this.read(url, signal)).toString('utf8'))
      if (!items.length) { finished = true; break }
      if (items.every(item => seen.has(item.id))) throw new RemoteError('豆瓣重复返回同一页，已停止，原进度已保留', 502)
      let older = false
      for (const item of items) {
        if (previousDate && item.date > previousDate) throw new RemoteError('豆瓣列表日期顺序异常，原进度已保留', 502)
        previousDate = item.date
        if (run.mode === 'incremental' && item.date < state.checkpoint) older = true
        else seen.set(item.id, item)
      }
      run.pages = page + 1
      run.scanned = seen.size
      saveDoubanState(this.store, { ...state, lastRun: run })
      if (older) { finished = true; break }
      offset += items.length
    }
    if (!finished) throw new RemoteError('已达到分页上限，未写入数据，原进度已保留', 502)
    signal.throwIfAborted()
    if (this.offline() || this.stopping) throw new RemoteError('同步已停止', 409)
    // 整批成功才提交，沿用旧项目的补空策略，不删除记录、不覆盖个人原始信息。
    this.store.db.exec('BEGIN')
    try {
      for (const item of seen.values()) {
        const existing = this.store.db.prepare('SELECT data FROM douban_items WHERE id=?').get(item.id)
        if (!existing) {
          this.store.db.prepare('INSERT INTO douban_items VALUES(?,?,?)').run(item.id, item.type, JSON.stringify(item))
          run.imported++
        } else {
          const old = JSON.parse(existing.data)
          const merged = { ...old }
          for (const key of ['title', 'altTitle', 'intro', 'rating', 'date', 'comment', 'link']) {
            if ((old[key] === null || old[key] === undefined || old[key] === '') && item[key] != null) merged[key] = item[key]
          }
          if (JSON.stringify(merged) === existing.data) run.skipped++
          else {
            this.store.db.prepare('UPDATE douban_items SET data=? WHERE id=?').run(JSON.stringify(merged), item.id)
            run.updated++
          }
        }
      }
      const newest = [...seen.values()].map(item => item.date).sort().at(-1)
      const checkpoint = newest && (!state.checkpoint || newest > state.checkpoint) ? newest : state.checkpoint
      run.state = 'completed'
      run.finishedAt = new Date().toISOString()
      saveDoubanState(this.store, { ...state, checkpoint, lastRun: run })
      this.store.db.exec('COMMIT')
    } catch (error) {
      this.store.db.exec('ROLLBACK')
      run.imported = 0; run.updated = 0; run.skipped = 0
      throw error
    }
  }
  async poster(id) {
    const cached = this.store.db.prepare('SELECT mime,data AS buffer FROM douban_images WHERE id=?').get(id)
    if (cached) return cached
    if (this.offline() || this.stopping) throw new RemoteError('没有本地海报', 404)
    const mirror = this.store.db.prepare('SELECT objectKey FROM douban_poster_mirrors WHERE id=?').get(id)
    const row = this.store.db.prepare('SELECT data FROM douban_items WHERE id=?').get(id)
    const url = row && JSON.parse(row.data).posterUrl
    if (!mirror && !allowedPoster(url)) throw new RemoteError('尚无海报地址，请在同步设置中补全海报', 404)
    if (this.posterJobs.has(id)) return this.posterJobs.get(id)
    const job = (async () => {
      const buffer = mirror && this.s3.config ? await this.s3.request('GET', mirror.objectKey, this.posterController.signal) : await this.read(url, this.posterController.signal, { image: true })
      const mime = imageMime(buffer)
      if (!mime) throw new RemoteError('海报格式不受支持', 502)
      this.store.db.prepare('INSERT OR REPLACE INTO douban_images VALUES(?,?,?,?)').run(id, url || 's3:' + mirror.objectKey, mime, buffer)
      if (!mirror && this.s3.config) {
        try {
          const key = await this.s3.mirror(id, buffer, mime, this.posterController.signal)
          this.store.db.prepare('INSERT OR REPLACE INTO douban_poster_mirrors VALUES(?,?)').run(id, key)
        } catch {
          // 图片已落本地，桶暂不可用不阻止展示，待上传数量由设置页提供重试入口。
        }
      }
      return { mime, buffer }
    })().finally(() => this.posterJobs.delete(id))
    this.posterJobs.set(id, job)
    return job
  }
  async close() {
    this.stopping = true
    this.controller?.abort()
    this.posterController.abort()
    await Promise.allSettled([this.job, this.posters.close(), ...this.posterJobs.values()])
  }
}

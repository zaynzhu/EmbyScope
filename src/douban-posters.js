import { RemoteError } from './emby.js'

// 复用旧 macOS 项目的精确身份规则，标题只召回候选，不据此猜测作品。
export function exactPoster(payload, id, allowed) {
  if (!Array.isArray(payload) || payload.length > 100) throw new RemoteError('豆瓣海报查询返回格式异常', 502)
  const urls = new Set(payload.filter(item => item && item.id === id).map(item => item.img).filter(url => typeof url === 'string' && allowed(url)))
  return urls.size === 1 ? [...urls][0] : null
}

export function detailPoster(payload, id, allowed) {
  if (!payload || String(payload.id) !== id) throw new RemoteError('豆瓣详情身份不匹配，已停止补图', 502)
  const url = typeof payload.pic === 'string' ? payload.pic : payload.pic?.large || payload.pic?.normal
  return typeof url === 'string' && allowed(url) ? url : null
}

export class DoubanPosters {
  constructor(service, { allowed, imageMime }) {
    this.service = service
    this.store = service.store
    this.allowed = allowed
    this.imageMime = imageMime
    this.job = null
    this.controller = null
    this.run = JSON.parse(this.store.db.prepare("SELECT value FROM settings WHERE name='doubanPosterRun'").get()?.value || 'null')
    if (this.run?.state === 'running') {
      Object.assign(this.run, { state: 'interrupted', finishedAt: new Date().toISOString(), error: '补图因应用退出中断，已保存的图片保留，可继续补全' })
      this.save()
    }
  }
  save() {
    this.store.db.prepare("INSERT INTO settings VALUES('doubanPosterRun',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(JSON.stringify(this.run))
  }
  status() {
    const missing = this.store.db.prepare("SELECT count(*) AS n FROM douban_items i WHERE coalesce(json_extract(data,'$.posterUrl'),'')='' AND NOT EXISTS(SELECT 1 FROM douban_images c WHERE c.id=i.id)").get().n
    const cached = this.store.db.prepare('SELECT count(*) AS n FROM douban_images').get().n
    const mirrored = this.store.db.prepare('SELECT count(*) AS n FROM douban_poster_mirrors').get().n
    const pendingMirror = this.service.s3.config ? this.store.db.prepare('SELECT count(*) AS n FROM douban_images c WHERE NOT EXISTS(SELECT 1 FROM douban_poster_mirrors m WHERE m.id=c.id)').get().n : 0
    return { missing, cached, mirrored, pendingMirror, s3Configured: !!this.service.s3.config, running: !!this.job, lastRun: this.run }
  }
  start() {
    if (this.service.stopping || this.service.offline()) throw new RemoteError('离线模式不能补全海报', 409)
    if (this.job || this.service.job) throw new RemoteError('请等待当前豆瓣任务结束', 409)
    // 未尝试的优先；中断后不会反复停留在首批无匹配记录。
    const targets = this.store.db.prepare(`SELECT i.data FROM douban_items i
      LEFT JOIN douban_poster_attempts a ON a.id=i.id
      WHERE (coalesce(json_extract(i.data,'$.posterUrl'),'')='' AND NOT EXISTS(SELECT 1 FROM douban_images c WHERE c.id=i.id))
        OR (? AND EXISTS(SELECT 1 FROM douban_images c WHERE c.id=i.id) AND NOT EXISTS(SELECT 1 FROM douban_poster_mirrors m WHERE m.id=i.id))
      ORDER BY a.attemptedAt IS NOT NULL, a.attemptedAt, json_extract(i.data,'$.date') DESC, i.id`).all(this.service.s3.config ? 1 : 0).map(row => JSON.parse(row.data))
    this.controller = new AbortController()
    this.run = { state: 'running', total: targets.length, processed: 0, saved: 0, unmatched: 0,
      startedAt: new Date().toISOString(), finishedAt: null, error: null }
    this.save()
    this.job = this.fill(targets, this.controller.signal).then(() => { this.run.state = 'completed' }).catch(error => {
      this.run.state = this.service.stopping ? 'interrupted' : this.controller.signal.aborted ? 'cancelled' : 'failed'
      this.run.error = this.controller.signal.aborted ? '补图已停止，已保存的图片保留' : error instanceof RemoteError ? error.message : '海报连接失败或请求超时，已停止，可稍后继续'
    }).finally(() => {
      this.run.finishedAt = new Date().toISOString()
      this.save()
      this.job = null
      this.controller = null
    })
    return this.status()
  }
  cancel() { this.controller?.abort() }
  async lookup(item, signal, triedSuggest) {
    if (!triedSuggest) {
      const query = new URL('https://movie.douban.com/j/subject_suggest')
      query.searchParams.set('q', item.title.slice(0, 200))
      const bytes = await this.service.read(query, signal, { json: true })
      let payload
      try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw new RemoteError('豆瓣海报查询未返回有效 JSON，已停止', 502) }
      const url = exactPoster(payload, item.id, this.allowed)
      if (url) return url
    }
    // WhatShot 的精确 ID 详情路径；仅 404 才尝试另一媒体类型，访问限制直接向上抛出。
    const kinds = item.type === 'Series' ? ['tv', 'movie'] : ['movie', 'tv']
    for (const kind of kinds) {
      const bytes = await this.service.read(`https://m.douban.com/rexxar/api/v2/${kind}/${item.id}`, signal, { json: true, missingIsNull: true })
      if (bytes === null) continue
      let payload
      try { payload = JSON.parse(bytes.toString('utf8')) } catch { throw new RemoteError('豆瓣详情响应异常，已停止补图', 502) }
      return detailPoster(payload, item.id, this.allowed)
    }
    return null
  }
  async fill(targets, signal) {
    for (const item of targets) {
      signal.throwIfAborted()
      const previous = this.store.db.prepare('SELECT state FROM douban_poster_attempts WHERE id=?').get(item.id)
      this.store.db.prepare('INSERT INTO douban_poster_attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET attemptedAt=excluded.attemptedAt,state=excluded.state')
        .run(item.id, new Date().toISOString(), 'attempted')
      const cached = this.store.db.prepare('SELECT data AS buffer,mime,url FROM douban_images WHERE id=?').get(item.id)
      const mirror = this.store.db.prepare('SELECT objectKey FROM douban_poster_mirrors WHERE id=?').get(item.id)
      let url = cached?.url || null
      let buffer = cached?.buffer
      let mime = cached?.mime
      if (mirror && this.service.s3.config && !cached) {
        buffer = await this.service.s3.request('GET', mirror.objectKey, signal)
        mime = this.imageMime(buffer)
        url = 's3:' + mirror.objectKey
      } else if (!cached) {
        url = await this.lookup(item, signal, previous?.state === 'unmatched')
      }
      if (!url) {
        this.run.unmatched++
        this.store.db.prepare("UPDATE douban_poster_attempts SET state='unmatched' WHERE id=?").run(item.id)
      } else {
        if (!buffer) buffer = await this.service.read(url, signal, { image: true })
        mime = this.imageMime(buffer)
        if (!mime) throw new RemoteError('海报响应不是支持的图片，已停止', 502)
        signal.throwIfAborted()
        if (this.service.offline() || this.service.stopping) throw new RemoteError('当前模式不允许补图', 409)
        this.store.db.exec('BEGIN')
        try {
          const row = this.store.db.prepare('SELECT data FROM douban_items WHERE id=?').get(item.id)
          const current = row && JSON.parse(row.data)
          if (current) {
            if (!current.posterUrl && this.allowed(url)) this.store.db.prepare('UPDATE douban_items SET data=? WHERE id=?').run(JSON.stringify({ ...current, posterUrl: url }), item.id)
            this.store.db.prepare('INSERT OR REPLACE INTO douban_images VALUES(?,?,?,?)').run(item.id, url, mime, buffer)
            this.store.db.prepare("UPDATE douban_poster_attempts SET state='saved' WHERE id=?").run(item.id)
            this.run.saved++
          }
          this.store.db.exec('COMMIT')
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error }
        if (!mirror && this.service.s3.config) {
          const key = await this.service.s3.mirror(item.id, buffer, mime, signal)
          this.store.db.prepare('INSERT OR REPLACE INTO douban_poster_mirrors VALUES(?,?)').run(item.id, key)
        }
      }
      this.run.processed++
      this.save()
    }
  }
  async close() { this.cancel(); await this.job }
}

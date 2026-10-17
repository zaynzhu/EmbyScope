import { randomUUID } from 'node:crypto'
import { normalizeItem, groupWorks } from './identity.js'
import { normalizeUrl, RemoteError } from './emby.js'

export class Service {
  constructor(store, client, { cacheMinutes = 60 } = {}) {
    this.store = store
    this.client = client
    this.cacheMinutes = cacheMinutes
    this.jobs = new Map()
    this.images = new Map()
  }
  publicServer(row) {
    const { id, name, url, status, error, attemptedAt } = row
    const datasets = {}
    for (const kind of ['catalog', 'views', 'latest', 'resume']) {
      const cache = this.store.cache(id, kind)
      datasets[kind] = {
        available: cache?.data != null, updatedAt: cache?.updatedAt || null, error: cache?.error || null,
        stale: !!cache?.data && (!!cache.error || Date.now() - Date.parse(cache.updatedAt) > this.cacheMinutes * 60000)
      }
    }
    return { id, name, url, status, error, attemptedAt, syncing: this.jobs.has(id), datasets }
  }
  listServers() { return this.store.servers().map(row => this.publicServer(row)) }
  saveServer(body, id) {
    if (!body || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) throw new RemoteError('连接名称必填且不超过 80 字', 400)
    const url = normalizeUrl(body.url)
    const previous = id ? this.store.server(id) : null
    if (id && !previous) throw new RemoteError('连接不存在', 404)
    if (this.store.servers().some(row => row.url === url && row.id !== id)) throw new RemoteError('此地址已有连接，请编辑已有连接', 400)
    if (!previous && this.store.servers().length >= 30) throw new RemoteError('最多保存 30 台服务器', 400)
    const oldSecret = previous ? this.store.decrypt(previous.secret) : {}
    const username = body.username || oldSecret.username
    const password = body.password === undefined || (previous && body.password === '') ? oldSecret.password : body.password
    if (typeof username !== 'string' || !username.trim() || username.length > 256 || typeof password !== 'string' || password.length > 1024) throw new RemoteError('请填写有效的 Emby 用户名和密码', 400)
    const changed = !previous || previous.url !== url || oldSecret.username !== username || oldSecret.password !== password
    const secret = changed ? { username, password } : oldSecret
    id ||= randomUUID()
    this.store.db.exec('BEGIN')
    try {
      if (previous) {
        this.store.db.prepare('UPDATE servers SET name=?,url=?,secret=?,revision=revision+1,status=?,error=NULL WHERE id=?')
          .run(body.name.trim(), url, this.store.encrypt(secret), changed ? 'pending' : previous.status, id)
        if (changed) {
          this.store.db.prepare('DELETE FROM cache WHERE serverId=?').run(id)
          this.store.db.prepare('DELETE FROM images WHERE serverId=?').run(id)
        }
      } else {
        this.store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)').run(id, body.name.trim(), url, this.store.encrypt(secret))
      }
      this.store.db.exec('COMMIT')
    } catch (error) {
      this.store.db.exec('ROLLBACK')
      throw error
    }
    // 旧任务只能读取旧版本，不允许把旧账号的数据写回新连接。
    const running = this.jobs.get(id)
    if (running) running.finally(() => this.refresh(id)).catch(() => {})
    else this.refresh(id)
    return this.publicServer(this.store.server(id))
  }
  deleteServer(id) {
    if (!this.store.server(id)) throw new RemoteError('连接不存在', 404)
    this.store.db.prepare('DELETE FROM servers WHERE id=?').run(id)
  }
  refresh(id) {
    if (this.jobs.has(id)) return this.jobs.get(id)
    const row = this.store.server(id)
    if (!row) return Promise.resolve()
    const job = this.sync(row).catch(() => {
      if (this.current(row)) this.store.db.prepare("UPDATE servers SET status='error',error='同步失败，未完整更新' WHERE id=?").run(id)
    }).finally(() => this.jobs.delete(id))
    this.jobs.set(id, job)
    return job
  }
  current(row) { return this.store.server(row.id)?.revision === row.revision }
  failCache(row, kind, error) {
    if (!this.current(row)) return
    const previous = this.store.cache(row.id, kind)
    const denied = [401, 403].includes(error.status)
    this.store.db.prepare(`INSERT INTO cache VALUES(?,?,?,?,?) ON CONFLICT(serverId,kind)
      DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt,error=excluded.error`)
      .run(row.id, kind, JSON.stringify(denied ? null : previous?.data ?? null), denied ? '' : previous?.updatedAt || '', error.message)
    if (denied) this.store.db.prepare('DELETE FROM images WHERE serverId=?').run(row.id)
  }
  async sync(row) {
    let secret = this.store.decrypt(row.secret)
    this.store.db.prepare('UPDATE servers SET attemptedAt=? WHERE id=?').run(new Date().toISOString(), row.id)
    try {
      if (!secret.token) {
        secret = await this.client.login(row, secret)
        if (!this.current(row)) return
        this.store.db.prepare('UPDATE servers SET secret=? WHERE id=?').run(this.store.encrypt(secret), row.id)
      }
      const userPath = `/Users/${encodeURIComponent(secret.userId)}`
      const tasks = {
        catalog: async () => (await this.client.catalog(row, secret)).map(item => normalizeItem(item, row.id)),
        views: async () => {
          const result = await this.client.request(row, `${userPath}/Views`, { token: secret.token })
          if (!Array.isArray(result.Items)) throw new RemoteError('媒体库响应不完整')
          return result.Items.map(item => ({ id: String(item.Id), name: String(item.Name || '未命名媒体库'), type: item.CollectionType || 'mixed', serverId: row.id }))
        },
        latest: async () => {
          const result = await this.client.request(row, `${userPath}/Items/Latest?Limit=18&Fields=Overview,Genres,ProviderIds,DateCreated&IncludeItemTypes=Movie,Episode&GroupItems=false`, { token: secret.token })
          if (!Array.isArray(result)) throw new RemoteError('最近入库响应不完整')
          return result.map(item => normalizeItem(item, row.id))
        },
        resume: async () => {
          const result = await this.client.request(row, `${userPath}/Items/Resume?Limit=18&Fields=Overview,Genres,ProviderIds,DateCreated&EnableUserData=true`, { token: secret.token })
          if (!Array.isArray(result.Items)) throw new RemoteError('继续观看响应不完整')
          return result.Items.map(item => normalizeItem(item, row.id))
        }
      }
      let partial = false
      for (const [kind, task] of Object.entries(tasks)) {
        if (!this.current(row)) return
        try {
          const data = await task()
          if (this.current(row)) this.store.saveCache(row.id, kind, data)
        } catch (error) {
          const safe = error instanceof RemoteError ? error : new RemoteError('接口数据格式不完整')
          this.failCache(row, kind, safe)
          if (![403, 404].includes(safe.status)) throw safe
          partial = true
        }
      }
      if (this.current(row)) this.store.db.prepare('UPDATE servers SET status=?,error=? WHERE id=?').run(partial ? 'partial' : 'online', partial ? '部分接口无权限或不可用' : null, row.id)
    } catch (error) {
      if (!this.current(row)) return
      const safe = error instanceof RemoteError ? error : new RemoteError('接口数据格式不完整')
      for (const kind of ['catalog', 'views', 'latest', 'resume']) this.failCache(row, kind, safe)
      if (safe.status === 401) {
        delete secret.token
        delete secret.userId
        this.store.db.prepare('UPDATE servers SET secret=? WHERE id=?').run(this.store.encrypt(secret), row.id)
      }
      this.store.db.prepare('UPDATE servers SET status=?,error=? WHERE id=?')
        .run([401, 403].includes(safe.status) ? 'denied' : 'offline', safe.message, row.id)
    }
  }
  selected(serverId) {
    const servers = this.store.servers()
    if (!serverId || serverId === 'all') return servers
    const selected = servers.filter(row => row.id === serverId)
    if (!selected.length) throw new RemoteError('连接不存在', 404)
    return selected
  }
  collect(rows, kind) {
    return rows.flatMap(row => (this.store.cache(row.id, kind)?.data || []).map(item => ({ ...item, serverName: row.name })))
  }
  overview(serverId) {
    const rows = this.selected(serverId)
    const catalog = this.collect(rows, 'catalog')
    const works = catalog.filter(item => ['Movie', 'Series'].includes(item.type))
    const known = rows.filter(row => this.store.cache(row.id, 'catalog')?.data != null).length
    const viewsKnown = rows.filter(row => this.store.cache(row.id, 'views')?.data != null).length
    const groups = groupWorks(works)
    const count = type => known ? catalog.filter(item => item.type === type).length : null
    return {
      servers: rows.map(row => this.publicServer(row)), cacheMinutes: this.cacheMinutes,
      stats: { movies: count('Movie'), series: count('Series'), episodes: count('Episode'),
        libraries: viewsKnown ? this.collect(rows, 'views').length : null,
        entries: known ? works.length : null, uniqueWorks: known ? groups.length : null,
        conflicts: known ? groups.filter(item => item.conflict).length : null,
        knownServers: known, totalServers: rows.length, complete: known === rows.length && rows.length > 0,
        history: null, historyReason: '不可用：未接入可解释的播放历史，当前账号的继续观看不代表全站播放统计。' },
      views: this.collect(rows, 'views'),
      latest: this.collect(rows, 'latest').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 24),
      resume: this.collect(rows, 'resume').sort((a, b) => (b.lastPlayed || '').localeCompare(a.lastPlayed || '')).slice(0, 24)
    }
  }
  library(params) {
    const rows = this.selected(params.get('server'))
    let items = groupWorks(this.collect(rows, 'catalog').filter(item => ['Movie', 'Series'].includes(item.type)))
    const query = (params.get('q') || '').trim().toLocaleLowerCase().slice(0, 200)
    const type = params.get('type')
    items = items.filter(item => (!type || item.type === type) && (!query || item.sources.some(source => source.title.toLocaleLowerCase().includes(query))))
    items.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.key.localeCompare(b.key))
    const pageSize = Math.min(60, Math.max(1, Number.parseInt(params.get('pageSize')) || 24))
    const knownServers = rows.filter(row => this.store.cache(row.id, 'catalog')?.data != null).length
    const total = knownServers ? items.length : null
    const pages = Math.max(1, Math.ceil((total || 0) / pageSize))
    const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page')) || 1))
    return { items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize, knownServers,
      servers: rows.map(row => this.publicServer(row)) }
  }
  findItem(serverId, itemId) {
    if (!this.store.server(serverId)) throw new RemoteError('连接不存在', 404)
    for (const kind of ['catalog', 'latest', 'resume']) {
      const item = this.store.cache(serverId, kind)?.data?.find(item => item.id === itemId)
      if (item) return item
    }
    throw new RemoteError('条目不存在或当前账号无法访问', 404)
  }
  detail(serverId, itemId, params) {
    const item = this.findItem(serverId, itemId)
    const catalog = this.store.cache(serverId, 'catalog')
    const seriesId = item.type === 'Series' ? item.id : item.seriesId
    let episodes = seriesId ? (catalog?.data || []).filter(child => child.seriesId === seriesId && child.type === 'Episode') : []
    episodes.sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || (a.episode ?? -1) - (b.episode ?? -1) || a.id.localeCompare(b.id))
    const seasons = [...new Set(episodes.map(child => child.season).filter(value => value !== null))].sort((a, b) => a - b)
    if (params.has('season')) episodes = episodes.filter(child => child.season === Number(params.get('season')))
    const total = episodes.length
    const pages = Math.max(1, Math.ceil(total / 50))
    const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page')) || 1))
    return { ...item, serverName: this.store.server(serverId).name, seasons,
      episodes: episodes.slice((page - 1) * 50, page * 50), episodeTotal: catalog?.data ? total : null,
      episodePage: page, episodePages: pages, cache: this.publicServer(this.store.server(serverId)).datasets.catalog }
  }
  async poster(serverId, itemId) {
    const item = this.findItem(serverId, itemId)
    if (!item.imageTag) throw new RemoteError('没有海报', 404)
    const row = this.store.server(serverId)
    const cached = this.store.db.prepare('SELECT * FROM images WHERE serverId=? AND itemId=? AND tag=?').get(serverId, itemId, item.imageTag)
    if (cached) return { mime: cached.mime, buffer: Buffer.from(cached.data) }
    if (!['online', 'partial'].includes(row.status)) throw new RemoteError('服务器尚未就绪，海报暂不可用', 503)
    const key = `${serverId}:${row.revision}:${itemId}:${item.imageTag}`
    if (this.images.has(key)) return this.images.get(key)
    const task = (async () => {
      const secret = this.store.decrypt(row.secret)
      const image = await this.client.request(row, `/Items/${encodeURIComponent(itemId)}/Images/Primary?MaxWidth=400&Quality=85&Tag=${encodeURIComponent(item.imageTag)}`, { token: secret.token, image: true })
      if (!this.current(row)) throw new RemoteError('连接已变更', 409)
      // 最多保存约 256 MiB 海报，按写入时间淘汰。
      while (this.store.db.prepare('SELECT COALESCE(SUM(length(data)),0) AS size FROM images').get().size + image.buffer.length > 256 * 1024 * 1024) {
        this.store.db.prepare('DELETE FROM images WHERE rowid=(SELECT rowid FROM images ORDER BY updatedAt LIMIT 1)').run()
      }
      this.store.db.prepare('INSERT OR REPLACE INTO images VALUES(?,?,?,?,?,?)').run(serverId, itemId, item.imageTag, image.mime, image.buffer, Date.now())
      return image
    })().finally(() => this.images.delete(key))
    this.images.set(key, task)
    return task
  }
  tick() {
    for (const row of this.store.servers()) {
      if (!row.attemptedAt || Date.now() - Date.parse(row.attemptedAt) >= this.cacheMinutes * 60000) this.refresh(row.id)
    }
  }
  async drain() { await Promise.allSettled([...this.jobs.values(), ...this.images.values()]) }
}

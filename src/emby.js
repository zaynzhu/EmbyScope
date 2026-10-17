import { setTimeout as sleep } from 'node:timers/promises'

export class RemoteError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.status = status
  }
}

export class RateLimiter {
  constructor(interval = 2000) {
    this.interval = interval
    this.queues = new Map()
    this.lastStart = new Map()
  }
  run(key, work) {
    const previous = this.queues.get(key) || Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const nextStart = (this.lastStart.get(key) || 0) + this.interval
      while (Date.now() < nextStart) await sleep(nextStart - Date.now())
      this.lastStart.set(key, Date.now())
      return work()
    })
    this.queues.set(key, next)
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key) }).catch(() => {})
    return next
  }
}

export function normalizeUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new RemoteError('请输入有效的服务器地址', 400) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RemoteError('地址仅支持 HTTP / HTTPS，不能包含凭据、查询参数或片段', 400)
  }
  // 保留用户指定的反向代理路径，不猜测或访问其他地址。
  return url.toString().replace(/\/+$/, '')
}

export class EmbyClient {
  constructor({ interval = 2000, timeout = 12000, retries = 1, fetchImpl = fetch } = {}) {
    this.limiter = new RateLimiter(interval)
    this.timeout = timeout
    this.retries = retries
    this.fetchImpl = fetchImpl
  }
  async request(server, path, { token, body, image = false } = {}) {
    const url = new URL(`${server.url}${path}`)
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.limiter.run(url.origin, async () => {
          const authorization = `Emby Client="EmbyScope", Device="EmbyScope", DeviceId="${server.id}", Version="1.0.0"`
          const headers = {
            Authorization: authorization,
            // 极影视兼容层只从此请求头读取客户端设备身份。
            'X-Emby-Authorization': authorization,
            Accept: image ? 'image/*' : 'application/json'
          }
          if (token) headers['X-Emby-Token'] = token
          if (body) headers['Content-Type'] = 'application/json'
          const response = await this.fetchImpl(url, {
            method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(this.timeout), redirect: 'manual'
          })
          if (!response.ok) {
            await response.body?.cancel()
            const messages = { 401: '登录失效，请检查账号密码', 403: '当前账号无权访问此数据', 404: '接口或资源不可用', 429: '服务器限流，请稍后刷新' }
            const error = new RemoteError(messages[response.status] || '服务器返回异常响应', response.status)
            error.retryAfter = response.headers.get('retry-after')
            throw error
          }
          const mime = (response.headers.get('content-type') || '').split(';')[0]
          if (image && !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(mime)) {
            await response.body?.cancel()
            throw new RemoteError('不支持的海报格式')
          }
          const limit = image ? 8 * 1024 * 1024 : 32 * 1024 * 1024
          const chunks = []
          let size = 0
          for await (const chunk of response.body) {
            size += chunk.length
            if (size > limit) throw new RemoteError('响应过大，未更新缓存')
            chunks.push(chunk)
          }
          const buffer = Buffer.concat(chunks)
          if (image) return { mime, buffer }
          try { return JSON.parse(buffer) } catch { throw new RemoteError('接口未返回有效 JSON') }
        })
      } catch (error) {
        const retryable = !(error instanceof RemoteError) || error.status >= 500 || error.status === 429
        if (!retryable || attempt === this.retries) throw error instanceof RemoteError ? error : new RemoteError('连接失败或请求超时')
        let delay = 2000 * (attempt + 1)
        if (error.retryAfter) {
          const seconds = Number(error.retryAfter)
          const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(error.retryAfter) - Date.now()
          if (requested > 60000) throw error
          if (Number.isFinite(requested)) delay = Math.max(delay, requested)
        }
        await sleep(delay)
      }
    }
  }
  async login(server, secret) {
    const result = await this.request(server, '/Users/AuthenticateByName', { body: { Username: secret.username, Pw: secret.password } })
    if (typeof result.AccessToken !== 'string' || typeof result.User?.Id !== 'string') throw new RemoteError('登录响应缺少用户令牌')
    return { ...secret, token: result.AccessToken, userId: result.User.Id }
  }
  async catalog(server, secret) {
    const items = []
    const seen = new Set()
    let expected = null
    for (let page = 0; page < 2000; page++) {
      const query = new URLSearchParams({
        Recursive: 'true', IncludeItemTypes: 'Movie,Series,Season,Episode', Fields: 'Overview,Genres,ProviderIds,DateCreated',
        EnableUserData: 'true', EnableTotalRecordCount: 'true', SortBy: 'SortName', SortOrder: 'Ascending', Limit: '500', StartIndex: String(items.length)
      })
      const result = await this.request(server, `/Users/${encodeURIComponent(secret.userId)}/Items?${query}`, { token: secret.token })
      if (!Array.isArray(result.Items) || !Number.isInteger(result.TotalRecordCount) || result.TotalRecordCount < 0) throw new RemoteError('片库响应不完整，保留上次完整缓存')
      if (expected !== null && expected !== result.TotalRecordCount) throw new RemoteError('同步期间片库发生变化，请重新刷新')
      expected = result.TotalRecordCount
      for (const item of result.Items) {
        if (!item.Id || seen.has(item.Id)) throw new RemoteError('分页条目重复，保留上次完整缓存')
        seen.add(item.Id)
        items.push(item)
      }
      if (items.length === expected) return items
      if (!result.Items.length || items.length > expected) throw new RemoteError('分页条目数量不一致，保留上次完整缓存')
    }
    throw new RemoteError('超过同步安全上限，未替换完整缓存')
  }
}

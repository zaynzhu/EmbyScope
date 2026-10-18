import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { Store } from './store.js'
import { Service } from './service.js'
import { EmbyClient, RemoteError } from './emby.js'

const deriveKey = promisify(scrypt)
const SESSION_AGE = 7 * 24 * 3600 * 1000
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public')
const digest = value => createHash('sha256').update(value).digest('hex')

async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await deriveKey(password, salt, 64)
  return `${salt}:${key.toString('hex')}`
}

async function readBody(request) {
  let length = 0
  const chunks = []
  for await (const chunk of request) {
    length += chunk.length
    if (length > 16384) throw new RemoteError('请求过大', 413)
    chunks.push(chunk)
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error()
    return result
  } catch { throw new RemoteError('请求格式错误', 400) }
}

export function createApp({ dataDir = process.env.DATA_DIR || './data', client, scheduler = true, cacheMinutes = Number(process.env.CACHE_MINUTES) || 60, secureCookie = process.env.COOKIE_SECURE === 'true' } = {}) {
  const store = new Store(dataDir)
  const service = new Service(store, client || new EmbyClient({
    interval: Math.max(2000, Number(process.env.REQUEST_INTERVAL_MS) || 2000),
    timeout: Math.min(60000, Math.max(1000, Number(process.env.REQUEST_TIMEOUT_MS) || 12000)),
    retries: Math.min(2, Math.max(0, Number(process.env.REQUEST_RETRIES ?? 1) || 0))
  }), { cacheMinutes: Math.max(5, cacheMinutes) })
  const failures = new Map()
  const cookie = (token, maxAge) => `embyscope=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`
  const send = (response, status, data, extra = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra })
    response.end(JSON.stringify(data))
  }
  const sessionHash = request => {
    const token = (request.headers.cookie || '').match(/(?:^|;\s*)embyscope=([a-f0-9]{64})(?:;|$)/)?.[1]
    return token ? digest(token) : ''
  }
  const authenticated = request => !!store.db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(sessionHash(request), Date.now())
  const createSession = response => {
    const token = randomBytes(32).toString('hex')
    store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now())
    store.db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(token), Date.now() + SESSION_AGE)
    response.setHeader('Set-Cookie', cookie(token, SESSION_AGE / 1000))
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      const url = new URL(request.url, 'http://localhost')
      const path = url.pathname
      const method = request.method
      if (method === 'GET' && path === '/health') return send(response, 200, { status: 'ok' })
      if (method === 'GET' && ['/', '/index.html', '/app.js', '/styles.css', '/favicon.svg'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1)
        const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' }
        response.writeHead(200, { 'Content-Type': types[file.split('.').at(-1)] })
        return response.end(readFileSync(join(STATIC_DIR, file)))
      }
      if (!path.startsWith('/api/')) throw new RemoteError('页面不存在', 404)
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new RemoteError('方法不支持', 405)
      if (method !== 'GET') {
        const origin = request.headers.origin
        let originMatches = true
        try { if (origin) originMatches = new URL(origin).host === request.headers.host } catch { originMatches = false }
        if (!originMatches || request.headers['x-embyscope'] !== '1' || !request.headers['content-type']?.startsWith('application/json')) throw new RemoteError('请求来源校验失败', 403)
      }
      if (method === 'GET' && path === '/api/auth/status') {
        return send(response, 200, { initialized: !!store.db.prepare('SELECT id FROM admin').get(), authenticated: authenticated(request) })
      }
      if (method === 'POST' && ['/api/auth/setup', '/api/auth/login'].includes(path)) {
        const ip = request.socket.remoteAddress
        const now = Date.now()
        for (const [key, entry] of failures) if (entry.until < now) failures.delete(key)
        const entry = failures.get(ip) || { count: 0, until: now + 15 * 60000 }
        if (entry.count >= 10) throw new RemoteError('尝试次数过多，请 15 分钟后重试', 429)
        entry.count++
        failures.set(ip, entry)
        const body = await readBody(request)
        if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 256) throw new RemoteError('管理员密码需为 12 至 256 个字符', 400)
        const admin = store.db.prepare('SELECT hash FROM admin WHERE id=1').get()
        if (path.endsWith('/setup')) {
          if (admin) throw new RemoteError('已经初始化，请登录', 409)
          const hash = await passwordHash(body.password)
          if (store.db.prepare('SELECT id FROM admin').get()) throw new RemoteError('已经初始化，请登录', 409)
          store.db.prepare('INSERT INTO admin VALUES(1,?)').run(hash)
        } else {
          if (!admin) throw new RemoteError('请先设置管理员密码', 409)
          const actual = await passwordHash(body.password, admin.hash.split(':')[0])
          if (!timingSafeEqual(Buffer.from(actual), Buffer.from(admin.hash))) throw new RemoteError('密码错误', 401)
        }
        failures.delete(ip)
        createSession(response)
        return send(response, 200, { ok: true })
      }
      if (!authenticated(request)) throw new RemoteError('请先登录', 401)
      if (method === 'POST' && path === '/api/auth/logout') {
        store.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash(request))
        response.setHeader('Set-Cookie', cookie('', 0))
        return send(response, 200, { ok: true })
      }
      if (path === '/api/servers' && method === 'GET') return send(response, 200, service.listServers())
      if (path === '/api/settings' && method === 'GET') return send(response, 200, service.settings())
      if (path === '/api/settings' && method === 'PUT') return send(response, 200, service.updateSettings(await readBody(request)))
      if (path === '/api/servers' && method === 'POST') return send(response, 201, service.saveServer(await readBody(request)))
      const connection = path.match(/^\/api\/servers\/([a-f0-9-]+)$/)
      if (connection && method === 'PUT') return send(response, 200, service.saveServer(await readBody(request), connection[1]))
      if (connection && method === 'DELETE') {
        service.deleteServer(connection[1])
        return send(response, 200, { ok: true })
      }
      if (path === '/api/refresh' && method === 'POST') {
        const body = await readBody(request)
        for (const row of service.selected(body.server)) service.refresh(row.id, { full: body.mode === 'full' })
        return send(response, 202, { ok: true })
      }
      if (path === '/api/overview' && method === 'GET') return send(response, 200, service.overview(url.searchParams.get('server')))
      if (path === '/api/library' && method === 'GET') return send(response, 200, service.library(url.searchParams))
      const item = path.match(/^\/api\/items\/([a-f0-9-]+)\/([^/]+)(\/(?:poster|resources))?$/)
      if (item && method === 'GET') {
        let itemId
        try { itemId = decodeURIComponent(item[2]) } catch { throw new RemoteError('条目标识无效', 400) }
        if (item[3] === '/resources') return send(response, 200, await service.readResources(item[1], itemId))
        if (item[3]) {
          const image = await service.poster(item[1], itemId)
          response.writeHead(200, { 'Content-Type': image.mime })
          return response.end(image.buffer)
        }
        return send(response, 200, await service.readDetail(item[1], itemId, url.searchParams))
      }
      throw new RemoteError('接口不存在', 404)
    } catch (error) {
      // 不打印请求、远端响应或异常对象，以免凭据进入日志。
      const status = error instanceof RemoteError && error.status >= 400 && error.status < 600 ? error.status : 500
      if (!response.headersSent) send(response, status, { error: error instanceof RemoteError ? error.message : '内部处理失败，请稍后重试' })
      else response.end()
    }
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  const timer = scheduler ? setInterval(() => service.tick(), 30000) : null
  timer?.unref()
  if (scheduler) service.tick()
  return { server, store, service, async close() {
    clearInterval(timer)
    service.stopping = true
    await new Promise(resolve => server.close(resolve))
    await service.drain()
    store.close()
  } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077)
  const app = createApp()
  const port = Number(process.env.PORT) || 3000
  app.server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`映览 · EmbyScope 已启动，端口 ${port}`))
  const shutdown = async () => {
    const deadline = setTimeout(() => process.exit(1), 10000)
    deadline.unref()
    await app.close()
    process.exit(0)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

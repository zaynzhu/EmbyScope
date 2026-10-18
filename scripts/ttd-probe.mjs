import http from 'node:http'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// 独立诊断工具：只模拟上游，不转发请求，不接触真实媒体或 TTD 配置。
export function createProbe({ allowedClient = '127.0.0.1' } = {}) {
  if (!isIP(allowedClient)) throw new Error('ALLOWED_CLIENT 必须是单个 IP 地址')
  const events = []
  const probeKey = 'embyscope-diagnostic-fake-key'
  const server = http.createServer((request, response) => {
    const client = request.socket.remoteAddress?.replace(/^::ffff:/, '')
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    if (client !== allowedClient && client !== '127.0.0.1' && client !== '::1') return send(403, { error: '来源不允许' })
    const url = new URL(request.url, 'http://probe.local')
    if (url.pathname === '/__probe/evidence') {
      if (!['127.0.0.1', '::1'].includes(client)) return send(403, { error: '仅本机可读取诊断结果' })
      return send(200, { events })
    }
    const queryKeys = [...url.searchParams.keys()]
    const token = request.headers['x-emby-token']
    const authorization = request.headers['x-emby-authorization'] || request.headers.authorization || ''
    const matches = token === probeKey || [...url.searchParams.values()].includes(probeKey) || authorization.includes(probeKey)
    const event = {
      method: request.method,
      path: url.pathname.replace(/[a-f0-9]{24,}/gi, '[标识已隐藏]').slice(0, 300),
      queryKeys,
      tokenHeaderPresent: !!token,
      authorizationHeaderPresent: !!authorization,
      fakeCredentialMatched: matches
    }
    // 不保存请求体、认证字段值、查询参数值、Cookie 或原始响应。
    events.push(event)
    if (events.length > 30) events.shift()
    if (!['GET', 'HEAD'].includes(request.method)) return send(405, { error: '诊断上游只接受读取' })
    if (!matches && (token || authorization || queryKeys.some(key => /token|key/i.test(key)))) return send(403, { error: '请使用诊断假凭据' })
    send(200, { ServerName: 'EmbyScope 诊断模拟器', Version: '4.8.0.0', Id: 'diagnostic-fixture' })
  })
  return { server, events, probeKey }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const probe = createProbe({ allowedClient: process.env.ALLOWED_CLIENT || '127.0.0.1' })
  probe.server.listen(Number(process.env.PROBE_PORT) || 0, process.env.PROBE_HOST || '127.0.0.1', () => {
    console.log(JSON.stringify({ port: probe.server.address().port, fakeCredential: probe.probeKey, note: '仅诊断模拟器，不是真实 Emby；不要保存到 TTD 配置' }))
  })
  const close = () => probe.server.close()
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  setTimeout(close, 10 * 60000).unref()
}

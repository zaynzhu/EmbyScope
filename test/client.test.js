import test from 'node:test'
import assert from 'node:assert/strict'
import { EmbyClient, RateLimiter, normalizeUrl } from '../src/emby.js'
import { mockEmby } from './fixtures.js'

test('极影视兼容层要求 X-Emby-Authorization，登录和后续读取均携带设备身份', async t => {
  const mock = await mockEmby('compat', { requireCompatAuth: true })
  t.after(() => mock.close())
  const server = { id: 'compat-device', url: mock.url }
  const client = new EmbyClient({ interval: 1, retries: 0 })
  const secret = await client.login(server, { username: 'fixture-user', password: 'fixture-pass' })
  assert.equal(secret.userId, 'same-user-id')
  const { items } = await client.catalog(server, secret)
  assert.equal(items.length, mock.catalog.length)
  const views = await client.request(server, `/Users/${secret.userId}/Views`, { token: secret.token })
  assert.equal(views.Items.length, 1)
  const image = await client.request(server, '/Items/1/Images/Primary', { token: secret.token, image: true })
  assert.equal(image.mime, 'image/png')
})

test('默认同服请求间隔至少两秒，不同服务器不被串行阻塞', async () => {
  const limiter = new RateLimiter()
  const times = []
  const start = Date.now()
  await Promise.all([
    limiter.run('a', () => times.push(Date.now())),
    limiter.run('a', () => times.push(Date.now())),
    limiter.run('b', () => assert.ok(Date.now() - start < 1000))
  ])
  assert.ok(times[1] - times[0] >= 1995)
})

test('只允许 HTTP 地址，拒绝地址携带凭据或查询令牌', () => {
  assert.equal(normalizeUrl('https://example.com/emby/'), 'https://example.com/emby')
  for (const url of ['file:///tmp/a', 'http://user:pass@example.com', 'http://example.com?api_key=secret', 'bad']) assert.throws(() => normalizeUrl(url))
})

test('不跟随重定向；403不重试；429和5xx有限重试', async () => {
  let calls = 0
  const server = { id: 'local-id', url: 'https://example.com' }
  const client = new EmbyClient({ interval: 1, retries: 1, fetchImpl: async (url, options) => {
    calls++
    assert.equal(options.redirect, 'manual')
    return new Response('{}', { status: calls === 1 ? 503 : 200 })
  } })
  assert.deepEqual(await client.request(server, '/Users/user/Views'), {})
  assert.equal(calls, 2)
  calls = 0
  client.fetchImpl = async () => {
    calls++
    return new Response('{}', { status: 403 })
  }
  await assert.rejects(client.request(server, '/Users/user/Views'), /无权访问/)
  assert.equal(calls, 1)
  calls = 0
  client.fetchImpl = async () => {
    calls++
    return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })
  }
  await assert.rejects(client.request(server, '/Users/user/Views'), /限流/)
  assert.equal(calls, 1)
})

test('网络超时返回脱敏错误，禁止 SVG 海报和超大响应', async () => {
  const client = new EmbyClient({ interval: 1, retries: 0, fetchImpl: async () => { throw new Error('secret-url-and-token') } })
  await assert.rejects(client.request({ id: 'id', url: 'http://localhost' }, '/path'), error => error.message === '连接失败或请求超时')
  client.fetchImpl = async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } })
  await assert.rejects(client.request({ id: 'id', url: 'http://localhost' }, '/image', { image: true }), /不支持/)
  client.fetchImpl = async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })
  await assert.rejects(client.request({ id: 'id', url: 'http://localhost' }, '/image', { image: true }), /过大/)
})

test('递归未返回单集且忽略 Episode 条件时，走用户目录回退而不误报零', async t => {
  const mock = await mockEmby('probe', { limitedCatalog: true })
  t.after(() => mock.close())
  const server = { id: 'probe', url: mock.url }
  const client = new EmbyClient({ interval: 1, retries: 0 })
  const secret = await client.login(server, { username: 'fixture-user', password: 'fixture-pass' })
  const request = client.request.bind(client)
  client.request = async (server, path, options) => {
    const url = new URL(path, server.url)
    if (url.searchParams.get('IncludeItemTypes') === 'Movie,Series,Season,Episode') {
      return { Items: [{ Id: 'series', Type: 'Series' }], TotalRecordCount: 1 }
    }
    return request(server, path, options)
  }
  const result = await client.catalog(server, secret)
  assert.equal(result.mode, 'seasons')
  assert.equal(result.items.filter(item => item.Type === 'Series').length, 2)
  assert.ok(result.items.some(item => item.Id === 'box-movie'))
  assert.ok(mock.calls.some(call => call.query.IncludeItemTypes === 'Episode'))
})

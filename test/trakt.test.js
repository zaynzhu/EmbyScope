import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { RateLimiter } from '../src/emby.js'
import { TraktService } from '../src/trakt.js'
import { createApp } from '../src/server.js'

const CLIENT_ID = 'fixture-client-id-1234'
const movie = { title: '模拟电影', year: 2025, ids: { trakt: 1, tmdb: 11 } }
const show = { title: '模拟剧集', ids: { trakt: 2 } }
const episode = { title: '模拟单集', season: 1, number: 2, ids: { trakt: 3 } }
const WHEN = '2026-10-24T12:00:00.000Z'
const tokens = () => ({ access_token: 'new-private-access', refresh_token: 'new-private-refresh', created_at: Math.floor(Date.now() / 1000), expires_in: 604800, token_type: 'bearer' })
const page = (data, current = 1, totalPages = 1, count = data.length) => Response.json(data, { headers: { 'X-Pagination-Page': String(current), 'X-Pagination-Page-Count': String(totalPages), 'X-Pagination-Item-Count': String(count), 'X-Pagination-Limit': '100' } })
function defaultResponse(path) {
  if (path === '/users/settings') return Response.json({ user: { username: 'fixture-user', ids: { slug: 'fixture-user' } } })
  if (path === '/sync/history') return page([{ type: 'movie', movie, watched_at: WHEN }, { type: 'episode', episode, show, watched_at: WHEN }])
  if (path === '/sync/watched/movies') return page([{ movie, plays: 2, last_watched_at: WHEN }])
  if (path === '/sync/watched/shows') return page([{ show, seasons: [{ number: 1, episodes: [{ number: 2, plays: 1, last_watched_at: WHEN }] }] }])
  if (path === '/sync/playback') return page([{ type: 'movie', movie, paused_at: WHEN, progress: 43.5 }])
  throw new Error('未预期的模拟请求')
}
function fixture(t, handler = (url, options) => defaultResponse(url.pathname)) {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-trakt-'))
  const store = new Store(directory)
  const calls = []
  const service = new TraktService(store, { limiter: new RateLimiter(1), fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options })
    return handler(new URL(url), options)
  } })
  service.configure({ clientId: CLIENT_ID })
  service.write('traktCredentials', { clientId: CLIENT_ID, account: 'fixture-user', accountId: 'fixture-user', accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600000 }, true)
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { store, service, calls }
}

test('Trakt 独立读取最近已看、全量已看与进度，保留单集语义且不泄露凭据', async t => {
  const { service, calls, store } = fixture(t)
  service.start()
  await service.job
  assert.equal(service.status().error, null)
  assert.deepEqual(service.status().counts, { recent: 2, watched: 2, playback: 1 })
  const watched = service.list(new URLSearchParams({ kind: 'watched', type: 'episode' }))
  assert.equal(watched.total, 1)
  assert.equal(watched.items[0].id, 'show:2:1:2')
  assert.equal(watched.items[0].traktId, null)
  assert.equal(watched.items[0].plays, 1)
  assert.equal(service.list(new URLSearchParams({ kind: 'playback' })).items[0].progress, 43.5)
  assert.ok(calls.every(call => call.url.origin === 'https://api.trakt.tv' && call.options.method === 'GET'))
  assert.equal(calls.find(call => call.url.pathname === '/sync/watched/shows').url.searchParams.get('extended'), 'progress')
  assert.doesNotMatch(JSON.stringify(service.status()), /private-access|private-refresh|fixture-client-id/)
  assert.doesNotMatch(store.db.prepare("SELECT value FROM settings WHERE name='traktCredentials'").get().value, /private-access/)
})

test('Trakt 任一分页失败或分页不完整，保留整份旧快照', async t => {
  let fail = false
  const { service } = fixture(t, url => fail && url.pathname === '/sync/watched/shows' ? Response.json([], { status: 200 }) : defaultResponse(url.pathname))
  service.start(); await service.job
  const before = service.list(new URLSearchParams())
  fail = true
  service.start(); await service.job
  assert.match(service.status().error, /分页信息/)
  assert.deepEqual(service.list(new URLSearchParams()), before)
})

test('Trakt 使用实际分页头，去除重复观看但保留最新一次，分页变化拒绝提交', async t => {
  let corrupt = false
  const { service, calls } = fixture(t, url => {
    if (url.pathname === '/sync/history') return page([{ type: 'movie', movie, watched_at: '2026-10-23T12:00:00Z' }, { type: 'movie', movie, watched_at: WHEN }])
    if (url.pathname === '/sync/watched/movies') {
      const current = Number(url.searchParams.get('page'))
      return page([{ movie: { ...movie, ids: { trakt: current } }, plays: 1, last_watched_at: WHEN }], current, 2, corrupt && current === 2 ? 3 : 2)
    }
    return defaultResponse(url.pathname)
  })
  service.start(); await service.job
  assert.equal(service.status().error, null)
  assert.equal(service.status().counts.recent, 1)
  assert.equal(service.list(new URLSearchParams()).items[0].watchedAt, WHEN)
  assert.ok(calls.some(call => call.url.searchParams.get('page') === '2'))
  const before = service.status().updatedAt
  corrupt = true
  service.start(); await service.job
  assert.match(service.status().error, /分页期间/)
  assert.equal(service.status().updatedAt, before)
})

test('Trakt 刷新令牌串行且加密持久化，刷新失败要求重新授权', async t => {
  let fail = false
  const { service, calls } = fixture(t, (url, options) => {
    if (url.pathname === '/oauth/token') {
      assert.equal(url.origin, 'https://auth.trakt.tv')
      assert.equal(JSON.parse(options.body).refresh_token, 'private-refresh')
      return fail ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json(tokens())
    }
    assert.equal(options.headers.Authorization, 'Bearer new-private-access')
    assert.equal(service.credentials().refreshToken, 'new-private-refresh')
    return defaultResponse(url.pathname)
  })
  service.write('traktCredentials', { ...service.credentials(), expiresAt: 0 }, true)
  service.start()
  assert.throws(() => service.start(), /正在进行/)
  await service.job
  assert.equal(service.status().error, null)
  assert.equal(calls.filter(call => call.url.pathname === '/oauth/token').length, 1)
  fail = true
  service.write('traktCredentials', { ...service.credentials(), refreshToken: 'private-refresh', expiresAt: 0 }, true)
  service.start(); await service.job
  assert.equal(service.status().connected, false)
  assert.match(service.status().error, /重新连接/)
  assert.equal(service.status().counts.watched, 2)
})

test('Trakt 断开或换应用后，旧请求即使返回也不能重新写入', async t => {
  let release
  let reached
  const pending = new Promise(resolve => { reached = resolve })
  const { service } = fixture(t, async url => {
    reached()
    await new Promise(resolve => { release = resolve })
    return defaultResponse(url.pathname)
  })
  service.start()
  await pending
  service.configure({ clientId: 'different-client-id-1234' })
  release()
  await service.job
  assert.equal(service.status().connected, false)
  assert.equal(service.status().counts.recent, 0)
  assert.equal(service.status().error, null)
})

test('Trakt 限流遵守 Retry-After，HTML 防护页不误报授权失效或空数据', async t => {
  const { service, calls } = fixture(t, () => Response.json({}, { status: 429, headers: { 'retry-after': '120' } }))
  service.start(); await service.job
  assert.ok(service.retryAt > Date.now() + 110000)
  service.start(); await service.job
  assert.equal(calls.length, 1)
  const second = fixture(t, () => new Response('<html>private response</html>', { status: 403, headers: { 'content-type': 'text/html' } }))
  second.service.start(); await second.service.job
  assert.match(second.service.status().error, /网络防护/)
  assert.doesNotMatch(second.service.status().error, /private response/)
  assert.equal(second.service.status().connected, true)
})

test('Trakt 离线与只读白名单阻止外联和远端记录写入', async t => {
  const { service, calls } = fixture(t)
  service.offline = () => true
  assert.throws(() => service.start(), /离线/)
  assert.throws(() => service.connect(), /离线/)
  assert.equal(service.list(new URLSearchParams()).available, false)
  service.offline = () => false
  await assert.rejects(service.request('/sync/history', { body: { movies: [] }, signal: new AbortController().signal }), /不允许修改/)
  await assert.rejects(service.request('/scrobble/start', { signal: new AbortController().signal }), /白名单/)
  assert.equal(calls.length, 0)
})

test('Trakt 应用未识别与账号授权失效分开提示，不泄露远端错误正文', async t => {
  const { service } = fixture(t, () => Response.json({ error: 'invalid_client', error_description: 'private-client-detail' }, { status: 401 }))
  service.connect()
  await service.job
  assert.match(service.status().error, /未识别此应用 Client ID/)
  assert.doesNotMatch(service.status().error, /private-client-detail|授权失效/)
})

test('Trakt 设备码授权不暴露 device_code，成功后独立保存新令牌并同步', async t => {
  const { service } = fixture(t, url => {
    if (url.pathname === '/oauth/device/code') return Response.json({ device_code: 'private-device', user_code: 'ABC12345', verification_url: 'https://auth.trakt.tv/activate', expires_in: 600, interval: 1 })
    if (url.pathname === '/oauth/device/token') return Response.json(tokens())
    return defaultResponse(url.pathname)
  })
  service.connect()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(service.status().device.userCode, 'ABC12345')
  assert.doesNotMatch(JSON.stringify(service.status()), /private-device|private-access/)
  await service.job
  assert.equal(service.status().connected, true)
  assert.equal(service.status().device, null)
  assert.equal(service.status().counts.playback, 1)
  assert.equal(service.credentials().accessToken, 'new-private-access')
})

test('Trakt 本机 API 保留桌面密钥、写入来源校验与离线保护', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-trakt-api-'))
  const app = createApp({ dataDir: directory, scheduler: false, desktopKey: 'fixture-key', offline: true, traktOptions: { fetchImpl: () => { throw new Error('禁止外联') } } })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }) })
  const url = `http://127.0.0.1:${app.server.address().port}`
  assert.equal((await fetch(`${url}/api/trakt/status`)).status, 403)
  const headers = { 'x-embyscope-desktop': 'fixture-key', 'x-embyscope': '1', 'content-type': 'application/json' }
  assert.equal((await fetch(`${url}/api/trakt/status`, { headers })).status, 200)
  assert.equal((await fetch(`${url}/api/trakt/connect`, { headers, method: 'POST', body: '{}' })).status, 409)
  assert.equal((await fetch(`${url}/api/trakt/connect`, { headers: { ...headers, origin: 'https://example.com' }, method: 'POST', body: '{}' })).status, 403)
})

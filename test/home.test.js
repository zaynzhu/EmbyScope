import test from 'node:test'
import assert from 'node:assert/strict'
import { homeSnapshot } from '../src/home.js'
import { createApp } from '../src/server.js'
import { EmbyClient } from '../src/emby.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('首页仅采用有效最后播放时间，保留跨服身份和最新快照，入库不冒充观看', () => {
  const rows = ['a', 'b'].map(id => ({ id, name: id, status: id === 'a' ? 'online' : 'offline', lightMinutes: 60, fullHours: 24 }))
  const movie = { id: 'same', type: 'Movie', lastPlayed: '2026-10-19T12:00:00Z' }
  const store = { cache: (id, kind) => kind === 'catalog' ? { updatedAt: '2026-10-20T12:00:00Z', data: [movie, { id: 'new', type: 'Movie', createdAt: '2026-10-20T15:00:00Z' }, { id: 'future', type: 'Movie', lastPlayed: '2099-01-01T00:00:00Z' }] } : kind === 'resume' && id === 'a' ? { updatedAt: '2026-10-20T13:00:00Z', data: [{ ...movie, lastPlayed: '2026-10-20T10:00:00Z' }] } : { data: null, error: '无权限' } }
  const home = homeSnapshot(store, rows, Date.parse('2026-10-21'))
  assert.deepEqual(home.recent.map(item => item.key), ['a:same', 'b:same'])
  assert.equal(home.recent[0].lastPlayed, '2026-10-20T10:00:00Z')
  assert.equal(home.resume.length, 1)
  assert.ok(home.sources.find(source => source.serverId === 'b' && source.kind === 'catalog').stale)
  assert.equal(homeSnapshot(store, [rows[1]]).recent.length, 1)
  const empty = homeSnapshot({ cache: () => null }, rows)
  assert.equal(empty.historyAvailable, false)
  assert.ok(empty.emptyReason)
})

test('桌面启动密钥不替代管理员认证，动态端口仍校验请求来源', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'embyscope-desktop-test-'))
  const app = createApp({ dataDir: dir, scheduler: false, desktopKey: 'a'.repeat(64) })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${app.server.address().port}`
  assert.equal((await fetch(base + '/health')).status, 403)
  const headers = { 'X-EmbyScope-Desktop': 'a'.repeat(64), 'X-EmbyScope': '1', 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + '/api/home', { headers })).status, 401)
  assert.equal((await fetch(base + '/api/auth/setup', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ password: 'desktop-test-password' }) })).status, 403)
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ password: 'desktop-test-password' }) })
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(base + '/api/home', { headers: { ...headers, Cookie: cookie } })).status, 200)
})

test('退出会取消在途请求和限流队列，不再启动远端请求', async () => {
  let calls = 0
  const client = new EmbyClient({ interval: 2000, retries: 0, fetchImpl: async (_url, options) => {
    calls++
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  } })
  const row = { id: 'test', url: 'http://example.invalid' }
  const pending = [client.request(row, '/a'), client.request(row, '/b')]
  await new Promise(resolve => setTimeout(resolve, 20))
  client.close()
  const results = await Promise.allSettled(pending)
  assert.equal(calls, 1)
  assert.ok(results.every(result => result.status === 'rejected'))
})


test('兼容接口的0001年占位时间不作为观看记录，继续观看仍保留', () => {
  const row = { id: 'a', name: 'a', status: 'online', lightMinutes: 60, fullHours: 24 }
  const store = { cache: () => ({ updatedAt: '2026-10-20T12:00:00Z', data: [
    { id: 'placeholder', type: 'Series', lastPlayed: '0001-01-01T00:00:00Z' },
    { id: 'real', type: 'Movie', lastPlayed: '2026-10-19T00:00:00Z' }
  ] }) }
  const home = homeSnapshot(store, [row], Date.parse('2026-10-21'))
  assert.deepEqual(home.recent.map(item => item.id), ['real'])
  assert.equal(home.resume.length, 2)
})

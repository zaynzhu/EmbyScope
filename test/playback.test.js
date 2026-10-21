import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { createApp } from '../src/server.js'
import { Service } from '../src/service.js'
import { normalizeSessions, playbackSnapshot, refreshPlayback } from '../src/playback.js'

const now = Date.parse('2026-10-21T10:00:00Z')
const session = { Id: 'session', UserId: 'user', LastActivityDate: new Date(now).toISOString(), Client: 'Infuse', DeviceName: 'Mac', NowPlayingItem: { Id: 'item', Name: '模拟电影', RunTimeTicks: 600000000, Path: '/secret' }, PlayState: { IsPaused: false, PositionTicks: 300000000 }, AccessToken: 'not-public', RemoteEndPoint: 'private-address' }

test('会话仅属于当前账号，白名单字段、暂停与缺失心跳、同名跨服身份', () => {
  const rows = normalizeSessions([session, { ...session, Id: 'other', UserId: 'another' }, { ...session, Id: 'idle', NowPlayingItem: null }], 'user', now)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'playing')
  assert.ok(!JSON.stringify(rows).includes('not-public'))
  assert.ok(!JSON.stringify(rows).includes('private-address'))
  assert.ok(!JSON.stringify(rows).includes('/secret'))
  assert.equal(normalizeSessions([{ ...session, PlayState: { IsPaused: true } }], 'user', now)[0].state, 'paused')
  assert.equal(normalizeSessions([{ ...session, LastActivityDate: null }], 'user', now)[0].state, 'unknown')
  assert.equal(normalizeSessions([session], 'user', now + 91000)[0].state, 'unknown')
  assert.throws(() => normalizeSessions({}, 'user'))
  const store = { cache: () => ({ data: rows, updatedAt: new Date(now).toISOString() }) }
  const servers = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }]
  assert.equal(playbackSnapshot(store, servers, false, now).servers.length, 2)
  assert.equal(playbackSnapshot(store, servers, false, now + 61000).servers[0].sessions[0].state, 'unknown')
  assert.equal(playbackSnapshot(store, servers, true, now).servers[0].sessions[0].state, 'unknown')
})

test('手动会话读取按原地址独立隔离、限冷却、失败保留旧快照但不冒充播放', async t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-playback-'))
  const store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  for (const id of ['a', 'b']) {
    store.db.prepare('INSERT INTO servers(id,name,url,proxyUrl,secret) VALUES(?,?,?,?,?)').run(id, id, `http://${id}.invalid`, `http://${id}.invalid:19000`, store.encrypt({ userId: 'user', token: 'fixture' }))
    store.saveCache(id, 'catalog', [{ id: 'existing', type: 'Movie' }])
  }
  let calls = 0
  let fail = 0
  const service = new Service(store, { request: async (row, path) => {
    calls++
    assert.equal(row.url, `http://${row.id}.invalid`)
    assert.equal(path, '/Sessions')
    if (row.id === 'b' || fail) throw Object.assign(new Error('secret'), { status: fail || 404 })
    return [{ ...session, LastActivityDate: new Date().toISOString() }]
  } })
  await Promise.all(store.servers().map(row => refreshPlayback(service, row)))
  let snapshot = playbackSnapshot(store, store.servers())
  assert.equal(snapshot.servers[0].sessions[0].state, 'playing')
  assert.equal(snapshot.servers[1].available, false)
  assert.match(snapshot.servers[1].error, /不可用/)
  await refreshPlayback(service, store.server('a'))
  assert.equal(calls, 2)
  store.db.prepare("DELETE FROM cache WHERE kind='playbackAttempt'").run()
  fail = 503
  await refreshPlayback(service, store.server('a'))
  snapshot = playbackSnapshot(store, store.servers())
  assert.equal(snapshot.servers[0].sessions[0].state, 'unknown')
  assert.ok(!snapshot.servers[0].error.includes('secret'))
  store.db.prepare("DELETE FROM cache WHERE kind='playbackAttempt'").run()
  fail = 403
  await refreshPlayback(service, store.server('a'))
  assert.equal(playbackSnapshot(store, store.servers()).servers[0].available, false)
  assert.equal(store.cache('a', 'catalog').data.length, 1)
  await assert.rejects(refreshPlayback(new Service(store, {}, { offline: true }), store.server('a')), /离线/)
})

test('会话读取期间账号被替换，旧结果不回写', async t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-playback-race-'))
  const store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)').run('a', '甲', 'http://a.invalid', store.encrypt({ userId: 'user', token: 'fixture' }))
  let finish
  const service = new Service(store, { request: () => new Promise(resolve => { finish = resolve }) })
  const job = refreshPlayback(service, store.server('a'))
  store.db.prepare('UPDATE servers SET revision=revision+1 WHERE id=?').run('a')
  finish([session])
  await job
  assert.equal(store.cache('a', 'playback'), null)
  assert.equal(service.playbackJobs.size, 0)
})


test('首页GET不读取远端，手动接口需要管理员认证且只读会话', async t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-playback-http-'))
  let calls = 0
  const app = createApp({ dataDir: root, scheduler: false, client: { request: async (_row, path) => {
    calls++
    assert.equal(path, '/Sessions')
    return [{ ...session, LastActivityDate: new Date().toISOString() }]
  } } })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  app.store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)').run('a', '甲', 'http://a.invalid', app.store.encrypt({ userId: 'user', token: 'fixture' }))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'Content-Type': 'application/json', 'X-EmbyScope': '1' }
  assert.equal((await fetch(base + '/api/playback/refresh', { method: 'POST', headers, body: '{}' })).status, 401)
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ password: 'fixture-password-long' }) })
  headers.Cookie = setup.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(base + '/api/home', { headers })).status, 200)
  assert.equal(calls, 0)
  assert.equal((await fetch(base + '/api/playback/refresh', { method: 'POST', headers, body: '{}' })).status, 200)
  const snapshot = await (await fetch(base + '/api/home', { headers })).json()
  assert.equal(calls, 1)
  assert.equal(snapshot.playback.servers[0].sessions[0].state, 'playing')
  assert.equal(app.store.cache('a', 'catalog'), null)
})

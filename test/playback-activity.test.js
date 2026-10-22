import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ResumeActivityDetector } from '../src/playback-activity.js'
import { refreshPlayback, playbackSnapshot } from '../src/playback.js'
import { Store } from '../src/store.js'
import { Service } from '../src/service.js'
import { EmbyClient } from '../src/emby.js'
import { createApp } from '../src/server.js'

const start = Date.parse('2026-10-22T17:00:00Z')
const item = (position, stamp = position, id = 'same') => ({ Id: id, Name: '测试影片',
  UserData: { PlaybackPositionTicks: position * 10000000, LastPlayedDate: new Date(start + 8 * 3600000 + stamp * 1000).toISOString() } })
const observe = (detector, at, position, stamp = position) => detector.observe({ Items: [item(position, stamp)] }, 'user', start + at * 1000)

test('连续两次推进才建立活动，首次及单次退出保存不误报，暂停后60秒消退', () => {
  const detector = new ResumeActivityDetector()
  assert.equal(observe(detector, 0, 100).status, 'warming')
  assert.equal(observe(detector, 15, 115).sessions.length, 0)
  const active = observe(detector, 30, 130)
  assert.equal(active.status, 'activity')
  assert.equal(active.sessions[0].title, '测试影片')
  assert.equal(active.sessions[0].positionTicks, null)
  assert.equal(active.sessions[0].client, null)
  for (const at of [45, 60, 75]) assert.equal(observe(detector, at, 130).status, 'activity')
  assert.equal(observe(detector, 90, 130).status, 'no_activity')
  assert.equal(observe(detector, 105, 131).status, 'no_activity')
  assert.equal(observe(detector, 120, 131).status, 'no_activity')
  assert.equal(observe(detector, 135, 146).sessions.length, 0)
  assert.equal(observe(detector, 150, 161).status, 'activity')
})

test('历史静态记录、Played完成标志、只有时间变化均不建立活动', () => {
  const detector = new ResumeActivityDetector()
  for (let at = 0; at <= 90; at += 15) {
    const row = item(100, at)
    row.UserData.Played = true
    const result = detector.observe({ Items: [row] }, 'user', start + at * 1000)
    assert.equal(result.sessions.length, 0)
    assert.equal(result.status, at < 60 ? 'warming' : 'no_activity')
  }
})

test('大幅拖动、倒退、取样中断、时钟倒退均需重新观察', () => {
  const detector = new ResumeActivityDetector()
  observe(detector, 0, 100)
  observe(detector, 15, 115)
  assert.equal(observe(detector, 30, 2000).sessions.length, 0)
  assert.equal(observe(detector, 45, 2015).sessions.length, 0)
  assert.equal(observe(detector, 60, 2030).sessions.length, 1)
  assert.equal(observe(detector, 75, 20).sessions.length, 0)
  assert.equal(observe(detector, 130, 40).status, 'warming')
  assert.equal(observe(detector, 100, 60).status, 'warming')
})

test('列表消失与无效数据不是停止，空列表也不冒充完整会话列表', () => {
  const detector = new ResumeActivityDetector()
  observe(detector, 0, 100)
  observe(detector, 15, 115)
  observe(detector, 30, 130)
  for (const at of [45, 60, 75]) assert.equal(detector.observe({ Items: [] }, 'user', start + at * 1000).status, 'unknown')
  assert.equal(detector.observe({ Items: [] }, 'user', start + 90000).status, 'no_activity')
  assert.equal(detector.observe({ Items: [{ Id: 'x', UserData: { PlaybackPositionTicks: null } }] }, 'user', start + 105000).status, 'unknown')
  for (const response of [{}, { Items: Array(19).fill(item(1)) }, { Items: [item(1), item(2)] },
    { UserId: 'other', Items: [] }, { Items: [{ ...item(1), UserId: 'other' }] }]) {
    assert.throws(() => detector.observe(response, 'user', start + 120000))
  }
  const zero = new ResumeActivityDetector()
  observe(zero, 0, 0)
  observe(zero, 15, 15)
  assert.equal(observe(zero, 30, 30).status, 'activity')
})

test('21次已授权实测的脱敏时间序列重放：播放及恢复可识别，静态历史不混入', () => {
  const rounds = JSON.parse(readFileSync(new URL('./fixtures/resume-activity.json', import.meta.url)))
  assert.equal(rounds.flatMap(round => round.samples).length, 21)
  for (const round of rounds) {
    const detector = new ResumeActivityDetector()
    for (const sample of round.samples) {
      const result = detector.observe({ Items: sample.items.map(row => ({ Id: row.id, Name: '模拟片名',
        UserData: { PlaybackPositionTicks: row.positionTicks, LastPlayedDate: row.lastPlayedDate } })) }, 'user', sample.at)
      assert.ok(result.sessions.every(row => row.id === 'target'))
      if (sample.index >= 3 && ['playing', 'resumed'].includes(sample.phase)) assert.equal(result.status, 'activity')
      if (sample.phase === 'baseline') assert.equal(result.sessions.length, 0)
    }
  }
})

test('兼容读取仅当前用户18条、无重试、不扫库；跨服隔离、失败退避与观察轮次重建', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-activity-'))
  const store = new Store(directory)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  for (const id of ['a', 'b']) store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)')
    .run(id, id, `http://${id}.invalid`, store.encrypt({ token: 'fixture-secret', userId: 'u/1' }))
  let calls = 0
  let fail = false
  const service = new Service(store, { request: async (row, path, options) => {
    calls++
    assert.equal(row.url, `http://${row.id}.invalid`)
    assert.equal(path, '/Users/u%2F1/Items/Resume?Limit=18&EnableUserData=true')
    assert.equal(options.retries, 0)
    assert.equal(options.mediaBrowser, true)
    assert.equal(options.maxBytes, 1048576)
    if (fail) throw Object.assign(new Error('fixture-secret'), { status: 403 })
    return { Items: [item(100)] }
  } })
  const options = { compatibility: true, observationId: 'first' }
  await Promise.all(store.servers().map(row => refreshPlayback(service, row, options)))
  assert.equal(calls, 2)
  assert.notEqual(service.playbackObservers.get('a').detector, service.playbackObservers.get('b').detector)
  let source = playbackSnapshot(store, store.servers()).servers[0]
  assert.equal(source.mode, 'activity')
  assert.equal(source.activityStatus, 'warming')
  assert.equal(store.cache('a', 'resume'), null)
  assert.equal(service.settings().automaticUpdates, false)
  await refreshPlayback(service, store.server('a'), options)
  assert.equal(calls, 2)
  const previous = service.playbackObservers.get('a').detector
  store.saveCache('a', 'playbackAttempt', { at: Date.now() - 16000 })
  await refreshPlayback(service, store.server('a'), { ...options, observationId: 'new-foreground' })
  assert.notEqual(service.playbackObservers.get('a').detector, previous)
  assert.equal(calls, 3)
  fail = true
  store.saveCache('a', 'playbackAttempt', { at: Date.now() - 16000 })
  await refreshPlayback(service, store.server('a'), options)
  source = playbackSnapshot(store, store.servers()).servers[0]
  assert.equal(source.activityStatus, 'unknown')
  assert.equal(source.sessions.length, 0)
  assert.ok(!JSON.stringify(source).includes('fixture-secret'))
  assert.equal(service.playbackObservers.has('a'), false)
  store.saveCache('a', 'playbackAttempt', { at: Date.now() - 16000 })
  await refreshPlayback(service, store.server('a'), options)
  assert.equal(calls, 4)
  fail = false
  store.saveCache('a', 'playbackAttempt', { at: Date.now() - 61000 })
  await refreshPlayback(service, store.server('a'), options)
  assert.equal(playbackSnapshot(store, store.servers()).servers[0].activityStatus, 'warming')
  const cache = store.cache('a', 'playback')
  assert.equal(playbackSnapshot(store, store.servers(), false, Date.parse(cache.updatedAt) + 36000).servers[0].activityStatus, 'unknown')
  assert.equal(playbackSnapshot(store, store.servers(), true).servers[0].activityStatus, 'unknown')
})

test('兼容请求沿用限流器且令牌只在头部，禁止重定向及重试并限制响应大小', async () => {
  let calls = 0
  let mode = 'ok'
  const starts = []
  const client = new EmbyClient({ interval: 5, fetchImpl: async (url, init) => {
    starts.push(Date.now())
    calls++
    assert.ok(!url.toString().includes('fixture-secret'))
    assert.equal(init.headers['X-Emby-Token'], 'fixture-secret')
    assert.match(init.headers['X-Emby-Authorization'], /^MediaBrowser /)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.method, 'GET')
    if (mode === 'failure') return new Response('', { status: 503 })
    if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'http://other.invalid' } })
    return new Response(JSON.stringify({ Items: [item(100)] }))
  } })
  const row = { id: 'a', url: 'http://fixture.invalid' }
  const options = { token: 'fixture-secret', mediaBrowser: true, retries: 0, maxBytes: 1048576 }
  await client.request(row, '/Users/user/Items/Resume?Limit=18', options)
  await client.request(row, '/Users/user/Items/Resume?Limit=18', options)
  assert.ok(starts[1] - starts[0] >= 5)
  mode = 'failure'
  await assert.rejects(client.request(row, '/Users/user/Items/Resume', options))
  assert.equal(calls, 3)
  mode = 'redirect'
  await assert.rejects(client.request(row, '/Users/user/Items/Resume', options))
  assert.equal(calls, 4)
  mode = 'ok'
  await assert.rejects(client.request(row, '/Users/user/Items/Resume', { ...options, maxBytes: 5 }), /过大/)
  assert.equal(calls, 5)
  assert.equal(new EmbyClient().limiter.interval, 2000)
})

test('兼容请求中更换账号后不写回旧结果，新版本重新建立基线', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-activity-race-'))
  const store = new Store(directory)
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
  store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)')
    .run('a', 'a', 'http://a.invalid', store.encrypt({ token: 'fixture', userId: 'user' }))
  let release
  const service = new Service(store, { request: () => new Promise(resolve => { release = resolve }) })
  const options = { compatibility: true, observationId: 'one' }
  const first = refreshPlayback(service, store.server('a'), options)
  const previous = service.playbackObservers.get('a').detector
  store.db.prepare('UPDATE servers SET revision=revision+1 WHERE id=?').run('a')
  release({ Items: [item(100)] })
  await first
  assert.equal(store.cache('a', 'playback'), null)
  store.db.prepare("DELETE FROM cache WHERE kind='playbackAttempt'").run()
  const second = refreshPlayback(service, store.server('a'), options)
  assert.notEqual(service.playbackObservers.get('a').detector, previous)
  release({ Items: [item(200)] })
  await second
  assert.equal(playbackSnapshot(store, store.servers()).servers[0].activityStatus, 'warming')
})

test('HTTP明确选择兼容服务器；默认仍查会话，参数错误零请求，切换不混用快照', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-activity-http-'))
  const calls = []
  const app = createApp({ dataDir: directory, scheduler: false, client: { request: async (row, path) => {
    calls.push([row.id, path])
    return path === '/Sessions' ? [] : { Items: [item(100)] }
  } } })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }) })
  for (const id of ['a', 'b']) app.store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)')
    .run(id, id, `http://${id}.invalid`, app.store.encrypt({ token: 'fixture', userId: 'user' }))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'Content-Type': 'application/json', 'X-EmbyScope': '1' }
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ password: 'fixture-password-long' }) })
  headers.Cookie = setup.headers.get('set-cookie').split(';')[0]
  const request = body => fetch(base + '/api/playback/refresh', { method: 'POST', headers, body: JSON.stringify(body) })
  for (const body of [{ compatibilityServers: 'b' }, { compatibilityServers: ['b'] }, { compatibilityServers: [1], observationId: 'x' }]) {
    assert.equal((await request(body)).status, 400)
  }
  assert.equal(calls.length, 0)
  const snapshot = await (await request({ compatibilityServers: ['b'], observationId: 'x' })).json()
  assert.equal(snapshot.servers[0].mode, 'sessions')
  assert.equal(snapshot.servers[1].mode, 'activity')
  assert.deepEqual(calls, [['a', '/Sessions'], ['b', '/Users/user/Items/Resume?Limit=18&EnableUserData=true']])
  app.store.db.prepare("DELETE FROM cache WHERE kind='playbackAttempt'").run()
  const direct = await (await request({ server: 'b' })).json()
  assert.equal(direct.servers[0].mode, 'sessions')
  assert.equal(app.service.playbackObservers.has('b'), false)
  assert.equal(calls.length, 3)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'
import { EmbyClient } from '../src/emby.js'
import { mockEmby } from './fixtures.js'

async function fixture(t, aOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'embyscope-test-'))
  const a = await mockEmby('A', aOptions)
  const b = await mockEmby('B')
  const app = createApp({ dataDir, scheduler: false, client: new EmbyClient({ interval: 1, timeout: 1000, retries: 0 }) })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  let cookie = ''
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-EmbyScope': '1', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
    return { status: response.status, data, headers: response.headers }
  }
  t.after(async () => {
    await app.close()
    await Promise.all([a.close(), b.close()])
    rmSync(dataDir, { recursive: true, force: true })
  })
  const connect = async (mock, name) => {
    const result = await request('/api/servers', 'POST', { name, url: mock.url, username: 'fixture-user', password: 'fixture-pass' })
    assert.equal(result.status, 201)
    return result.data.id
  }
  return { app, a, b, request, connect, dataDir }
}

test('初始化、认证、会话、跨站保护、凭据加密及退出', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/servers')).status, 401)
  assert.equal((await f.request('/api/auth/setup', 'POST', { password: 'short' })).status, 400)
  assert.equal((await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' }, { Origin: 'https://evil.example' })).status, 403)
  const setup = await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  assert.equal(setup.status, 200)
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
  assert.equal((await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })).status, 409)
  const id = await f.connect(f.a, '测试 A')
  await f.app.service.drain()
  const server = f.app.store.server(id)
  assert.ok(!server.secret.includes('fixture'))
  assert.equal(f.app.store.decrypt(server.secret).token, 'secret-token-A')
  const publicData = JSON.stringify((await f.request('/api/servers')).data)
  for (const secret of ['fixture-user', 'fixture-pass', 'secret-token-A', 'same-user-id']) assert.ok(!publicData.includes(secret))
  assert.equal(statSync(join(f.dataDir, 'secret.key')).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(f.dataDir, 'secret.key')).length, 32)
  assert.equal((await f.request('/api/servers', 'POST', {}, { 'X-EmbyScope': '' })).status, 403)
  await f.request('/api/auth/logout', 'POST', {})
  assert.equal((await f.request('/api/overview')).status, 401)
  assert.equal((await f.request('/api/auth/login', 'POST', { password: 'wrong-long-password' })).status, 401)
  assert.equal((await f.request('/api/auth/login', 'POST', { password: 'long-local-password' })).status, 200)
})

test('两台分别查看和汇总、远端分页、作品去重、编号冲突、筛选与详情分页', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const aId = await f.connect(f.a, '影院 A')
  const bId = await f.connect(f.b, '影院 B')
  await f.app.service.drain()
  const all = (await f.request('/api/overview')).data
  assert.equal(all.stats.movies, 62)
  assert.equal(all.stats.series, 2)
  assert.equal(all.stats.episodes, 110)
  assert.equal(all.stats.libraries, 2)
  assert.equal(all.stats.entries, 64)
  assert.equal(all.stats.uniqueWorks, 34)
  assert.equal(all.stats.conflicts, 2)
  assert.equal(all.stats.history, null)
  for (const id of [aId, bId]) {
    const single = (await f.request(`/api/overview?server=${id}`)).data
    assert.equal(single.stats.movies, 31)
    assert.equal(single.stats.episodes, 55)
    assert.equal(single.stats.uniqueWorks, 32)
    assert.equal(single.resume[0].serverId, id)
  }
  const first = (await f.request('/api/library?pageSize=10&page=1')).data
  const second = (await f.request('/api/library?pageSize=10&page=2')).data
  assert.equal(first.total, 34)
  assert.equal(first.items.length, 10)
  assert.ok(!first.items.some(item => second.items.some(other => other.key === item.key)))
  const movie = (await f.request(`/api/library?type=Movie&q=${encodeURIComponent('星际穿越')}`)).data
  assert.equal(movie.total, 5)
  assert.ok(movie.items.every(item => item.sources.length === 2))
  const series = (await f.request(`/api/items/${aId}/series?page=2`)).data
  assert.equal(series.episodeTotal, 55)
  assert.equal(series.episodes.length, 5)
  assert.equal(series.episodePages, 2)
  assert.equal((await f.request(`/api/items/${bId}/series?season=2`)).data.episodeTotal, 25)
  assert.equal((await f.request(`/api/items/${aId}/not-present`)).status, 404)
  assert.ok(f.a.calls.filter(call => call.path.endsWith('/Items')).length >= 4)
  for (const mock of [f.a, f.b]) assert.ok(mock.calls.every(call => call.method === 'GET' || call.path === '/Users/AuthenticateByName'))
  const poster = await f.request(`/api/items/${aId}/1/poster`)
  assert.equal(poster.status, 200)
  assert.equal(poster.headers.get('content-type'), 'image/png')
  const before = f.a.calls.length
  await f.request(`/api/items/${aId}/1/poster`)
  assert.equal(f.a.calls.length, before)
})

test('单台离线保留有时间标记的缓存，另一台独立更新；权限不足不当作零', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const aId = await f.connect(f.a, '影院 A')
  f.b.state.denied.add('/Users/same-user-id/Items/Resume')
  const bId = await f.connect(f.b, '影院 B')
  await f.app.service.drain()
  let b = f.app.service.listServers().find(row => row.id === bId)
  assert.equal(b.status, 'partial')
  assert.equal(b.datasets.resume.available, false)
  const previous = f.app.store.cache(aId, 'catalog').updatedAt
  f.a.state.offline = true
  await f.request('/api/refresh', 'POST', {})
  await f.app.service.drain()
  const a = f.app.service.listServers().find(row => row.id === aId)
  assert.equal(a.status, 'offline')
  assert.equal(a.datasets.catalog.updatedAt, previous)
  assert.equal(a.datasets.catalog.stale, true)
  assert.equal(f.app.service.overview(aId).stats.movies, 31)
  b = f.app.service.listServers().find(row => row.id === bId)
  assert.equal(b.status, 'partial')
  f.b.state.denied.add('/Users/same-user-id/Items')
  await f.app.service.refresh(bId)
  assert.equal(f.app.service.overview(bId).stats.movies, null)
  assert.equal(f.app.service.library(new URLSearchParams({ server: bId })).total, null)
  assert.equal(f.app.service.overview().stats.complete, false)
  assert.equal(f.app.service.overview().stats.movies, 31)
})

test('兼容层逐库遍历合集与循环目录，核对文件夹类型并补全单集', async t => {
  const f = await fixture(t, { requireCompatAuth: true, limitedCatalog: true })
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const aId = await f.connect(f.a, '兼容服务器')
  await f.connect(f.b, '标准服务器')
  await f.app.service.drain()
  const single = f.app.service.overview(aId)
  assert.equal(single.servers[0].status, 'online')
  assert.equal(single.servers[0].datasets.catalog.warning, null)
  assert.equal(single.stats.movies, 32)
  assert.equal(single.stats.episodes, 58)
  assert.equal(single.stats.complete, true)
  assert.equal(f.app.service.overview().stats.episodes, 113)
  assert.equal(f.app.service.overview().stats.limitedServers, 0)
  assert.equal(single.servers[0].episodeSync.completed, 2)
  assert.ok(f.a.calls.filter(call => call.path.endsWith('/Items')).every(call => !call.query.SortBy))
  const detail = (await f.request(`/api/items/${aId}/series?page=2`)).data
  assert.equal(detail.episodeTotal, 55)
  assert.equal(detail.episodes.length, 5)
  assert.equal(detail.seasonEpisodeTotal, 55)
  assert.ok(f.app.service.library(new URLSearchParams({ server: aId })).items.length > 0)
})

test('换账号清空缓存、在途旧任务不能回写、删除连接级联清理', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const id = await f.connect(f.a, '影院 A')
  await f.app.service.drain()
  f.a.state.slow = true
  f.app.service.refresh(id)
  await f.request(`/api/servers/${id}`, 'PUT', { name: '新账号', url: f.a.url, username: 'other-user', password: 'other-password' })
  assert.equal(f.app.store.cache(id, 'catalog'), null)
  await f.app.service.drain()
  await f.app.service.drain()
  assert.equal(f.app.service.overview(id).stats.movies, null)
  assert.equal(f.app.service.listServers()[0].status, 'denied')
  await f.request(`/api/servers/${id}`, 'DELETE', {})
  assert.equal(f.app.store.servers().length, 0)
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM cache').get().n, 0)
})

test('异常分页不替换上次完整缓存，认证过期清除旧权限数据', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const id = await f.connect(f.a, '影院 A')
  await f.app.service.drain()
  const previous = f.app.store.cache(id, 'catalog').updatedAt
  f.a.state.badPages = true
  await f.app.service.refresh(id)
  assert.equal(f.app.store.cache(id, 'catalog').updatedAt, previous)
  assert.equal(f.app.service.overview(id).stats.movies, 31)
  f.a.state.badPages = false
  f.a.state.denied.add('all')
  await f.app.service.refresh(id)
  assert.equal(f.app.service.overview(id).stats.movies, null)
  assert.equal(f.app.service.overview(id).resume.length, 0)
  assert.equal(f.app.store.decrypt(f.app.store.server(id).secret).token, undefined)
})

test('NSFW 标签持久化且支持编辑，片库服务器筛选保留来源隔离', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const aId = await f.connect(f.a, '影院 A')
  const bId = await f.connect(f.b, '影院 B')
  await f.app.service.drain()
  const changed = await f.request(`/api/servers/${aId}`, 'PUT', { name: '影院 A', url: f.a.url, nsfw: true })
  assert.equal(changed.data.nsfw, true)
  await f.app.service.drain()
  assert.equal(f.app.store.server(aId).nsfw, 1)
  assert.equal(f.app.store.server(bId).nsfw, 0)
  const merged = (await f.request('/api/library')).data.items.find(item => item.sources.length === 2)
  assert.ok(merged.sources.some(source => source.serverId === aId && source.nsfw))
  for (const id of [aId, bId]) {
    const single = (await f.request(`/api/library?server=${id}&pageSize=5&page=2`)).data
    assert.equal(single.page, 2)
    assert.equal(single.total, 32)
    assert.ok(single.items.every(item => item.sources.every(source => source.serverId === id && source.nsfw === (id === aId))))
  }
  assert.equal((await f.request(`/api/items/${aId}/1`)).data.nsfw, true)
  assert.equal((await f.request(`/api/overview?server=${aId}`)).data.latest[0].nsfw, true)
  assert.equal((await f.request(`/api/servers/${aId}`, 'PUT', { name: '改名', url: f.a.url })).data.nsfw, true)
  await f.app.service.drain()
  assert.equal((await f.request(`/api/servers/${aId}`, 'PUT', { name: '影院 A', url: f.a.url, nsfw: 'false' })).status, 400)
  assert.equal((await f.request(`/api/servers/${aId}`, 'PUT', { name: '影院 A', url: f.a.url, nsfw: false })).data.nsfw, false)
})


test('兼容季集计数缺失或403不补零，恢复后续查，单集接口失败不影响作品与季计数', async t => {
  const f = await fixture(t, { limitedCatalog: true })
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  f.a.state.missingCounts = true
  const id = await f.connect(f.a, '兼容服务器')
  await f.app.service.drain()
  assert.equal(f.app.service.overview(id).stats.episodes, null)
  assert.equal(f.app.service.overview(id).stats.movies, 32)
  assert.equal(f.app.service.overview(id).servers[0].episodeSync.failed, 1)
  f.a.state.missingCounts = false
  f.app.store.db.prepare("DELETE FROM cache WHERE kind LIKE 'seasonAttempt:%'").run()
  await f.app.service.refresh(id)
  await f.app.service.drain()
  assert.equal(f.app.service.overview(id).stats.episodes, 58)
  const before = f.a.calls.filter(call => call.path.endsWith('/Seasons')).length
  await f.app.service.refresh(id)
  await f.app.service.drain()
  assert.equal(f.a.calls.filter(call => call.path.endsWith('/Seasons')).length, before)
  f.a.state.episodeTimeout = true
  const detail = (await f.request(`/api/items/${id}/series`)).data
  assert.equal(detail.episodeTotal, null)
  assert.equal(detail.seasonEpisodeTotal, 55)
  assert.ok(detail.episodeError)
  assert.equal(f.app.service.overview(id).stats.episodes, 58)
  f.app.store.db.prepare("UPDATE cache SET updatedAt='2000-01-01T00:00:00Z' WHERE kind LIKE 'seasons:%'").run()
  f.a.state.denied.add('/Shows/series/Seasons')
  await f.app.service.refresh(id)
  await f.app.service.drain()
  assert.equal(f.app.service.overview(id).stats.episodes, null)
  assert.equal(f.app.service.overview(id).stats.movies, 32)
})

test('兼容后台遇到认证失效清空权限缓存，旧版本任务不能回写；重新登录可恢复', async t => {
  const f = await fixture(t, { limitedCatalog: true })
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const id = await f.connect(f.a, '兼容服务器')
  await f.app.service.drain()
  const oldRow = f.app.store.server(id)
  f.app.store.db.prepare("UPDATE cache SET updatedAt='2000-01-01T00:00:00Z' WHERE kind LIKE 'seasons:%'").run()
  f.a.state.denied.add('all')
  f.app.service.startSeasonSync(oldRow)
  await f.app.service.drain()
  assert.equal(f.app.service.current(oldRow), false)
  assert.equal(f.app.service.overview(id).stats.movies, null)
  assert.equal(f.app.store.cache(id, 'seasons:series'), null)
  assert.equal(f.app.store.decrypt(f.app.store.server(id).secret).token, undefined)
  f.a.state.denied.clear()
  await f.app.service.refresh(id)
  await f.app.service.drain()
  assert.equal(f.app.service.overview(id).stats.episodes, 58)
  f.a.state.denied.add('all')
  await f.request(`/api/items/${id}/series`)
  assert.equal(f.app.service.overview(id).stats.movies, null)
  assert.equal(f.app.store.cache(id, 'seasons:series'), null)
})

test('兼容后台断网触发冷却，重启读取已完成季缓存不重复请求', async t => {
  const f = await fixture(t, { limitedCatalog: true })
  await f.request('/api/auth/setup', 'POST', { password: 'long-local-password' })
  const id = await f.connect(f.a, '兼容服务器')
  await f.app.service.drain()
  const { Service } = await import('../src/service.js')
  const resumed = new Service(f.app.store, f.app.service.client)
  const before = f.a.calls.length
  resumed.startSeasonSync(f.app.store.server(id))
  await resumed.drain()
  assert.equal(f.a.calls.length, before)
  f.app.store.db.prepare("UPDATE cache SET updatedAt='2000-01-01T00:00:00Z' WHERE kind LIKE 'seasons:%'").run()
  f.a.state.offline = true
  resumed.startSeasonSync(f.app.store.server(id))
  await resumed.drain()
  const stopped = f.a.calls.length
  assert.equal(stopped, before + 1)
  resumed.startSeasonSync(f.app.store.server(id))
  await resumed.drain()
  assert.equal(f.a.calls.length, stopped)
  const summary = resumed.overview(id).servers[0].episodeSync
  assert.equal(summary.total, 58)
  assert.equal(summary.stale, true)
})

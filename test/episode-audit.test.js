import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeItem } from '../src/identity.js'
import { auditSource, compareEpisodeSources, episodeAudit } from '../src/episode-audit.js'
import { createApp } from '../src/server.js'
import { RemoteError } from '../src/emby.js'

const series = (serverId = 'a', ids = { Tmdb: '12' }, title = '模拟剧') => ({ ...normalizeItem({ Id: 'series', Type: 'Series', Name: title, ProviderIds: ids }, serverId), serverName: `来源 ${serverId}` })
const rawEpisode = (episode, extra = {}) => ({ Id: `e${episode}`, Name: `第 ${episode} 集`, Type: 'Episode', SeriesId: 'series', ParentIndexNumber: 1, IndexNumber: episode, ...extra })
const episodes = (numbers, serverId = 'a') => numbers.map(number => normalizeItem(rawEpisode(number), serverId))
const inspect = (items, item = series(), options = {}) => auditSource(item, items, { available: true, updatedAt: new Date().toISOString(), ...options })

test('缺集区间按合并集和去重编号计算，不猜开头、结尾或总集数', () => {
  const items = episodes([3, 6, 6, 9])
  items.push(normalizeItem(rawEpisode(4, { IndexNumberEnd: 5 }), 'a'))
  const source = compareEpisodeSources([inspect(items)])[0]
  assert.equal(source.eligible, true)
  assert.deepEqual(source.seasons[0].present, [{ start: 3, end: 6 }, { start: 9, end: 9 }])
  assert.deepEqual(source.seasons[0].gaps, [{ start: 7, end: 8 }])
  assert.equal(source.seasons[0].count, 5)
  assert.equal(source.seasons[0].missingCount, 2)
  assert.equal(source.seasons[0].start, 3)
  assert.equal(source.seasons[0].end, 9)
  assert.deepEqual(compareEpisodeSources([inspect(episodes([4, 5]))])[0].seasons[0].gaps, [])
})

test('特别篇、零号集和虚拟条目不充当正片收录，也不触发标题季号冲突', () => {
  const items = episodes([1, 3])
  items.push(...[
    rawEpisode(2, { IsVirtualItem: true }), rawEpisode(100, { ParentIndexNumber: 0 }),
    rawEpisode(0), rawEpisode(9, { LocationType: 'Virtual' }), rawEpisode(10, { IsMissing: true })
  ].map(item => normalizeItem(item, 'a')))
  const source = compareEpisodeSources([inspect(items, series('a', {}, '模拟剧 第1季'))])[0]
  assert.equal(source.eligible, true)
  assert.equal(source.excluded, 5)
  assert.deepEqual(source.seasons[0].gaps, [{ start: 2, end: 2 }])
})

test('旧缓存、无完整快照、失败、过期、坏编号及季号冲突必须保留待确认', () => {
  const legacy = episodes([1, 3]); delete legacy[0].episodeNumberingVersion
  for (const source of [
    inspect(legacy), inspect(episodes([1, 3]), series(), { available: false }),
    inspect(episodes([1, 3]), series(), { error: '读取失败' }),
    inspect(episodes([1, 3]), series(), { stale: true }),
    inspect([...episodes([1, 3]), normalizeItem(rawEpisode(2, { ParentIndexNumber: null }), 'a')]),
    inspect([normalizeItem(rawEpisode(2, { IndexNumberEnd: '4' }), 'a')]),
    inspect([normalizeItem(rawEpisode(2, { IndexNumberEnd: 1 }), 'a')]),
    inspect([normalizeItem(rawEpisode(10001), 'a')]),
    inspect(episodes([1, 3]), series('a', {}, '模拟剧 第2季')), inspect([])
  ]) {
    compareEpisodeSources([source])
    assert.equal(source.eligible, false)
    assert.ok(source.reasons.length)
    assert.ok(source.seasons.every(season => season.gaps.length === 0))
  }
})

test('同季来源可互补，过期来源和不同季不参与对照，服务器内部 ID 保持隔离', () => {
  const a = inspect(episodes([1, 3]))
  const b = inspect(episodes([2, 3, 4], 'b'), series('b'))
  const stale = inspect(episodes([99], 'c'), series('c'), { stale: true })
  const otherSeason = inspect([normalizeItem(rawEpisode(20, { ParentIndexNumber: 2 }), 'd')], series('d'))
  compareEpisodeSources([a, b, stale, otherSeason])
  assert.deepEqual(a.seasons[0].gaps, [{ start: 2, end: 2 }, { start: 4, end: 4 }])
  assert.deepEqual(a.seasons[0].alternatives, [{ serverId: 'b', seriesId: 'series', serverName: '来源 b', ranges: [{ start: 2, end: 2 }, { start: 4, end: 4 }] }])
  assert.deepEqual(b.seasons[0].gaps, [{ start: 1, end: 1 }])
  assert.equal(otherSeason.seasons[0].missingCount, 0)
})

async function fixture(t, client = { episodes: async () => [rawEpisode(1), rawEpisode(3)] }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'embyscope-episodes-'))
  const app = createApp({ dataDir, scheduler: false, client, desktopKey: 'fixture' })
  for (const id of ['a', 'b']) {
    app.store.db.prepare('INSERT INTO servers(id,name,url,secret,status) VALUES(?,?,?,?,?)').run(id, `来源 ${id}`, `http://${id}.invalid`, app.store.encrypt({ token: 'private-token', userId: 'private-user' }), 'online')
    app.store.saveCache(id, 'catalog', [series(id)])
    app.store.saveCache(id, 'catalogInfo', { mode: 'seasons' })
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'x-embyscope-desktop': 'fixture', 'x-embyscope': '1', 'content-type': 'application/json' }
  async function request(path, method = 'GET', body, extra = {}) {
    const response = await fetch(origin + path, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }) })
  return { app, request }
}

test('缺集列表只读缓存，季数量不推算编号，精确关联后按服务器范围对照', async t => {
  const { app, request } = await fixture(t, { episodes: () => { throw new Error('禁止外联') } })
  app.store.saveCache('a', 'seasons:series', [{ episode: 1, episodeCount: 30 }])
  let result = await request('/api/episode-audit')
  assert.equal(result.status, 200)
  assert.equal(result.data.counts.unknown, 1)
  assert.ok(result.data.items[0].sources.every(source => !source.eligible))
  app.store.saveCache('a', 'episodes:series', episodes([1, 3]))
  app.store.saveCache('b', 'episodes:series', episodes([1, 2, 3, 4], 'b'))
  result = await request('/api/episode-audit?state=gaps')
  assert.equal(result.data.total, 1)
  assert.equal(result.data.items[0].sources[0].seasons[0].missingCount, 2)
  const single = (await request('/api/episode-audit?server=a')).data
  assert.equal(single.items[0].sources.length, 1)
  assert.deepEqual(single.items[0].sources[0].seasons[0].gaps, [{ start: 2, end: 2 }])
  assert.equal((await request('/api/episode-audit?q=不存在')).data.total, 0)
  assert.equal((await request('/api/episode-audit?state=invalid')).status, 400)
  assert.doesNotMatch(JSON.stringify(result.data), /private-token|private-user|\.invalid/)
})

test('同名不同编号和有冲突的桥接编号不会给出跨来源互补', async t => {
  const { app } = await fixture(t)
  app.store.saveCache('a', 'catalog', [series('a', { Tmdb: '12', Imdb: 'tt11' })])
  app.store.saveCache('b', 'catalog', [series('b', { Tmdb: '12', Imdb: 'tt22' })])
  app.store.saveCache('a', 'episodes:series', episodes([1, 3]))
  app.store.saveCache('b', 'episodes:series', episodes([2], 'b'))
  let result = episodeAudit(app.service, new URLSearchParams())
  assert.equal(result.items.length, 2)
  assert.ok(result.items.every(item => item.conflict && item.sources.length === 1))
  assert.ok(result.items.every(item => item.sources[0].seasons[0].alternatives.length === 0))
  app.store.saveCache('b', 'catalog', [series('b', { Tmdb: '13' })])
  result = episodeAudit(app.service, new URLSearchParams())
  assert.equal(result.items.length, 2)
})

test('按需单剧读取异步返回、任务互斥、完成更新检查，重复读取受冷却限制', async t => {
  let release, calls = 0
  const { app, request } = await fixture(t, { episodes: async row => {
    calls++
    assert.equal(row.id, 'a')
    assert.equal(row.canRequest(), true)
    await new Promise(resolve => { release = resolve })
    return [rawEpisode(1), rawEpisode(3)]
  } })
  const body = { serverId: 'a', seriesId: 'series' }
  assert.equal((await request('/api/episode-audit/refresh', 'POST', body)).status, 202)
  assert.equal((await request('/api/episode-audit')).data.running, true)
  assert.equal((await request('/api/episode-audit/refresh', 'POST', body)).status, 202)
  assert.equal(calls, 1)
  release(); await app.service.drain()
  const result = (await request('/api/episode-audit')).data
  assert.equal(result.running, false)
  assert.equal(result.counts.gaps, 1)
  assert.equal((await request('/api/episode-audit/refresh', 'POST', body)).status, 409)
  assert.equal(calls, 1)
})

test('失败保留旧单集和成功时间，失败不能被普通片库快照掩盖', async t => {
  const { app, request } = await fixture(t, { episodes: async () => { throw new RemoteError('分页不完整', 502) } })
  app.store.saveCache('a', 'catalogInfo', { mode: 'recursive' })
  app.store.saveCache('a', 'catalog', [series(), ...episodes([1, 2, 3])])
  app.store.saveCache('a', 'episodes:series', episodes([1, 3]))
  const before = app.store.cache('a', 'episodes:series')
  await request('/api/episode-audit/refresh', 'POST', { serverId: 'a', seriesId: 'series' })
  await app.service.drain()
  const after = app.store.cache('a', 'episodes:series')
  assert.equal(after.updatedAt, before.updatedAt)
  assert.deepEqual(after.data, before.data)
  const result = episodeAudit(app.service, new URLSearchParams({ server: 'a' }))
  assert.equal(result.items[0].state, 'unknown')
  assert.equal(result.items[0].sources[0].error, '分页不完整')
})

test('缺集 API 保留认证、来源与离线保护，拒绝电影及不存在条目', async t => {
  let calls = 0
  const { app, request } = await fixture(t, { episodes: async () => { calls++; return [] } })
  const body = { serverId: 'a', seriesId: 'series' }
  assert.equal((await request('/api/episode-audit', 'GET', undefined, { 'x-embyscope-desktop': '' })).status, 403)
  assert.equal((await request('/api/episode-audit/refresh', 'POST', body, { origin: 'https://example.com' })).status, 403)
  assert.equal((await request('/api/episode-audit/refresh', 'POST', { serverId: 'a', seriesId: 'missing' })).status, 404)
  app.store.saveCache('b', 'catalog', [normalizeItem({ Id: 'film', Type: 'Movie' }, 'b')])
  assert.equal((await request('/api/episode-audit/refresh', 'POST', { serverId: 'b', seriesId: 'film' })).status, 400)
  app.service.offline = true
  assert.equal((await request('/api/episode-audit')).status, 200)
  assert.equal((await request('/api/episode-audit/refresh', 'POST', body)).status, 409)
  assert.equal(calls, 0)
})

test('读取期间连接变更或应用退出，旧结果不回写', async t => {
  let release, currentRow
  const { app } = await fixture(t, { episodes: async row => {
    currentRow = row
    await new Promise(resolve => { release = resolve })
    return [rawEpisode(1)]
  } })
  const job = app.service.readEpisodes('a', 'series', true)
  const joined = app.service.readEpisodes('a', 'series', true)
  app.store.db.prepare('UPDATE servers SET revision=revision+1 WHERE id=?').run('a')
  assert.equal(currentRow.canRequest(), false)
  release()
  await assert.rejects(job, /连接已变更/)
  await assert.rejects(joined, /连接已变更/)
  assert.equal(app.store.cache('a', 'episodes:series'), null)
  const stopping = app.service.readEpisodes('a', 'series', true)
  app.service.stopping = true
  assert.equal(currentRow.canRequest(), false)
  release(); await stopping
  assert.equal(app.store.cache('a', 'episodes:series'), null)
})

test('授权失效时不发单集请求，沿用原有缓存失效保护', async t => {
  let calls = 0
  const { app } = await fixture(t, { episodes: async () => { calls++; return [] } })
  app.store.db.prepare('UPDATE servers SET secret=? WHERE id=?').run(app.store.encrypt({}), 'a')
  await assert.rejects(app.service.readEpisodes('a', 'series', true), /连接已变更/)
  assert.equal(calls, 0)
  assert.equal(app.store.server('a').status, 'denied')
  assert.equal(app.store.cache('a', 'catalog'), null)
})

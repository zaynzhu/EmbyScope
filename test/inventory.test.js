import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'
import { EmbyClient } from '../src/emby.js'
import { SyncHistory } from '../src/sync-history.js'
import { mockEmby } from './fixtures.js'

async function fixture(t, compatible = false) {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-inventory-'))
  const remote = await mockEmby('A', { limitedCatalog: compatible })
  const app = createApp({ dataDir: directory, scheduler: false, desktopKey: 'a'.repeat(64), client: new EmbyClient({ interval: 1, retries: 0 }) })
  t.after(async () => { await app.close(); await remote.close(); rmSync(directory, { recursive: true, force: true }) })
  const server = app.service.saveServer({ name: '测试服务器', url: remote.url, username: 'fixture-user', password: 'fixture-pass' })
  await app.service.drain()
  const runs = () => app.service.history.list(app.store.servers()).items
  return { ...app, remote, id: server.id, runs }
}

test('同步历史覆盖连接初始化、手动轻量、部分完成和失败，不增加原请求', async t => {
  const f = await fixture(t)
  assert.equal(f.runs()[0].trigger, 'connection')
  assert.equal(f.runs()[0].mode, 'full')
  assert.equal(f.runs()[0].state, 'completed')
  assert.deepEqual(f.runs()[0].steps.map(s => s.kind), ['catalog', 'views', 'latest', 'resume'])
  const before = f.remote.calls.length
  await f.service.refresh(f.id, { full: false })
  assert.equal(f.remote.calls.length - before, 3)
  assert.equal(f.runs()[0].mode, 'light')
  assert.equal(f.runs()[0].trigger, 'manual')
  f.remote.state.denied.add('/Users/same-user-id/Views')
  await f.service.refresh(f.id, { full: false })
  assert.equal(f.runs()[0].state, 'partial')
  assert.match(f.runs()[0].steps[0].error, /403/)
  f.remote.state.offline = true
  await f.service.refresh(f.id, { full: false })
  assert.equal(f.runs()[0].state, 'failed')
  const output = JSON.stringify(f.runs())
  for (const secret of ['fixture-user', 'fixture-pass', 'secret-token', 'same-user-id', f.remote.url]) assert.ok(!output.includes(secret))
})

test('自动任务暂停、重复刷新及离线不产生虚假成功，启动恢复未完成历史', async t => {
  const f = await fixture(t)
  f.service.updateSettings({ automaticUpdates: true })
  const request = f.service.client.request.bind(f.service.client)
  f.service.client.request = async (...args) => {
    const result = await request(...args)
    if (args[1].endsWith('/Views')) f.service.updateSettings({ automaticUpdates: false })
    return result
  }
  const before = f.runs().length
  const job = f.service.refresh(f.id, { full: false, automatic: true })
  assert.equal(f.service.refresh(f.id, { full: false }), job)
  await job
  assert.equal(f.runs().length, before + 1)
  assert.equal(f.runs()[0].state, 'cancelled')
  assert.equal(f.runs()[0].trigger, 'automatic')
  f.service.offline = true
  await f.service.refresh(f.id)
  assert.equal(f.runs().length, before + 1)
  f.store.db.prepare("INSERT INTO sync_runs(serverId,mode,trigger,startedAt,state,steps) VALUES(?,'full','manual',?,'running','[]')").run(f.id, new Date().toISOString())
  const history = new SyncHistory(f.store)
  assert.equal(history.list(f.store.servers()).items[0].state, 'interrupted')
})

test('季集补齐单独记录每部读取结果，凭据失效不会错误标成连接变更', async t => {
  const f = await fixture(t, true)
  f.service.updateSettings({ automaticUpdates: true })
  f.service.startSeasonSync(f.store.server(f.id))
  await f.service.drain()
  const seasons = f.runs().find(r => r.mode === 'seasons')
  assert.equal(seasons.state, 'completed')
  assert.equal(seasons.steps.length, 2)
  f.remote.state.denied.add('all')
  await f.service.refresh(f.id, { full: false })
  assert.equal(f.runs()[0].state, 'failed')
})

test('历史记录写入失败不改变原同步结果，删除连接同步移除对应记录', async t => {
  const f = await fixture(t)
  f.store.db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON sync_runs BEGIN SELECT RAISE(FAIL,'fixture'); END")
  const before = f.runs().length
  await f.service.refresh(f.id, { full: false })
  assert.equal(f.store.server(f.id).status, 'online')
  assert.equal(f.runs().length, before)
  assert.equal(f.service.history.available, false)
  f.service.deleteServer(f.id)
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sync_runs').get().n, 0)
})

test('问题计数与原筛选逐项一致，未知不补零，接口认证与离线读取不联网', async t => {
  const f = await fixture(t)
  const summary = f.service.inventory('all')
  for (const filter of ['resources', 'metadata', 'unknown']) {
    assert.equal(summary.counts[filter], f.service.library(new URLSearchParams({ duplicates: 'true', review: filter })).total)
  }
  const original = f.store.cache(f.id, 'catalog').data
  f.store.db.prepare("DELETE FROM cache WHERE serverId=? AND kind='catalog'").run(f.id)
  assert.equal(f.service.inventory(f.id).counts.resources, null)
  f.store.saveCache(f.id, 'catalog', [])
  assert.equal(f.service.inventory(f.id).counts.resources, 0)
  f.store.saveCache(f.id, 'catalog', original)
  f.service.offline = true
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${f.server.address().port}`
  const calls = f.remote.calls.length
  for (const path of ['/api/inventory', '/api/sync-history']) {
    assert.equal((await fetch(base + path)).status, 403)
    const response = await fetch(base + path, { headers: { 'X-EmbyScope-Desktop': 'a'.repeat(64) } })
    assert.equal(response.status, 200)
  }
  assert.equal(f.remote.calls.length, calls)
  assert.throws(() => f.service.inventory('missing'), /连接不存在/)
})

test('记录展示与存储有界，按服务器筛选且任务变更不写入旧缓存', async t => {
  const f = await fixture(t)
  const row = f.store.server(f.id)
  for (let i = 0; i < 2005; i++) f.store.db.prepare("INSERT INTO sync_runs(serverId,mode,trigger,startedAt,state,steps) VALUES(?,'light','manual',?,'completed','[]')").run(f.id, new Date().toISOString())
  await f.service.refresh(f.id, { full: false })
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sync_runs').get().n, 2000)
  assert.equal(f.runs().length, 100)
  assert.equal(f.service.history.list([]).items.length, 0)
  await f.service.history.track(f.service, row, 'light', 'manual', async () => {
    f.store.db.prepare('UPDATE servers SET revision=revision+1 WHERE id=?').run(f.id)
  })
  assert.equal(f.runs()[0].state, 'superseded')
})

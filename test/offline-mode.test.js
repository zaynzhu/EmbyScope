import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'
import { exitOfflinePreview } from '../desktop/backend/offline-mode.js'
import { seedDemo } from '../desktop/backend/demo.js'

async function fixture(t, { canExit = true, brokenMarker = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-mode-'))
  const marker = join(root, 'offline-preview')
  if (brokenMarker) mkdirSync(marker)
  else writeFileSync(marker, '离线预览', { mode: 0o600 })
  const calls = []
  const client = {
    login: async () => assert.fail('模式切换不应登录'),
    catalog: async () => assert.fail('不应完整扫库'),
    request: async (row, path) => {
      calls.push({ id: row.id, path })
      if (path.includes('/Latest?')) return []
      return { Items: [] }
    }
  }
  const app = createApp({ dataDir: root, offline: true, client, desktopKey: 'fixture-desktop-key',
    onExitOffline: canExit ? store => exitOfflinePreview(store, root) : undefined })
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
  app.store.db.prepare("INSERT INTO settings VALUES('desktopPasswordRequired','true')").run()
  seedDemo(app.store)
  for (const row of app.store.servers()) {
    app.store.db.prepare('UPDATE servers SET fullHours=0,attemptedAt=NULL,secret=? WHERE id=?')
      .run(app.store.encrypt({ token: 'fixture-token', userId: 'fixture-user' }), row.id)
  }
  app.store.db.exec("UPDATE settings SET value='true' WHERE name='automaticUpdates'")
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-EmbyScope-Desktop': 'fixture-desktop-key', 'X-EmbyScope': '1', 'Content-Type': 'application/json' }
  const request = async (path, body, extra = {}) => {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
  }
  const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ password: 'fixture-local-password' }) })
  headers.Cookie = setup.headers.get('set-cookie').split(';')[0]
  return { app, root, marker, calls, request, origin, headers }
}

test('启用密码锁时退出离线需要管理员和来源校验，明确确认后持久化，自动更新关闭且不联网', async t => {
  const f = await fixture(t)
  const before = f.app.store.db.prepare('SELECT * FROM cache').all()
  const endpoint = '/api/settings/exit-offline'
  assert.equal((await f.request('/api/settings')).data.canExitOffline, true)
  assert.equal((await f.request(endpoint, { confirm: true }, { Cookie: '' })).status, 401)
  assert.equal((await f.request(endpoint, { confirm: true }, { Origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await f.request(endpoint, { confirm: true }, { 'X-EmbyScope-Desktop': '' })).status, 403)
  assert.equal((await f.request(endpoint, {})).status, 400)
  assert.equal((await f.request('/api/refresh', { mode: 'light' })).status, 409)
  const result = await f.request(endpoint, { confirm: true })
  assert.equal(result.status, 200)
  assert.deepEqual(result.data, { offline: false, automaticUpdates: false, canExitOffline: false })
  assert.equal(existsSync(f.marker), false)
  assert.equal(f.app.store.db.prepare("SELECT value FROM settings WHERE name='automaticUpdates'").get().value, 'false')
  f.app.service.tick()
  await f.app.service.drain()
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.app.store.db.prepare('SELECT * FROM cache').all(), before)
  assert.equal((await f.request('/api/refresh', { mode: 'light', server: 'all' })).status, 202)
  await f.app.service.drain()
  assert.equal(f.calls.length, 6)
  assert.ok(f.calls.every(call => /\/Views$|\/Items\/(Latest|Resume)\?/.test(call.path)))
  assert.equal(f.app.store.servers().length, 2)
})

test('退出不重复关闭后来启用的自动更新，调度使用当前模式而非启动时状态', async t => {
  const f = await fixture(t)
  await f.request('/api/settings/exit-offline', { confirm: true })
  const enabled = await fetch(f.origin + '/api/settings', { method: 'PUT', headers: f.headers, body: JSON.stringify({ automaticUpdates: true }) })
  assert.equal(enabled.status, 200)
  assert.equal((await f.request('/api/settings/exit-offline', { confirm: true })).data.automaticUpdates, true)
  f.app.service.tick()
  await f.app.service.drain()
  assert.equal(f.calls.length, 6)
})

test('强制离线不能绕过；持久化失败继续离线并暂停调度', async t => {
  for (const options of [{ canExit: false }, { brokenMarker: true }]) {
    const f = await fixture(t, options)
    assert.equal((await f.request('/api/settings/exit-offline', { confirm: true })).status, 409)
    assert.equal(f.app.service.offline, true)
    assert.equal(existsSync(f.marker), true)
    f.app.service.tick()
    assert.equal(f.calls.length, 0)
  }
})

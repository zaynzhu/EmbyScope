import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'

async function fixture(t, desktop = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'embyscope-lock-'))
  const key = 'a'.repeat(64)
  let app
  let base
  let cookie = ''
  const start = async () => {
    app = createApp({ dataDir, desktopKey: desktop ? key : undefined, offline: true, scheduler: false })
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${app.server.address().port}`
    cookie = ''
  }
  await start()
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }) })
  return {
    get app() { return app },
    async restart() { await app.close(); await start() },
    async request(path, method = 'GET', body, overrides = {}) {
      const headers = { 'X-EmbyScope-Desktop': key, 'X-EmbyScope': '1', 'Content-Type': 'application/json', Cookie: cookie, ...overrides }
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
      return { status: response.status, data: await response.json() }
    }
  }
}

test('桌面默认免密码但保留启动密钥与跨站保护；密码开关重启持久化且离线可配置', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.request('/api/auth/status')).data, { initialized: false, authenticated: true, passwordRequired: false })
  assert.equal((await f.request('/api/servers')).status, 200)
  assert.equal((await f.request('/api/servers', 'GET', undefined, { 'X-EmbyScope-Desktop': '' })).status, 403)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: false }, { Origin: 'https://evil.invalid' })).status, 403)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: 'false' })).status, 400)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password: 'short' })).status, 400)
  const password = 'fixture-local-password'
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password })).status, 200)
  const hash = f.app.store.db.prepare('SELECT hash FROM admin').get().hash
  assert.ok(!hash.includes(password))
  await f.restart()
  assert.equal((await f.request('/api/auth/status')).data.passwordRequired, true)
  assert.equal((await f.request('/api/servers')).status, 401)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: false })).status, 401)
  assert.equal((await f.request('/api/auth/login', 'POST', { password })).status, 200)
  assert.equal((await f.request('/api/auth/logout', 'POST', {})).status, 200)
  assert.equal((await f.request('/api/servers')).status, 401)
  await f.request('/api/auth/login', 'POST', { password })
  await f.request('/api/auth/desktop-lock', 'PUT', { enabled: false })
  await f.restart()
  assert.equal((await f.request('/api/servers')).status, 200)
  assert.equal(f.app.store.db.prepare('SELECT hash FROM admin').get().hash, hash)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password: 'incorrect-password' })).status, 401)
  assert.equal((await f.request('/api/auth/status')).data.passwordRequired, false)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password })).status, 200)
})

test('旧桌面数据默认免密码但保留旧密码和加密密钥，开启仍需旧密码', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'existing-password' })
  const key = Buffer.from(f.app.store.key)
  await f.restart()
  assert.equal((await f.request('/api/auth/status')).data.initialized, true)
  assert.equal((await f.request('/api/auth/status')).data.authenticated, true)
  assert.deepEqual(f.app.store.key, key)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password: 'replacement-password' })).status, 401)
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password: 'existing-password' })).status, 200)
})

test('网页版不受桌面密码开关影响', async t => {
  const f = await fixture(t, false)
  f.app.store.db.prepare("INSERT INTO settings VALUES('desktopPasswordRequired','false')").run()
  assert.equal((await f.request('/api/servers')).status, 401)
  assert.equal((await f.request('/api/auth/status')).data.passwordRequired, true)
  await f.request('/api/auth/setup', 'POST', { password: 'web-fixture-password' })
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: false })).status, 404)
  await f.request('/api/auth/logout', 'POST', {})
  assert.equal((await f.request('/api/servers')).status, 401)
})

test('开启密码校验失败有限流，不因默认免密码绕过', async t => {
  const f = await fixture(t)
  await f.request('/api/auth/setup', 'POST', { password: 'existing-password' })
  for (let i = 0; i < 10; i++) {
    assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password: 'incorrect-password' })).status, 401)
  }
  assert.equal((await f.request('/api/auth/desktop-lock', 'PUT', { enabled: true, password: 'existing-password' })).status, 429)
})

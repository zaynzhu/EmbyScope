import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { createApp } from '../src/server.js'
import { seedDemo } from '../desktop/backend/demo.js'
import { copyDataDirectory } from '../desktop/backend/data-transfer.js'

test('一致性导入包含WAL，保留凭据与原库，清会话并暂停，拒绝覆盖和错误密钥', async t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-transfer-test-'))
  const source = join(root, 'source')
  const destination = join(root, 'desktop')
  const store = new Store(source)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  seedDemo(store)
  store.db.prepare('INSERT INTO sessions VALUES(?,?)').run('fixture-session', Date.now() + 10000)
  store.db.exec("UPDATE settings SET value='true' WHERE name='automaticUpdates'")
  assert.ok(existsSync(join(source, 'embyscope.sqlite-wal')))
  const key = readFileSync(join(source, 'secret.key'))
  const result = await copyDataDirectory(source, destination, { offlinePreview: true })
  assert.equal(result.entries, 80)
  const copied = new Store(destination)
  try {
    assert.equal(copied.servers().length, 2)
    assert.deepEqual(copied.decrypt(copied.servers()[0].secret), store.decrypt(store.servers()[0].secret))
    assert.equal(copied.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0)
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1)
    assert.equal(copied.db.prepare("SELECT value FROM settings WHERE name='automaticUpdates'").get().value, 'false')
    assert.equal(store.db.prepare("SELECT value FROM settings WHERE name='automaticUpdates'").get().value, 'true')
    assert.ok(existsSync(join(destination, 'offline-preview')))
    const backupResult = await copyDataDirectory(destination, join(root, 'offline-backup'))
    assert.equal(backupResult.offlinePreview, true)
    assert.ok(key.equals(readFileSync(join(source, 'secret.key'))))
    await assert.rejects(copyDataDirectory(source, destination))
    await assert.rejects(copyDataDirectory(source, join(source, 'nested')))
    writeFileSync(join(source, 'secret.key'), Buffer.alloc(32))
    await assert.rejects(copyDataDirectory(source, join(root, 'wrong-key')))
    assert.equal(existsSync(join(root, 'wrong-key')), false)
    writeFileSync(join(source, 'secret.key'), key)
  } finally { copied.close() }
})

test('强制离线下详情、过期资源、季集、海报、调度均不发请求，不清除旧缓存', async t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-offline-test-'))
  let remoteCalls = 0
  const forbidden = async () => {
    remoteCalls++
    throw new Error('不应联网')
  }
  const app = createApp({ dataDir: root, offline: true, client: { request: forbidden, login: forbidden, episodes: forbidden } })
  t.after(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  seedDemo(app.store)
  const server = app.store.servers()[0]
  app.store.saveCache(server.id, 'catalogInfo', { mode: 'seasons' })
  app.store.db.exec("UPDATE cache SET updatedAt='2000-01-01T00:00:00.000Z'; UPDATE settings SET value='true' WHERE name='automaticUpdates'")
  const before = app.store.db.prepare('SELECT * FROM cache').all()
  const detail = await app.service.readDetail(server.id, '2', new URLSearchParams())
  assert.equal(detail.id, '2')
  assert.equal((await app.service.readResources(server.id, '0')).locations.length, 1)
  await assert.rejects(app.service.poster(server.id, '0'), /离线预览/)
  await app.service.refresh(server.id)
  app.service.tick()
  assert.equal(app.service.settings().offline, true)
  assert.equal(app.service.settings().automaticUpdates, false)
  assert.equal(remoteCalls, 0)
  assert.deepEqual(app.store.db.prepare('SELECT * FROM cache').all(), before)
})

test('离线HTTP仍需管理员认证，阻止配置与刷新；备份恢复可再次离线导入', async t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-offline-http-'))
  const source = join(root, 'source')
  const app = createApp({ dataDir: source, offline: true, client: { request: () => assert.fail('不应联网') } })
  t.after(async () => {
    await app.close()
    rmSync(root, { recursive: true, force: true })
  })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const headers = { 'X-EmbyScope': '1', 'Content-Type': 'application/json' }
  assert.equal((await fetch(base + '/api/settings')).status, 401)
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers, body: JSON.stringify({ password: 'fixture-local-password' }) })
  assert.equal(setup.status, 200)
  headers.Cookie = setup.headers.get('set-cookie').split(';')[0]
  seedDemo(app.store)
  for (const [path, method, body] of [['/api/settings', 'PUT', { automaticUpdates: true }], ['/api/refresh', 'POST', { mode: 'full' }], ['/api/servers', 'POST', {}]]) {
    assert.equal((await fetch(base + path, { method, headers, body: JSON.stringify(body) })).status, 409)
  }
  const backup = join(root, 'backup')
  await copyDataDirectory(source, backup)
  await copyDataDirectory(backup, join(root, 'restored'), { offlinePreview: true })
  const restored = new Store(join(root, 'restored'))
  try {
    assert.equal(restored.servers().length, 2)
    assert.deepEqual(restored.cache(restored.servers()[0].id, 'catalog').data, app.store.cache(app.store.servers()[0].id, 'catalog').data)
    assert.ok(existsSync(join(root, 'restored', 'offline-preview')))
  } finally { restored.close() }
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers, body: '{}' })).status, 200)
  assert.equal((await fetch(base + '/api/settings', { headers })).status, 401)
})

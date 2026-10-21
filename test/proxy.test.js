import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { Service } from '../src/service.js'
import { seedDemo } from '../desktop/backend/demo.js'

test('反代作为同一连接的附属地址，改动不增加连接、不清缓存、不发请求', t => {
  const root = mkdtempSync(join(tmpdir(), 'embyscope-proxy-'))
  const store = new Store(root)
  t.after(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  seedDemo(store)
  const service = new Service(store, {})
  service.refresh = () => assert.fail('反代配置不应触发同步')
  const [a, b] = store.servers()
  const caches = store.db.prepare('SELECT * FROM cache').all()
  const before = service.overview('all').stats
  const saved = service.saveServer({ name: a.name, url: a.url, proxyUrl: 'http://proxy.example:19000/' }, a.id)
  assert.equal(saved.id, a.id)
  assert.equal(saved.proxyUrl, 'http://proxy.example:19000')
  assert.equal(store.servers().length, 2)
  assert.equal(store.server(a.id).revision, a.revision)
  assert.deepEqual(store.decrypt(store.server(a.id).secret), store.decrypt(a.secret))
  assert.deepEqual(store.db.prepare('SELECT * FROM cache').all(), caches)
  assert.deepEqual(service.overview('all').stats, before)
  service.saveServer({ name: a.name, url: a.url, lightMinutes: 120 }, a.id)
  assert.equal(store.server(a.id).proxyUrl, saved.proxyUrl)
  assert.throws(() => service.saveServer({ name: b.name, url: saved.proxyUrl }, b.id), /地址/)
  assert.throws(() => service.saveServer({ name: b.name, url: b.url, proxyUrl: saved.proxyUrl }, b.id), /地址/)
  for (const proxyUrl of [a.url, b.url, 'http://u:p@example.test', 'http://example.test?api_key=fixture', 'file:///tmp/x', 19000]) {
    assert.throws(() => service.saveServer({ name: a.name, url: a.url, proxyUrl }, a.id))
  }
  service.saveServer({ name: a.name, url: a.url, proxyUrl: '' }, a.id)
  assert.equal(store.server(a.id).proxyUrl, null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

test('旧数据库增量迁移标签和周期字段，凭据缓存保留，设置在重启后持久化', t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-migrate-'))
  let store = new Store(directory)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const secret = store.encrypt({ username: 'fixture-user', password: 'fixture-password' })
  store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)').run('fixture-id', '模拟', 'http://example.test', secret)
  store.saveCache('fixture-id', 'catalog', [{ id: 'movie', type: 'Movie' }])
  store.db.exec('ALTER TABLE servers DROP COLUMN proxyUrl')
  store.db.exec('ALTER TABLE servers DROP COLUMN nsfw')
  store.db.exec('ALTER TABLE servers DROP COLUMN lightMinutes')
  store.db.exec('ALTER TABLE servers DROP COLUMN fullHours')
  store.db.exec('DROP TABLE settings')
  store.close()
  store = new Store(directory)
  assert.equal(store.server('fixture-id').proxyUrl, null)
  assert.equal(store.server('fixture-id').nsfw, 0)
  assert.equal(store.server('fixture-id').lightMinutes, 60)
  assert.equal(store.server('fixture-id').fullHours, 24)
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE name='automaticUpdates'").get().value, 'false')
  assert.deepEqual(store.decrypt(store.server('fixture-id').secret), { username: 'fixture-user', password: 'fixture-password' })
  assert.equal(store.cache('fixture-id', 'catalog').data.length, 1)
  store.db.prepare('UPDATE servers SET nsfw=1,lightMinutes=120,fullHours=0,proxyUrl='http://proxy.invalid:19000' WHERE id=?').run('fixture-id')
  store.close()
  store = new Store(directory)
  assert.equal(store.server('fixture-id').proxyUrl, 'http://proxy.invalid:19000')
  assert.equal(store.server('fixture-id').nsfw, 1)
  assert.equal(store.server('fixture-id').lightMinutes, 120)
  assert.equal(store.server('fixture-id').fullHours, 0)
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE name='automaticUpdates'").get().value, 'false')
})

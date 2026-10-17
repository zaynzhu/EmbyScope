import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

test('旧数据库增量迁移标签字段，凭据和缓存保留，标签在重启后持久化', t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-migrate-'))
  let store = new Store(directory)
  t.after(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const secret = store.encrypt({ username: 'fixture-user', password: 'fixture-password' })
  store.db.prepare('INSERT INTO servers(id,name,url,secret) VALUES(?,?,?,?)').run('fixture-id', '模拟', 'http://example.test', secret)
  store.saveCache('fixture-id', 'catalog', [{ id: 'movie', type: 'Movie' }])
  store.db.exec('ALTER TABLE servers DROP COLUMN nsfw')
  store.close()
  store = new Store(directory)
  assert.equal(store.server('fixture-id').nsfw, 0)
  assert.deepEqual(store.decrypt(store.server('fixture-id').secret), { username: 'fixture-user', password: 'fixture-password' })
  assert.equal(store.cache('fixture-id', 'catalog').data.length, 1)
  store.db.prepare('UPDATE servers SET nsfw=1 WHERE id=?').run('fixture-id')
  store.close()
  store = new Store(directory)
  assert.equal(store.server('fixture-id').nsfw, 1)
})

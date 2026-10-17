import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server.js'
import { mockEmby } from '../test/fixtures.js'

const directory = mkdtempSync(join(tmpdir(), 'embyscope-demo-'))
const a = await mockEmby('A')
const b = await mockEmby('B')
b.state.denied.add('/Users/same-user-id/Items/Resume')
const app = createApp({ dataDir: directory })
app.service.saveServer({ name: '模拟 · 家庭影院', url: a.url, username: 'fixture-user', password: 'fixture-pass' })
app.service.saveServer({ name: '模拟 · 云端收藏', url: b.url, username: 'fixture-user', password: 'fixture-pass' })
app.server.listen(Number(process.env.PORT) || 3900, '127.0.0.1', () => console.log('模拟演示已启动：http://127.0.0.1:3900；首次打开设置临时管理员密码；退出后删除全部演示数据。'))
async function close() {
  await app.close()
  await Promise.all([a.close(), b.close()])
  rmSync(directory, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGINT', close)
process.once('SIGTERM', close)

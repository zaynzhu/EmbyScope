import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createApp } from '../../src/server.js'
import { RemoteError } from '../../src/emby.js'
import { seedDemo } from './demo.js'

process.umask(0o077)
// 启动凭据只走匿名管道，不放入命令行、环境变量或落盘。
const lines = createInterface({ input: process.stdin })
const line = await new Promise(resolve => {
  lines.once('line', resolve)
  lines.once('close', () => resolve(''))
})
let config
try { config = JSON.parse(line) } catch { process.exit(1) }
if (!config || !/^[a-f0-9]{64}$/.test(config.key) || typeof config.dataDir !== 'string') process.exit(1)
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
const lock = join(config.dataDir, 'desktop.lock')
try {
  if (readFileSync(lock, 'utf8')) {
    const pid = Number(readFileSync(lock, 'utf8'))
    if (!Number.isInteger(pid) || pid < 1) process.exit(1)
    try {
      process.kill(pid, 0)
      process.exit(1)
    } catch (error) { if (error.code !== 'ESRCH') process.exit(1) }
    unlinkSync(lock)
  }
} catch (error) { if (error.code !== 'ENOENT') process.exit(1) }
try {
  const fd = openSync(lock, 'wx', 0o600)
  writeFileSync(fd, String(process.pid))
  closeSync(fd)
} catch { process.exit(1) }
const demoClient = { request: async () => { throw new RemoteError('演示模式不访问外部服务', 403) }, login: async () => { throw new RemoteError('演示模式不连接服务器', 403) } }
const app = createApp({ dataDir: config.dataDir, desktopKey: config.key, scheduler: !config.demo, client: config.demo ? demoClient : undefined, secureCookie: false })
if (config.demo) seedDemo(app.store, config.artwork)
let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await app.close()
  try { unlinkSync(lock) } catch {}
  process.exit(0)
}
lines.on('close', shutdown)
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
// 这里只输出监听端口，绝不输出启动密钥或用户凭据。
process.stdout.write(JSON.stringify({ port: app.server.address().port }) + '\n')

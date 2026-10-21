import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

test('桌面内核连续20次启动退出，保持SQLite与密钥、模拟两服和认证边界', { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-lifecycle-'))
  let child
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      child = spawn(process.execPath, ['desktop/backend/main.js'], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' } })
      const exited = once(child, 'exit')
      const key = randomBytes(32).toString('hex')
      child.stdin.write(JSON.stringify({ key, dataDir: directory, demo: true }) + '\n')
      const [output] = await once(child.stdout, 'data')
      const { port } = JSON.parse(output)
      assert.ok(port > 0)
      const base = `http://127.0.0.1:${port}`
      const headers = { 'X-EmbyScope-Desktop': key, 'X-EmbyScope': '1', 'Content-Type': 'application/json' }
      const response = await fetch(`${base}/api/auth/${cycle ? 'login' : 'setup'}`, { method: 'POST', headers, body: JSON.stringify({ password: 'lifecycle-fixture-password' }) })
      assert.equal(response.status, 200)
      headers.Cookie = response.headers.get('set-cookie').split(';')[0]
      const home = await (await fetch(base + '/api/home', { headers })).json()
      assert.equal(new Set(home.recent.map(item => item.serverId)).size, 2)
      const library = await (await fetch(base + '/api/library?page=2', { headers })).json()
      assert.equal(library.page, 2)
      // 40 个作品中，编号冲突和缺编号各额外保留一条，合计 42 组。
      assert.equal(library.total, 42)
      assert.equal(library.items.length, 18)
      assert.equal((await fetch(base + '/api/library')).status, 403)
      child.stdin.end()
      assert.equal((await exited)[0], 0)
      assert.equal(existsSync(join(directory, 'desktop.lock')), false)
      assert.equal(existsSync(join(directory, 'secret.key')), true)
    }
  } finally {
    if (child && child.exitCode === null) {
      const ended = once(child, 'exit')
      child.kill('SIGTERM')
      await ended
    }
    rmSync(directory, { recursive: true, force: true })
  }
})

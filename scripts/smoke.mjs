import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

const origin = process.env.SMOKE_URL || 'http://127.0.0.1:33000'
const mode = process.argv[2] || 'setup'
let ready = false
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2000) })
    if (response.ok) {
      ready = true
      break
    }
  } catch { /* 等待本次临时容器就绪。 */ }
  await sleep(2000)
}
assert.ok(ready, '应用未就绪')
const initial = await (await fetch(`${origin}/api/auth/status`)).json()
assert.equal(initial.initialized, mode !== 'setup')
const response = await fetch(`${origin}/api/auth/${mode === 'setup' ? 'setup' : 'login'}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EmbyScope': '1' },
  body: JSON.stringify({ password: 'temporary-ci-only-password' })
})
assert.equal(response.status, 200)
const cookie = response.headers.get('set-cookie').split(';')[0]
const overview = await fetch(`${origin}/api/overview`, { headers: { Cookie: cookie } })
assert.equal(overview.status, 200)
const data = await overview.json()
assert.equal(data.stats.movies, null)
assert.deepEqual(data.servers, [])
const page = await fetch(origin)
assert.match(await page.text(), /映览/)
const script = await fetch(`${origin}/app.js`)
assert.equal(script.status, 200)
assert.match(script.headers.get('content-type'), /javascript/)
console.log(`容器验收通过：${mode === 'setup' ? '初始化、鉴权、页面与 API' : '重启后管理员与数据目录持久化'}`)

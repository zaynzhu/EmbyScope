import test from 'node:test'
import assert from 'node:assert/strict'
import { createProbe } from '../scripts/ttd-probe.mjs'

test('隔离诊断只记录认证位置和字段名，不记录凭据值，不转发或修改媒体', async t => {
  const probe = createProbe()
  await new Promise(resolve => probe.server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => probe.server.close(resolve)))
  const base = `http://127.0.0.1:${probe.server.address().port}`
  assert.equal((await fetch(`${base}/System/Info?api_key=${probe.probeKey}`)).status, 200)
  assert.equal((await fetch(`${base}/System/Info`, { headers: { 'X-Emby-Token': probe.probeKey } })).status, 200)
  assert.equal((await fetch(`${base}/System/Info?api_key=private-value`, { headers: { Cookie: 'private-cookie' } })).status, 403)
  assert.equal((await fetch(`${base}/Items/1`, { method: 'DELETE' })).status, 405)
  const result = await (await fetch(`${base}/__probe/evidence`)).json()
  assert.deepEqual(result.events[0].queryKeys, ['api_key'])
  assert.equal(result.events[0].fakeCredentialMatched, true)
  assert.equal(result.events[1].tokenHeaderPresent, true)
  assert.ok(!JSON.stringify(result).includes('private-value'))
  assert.ok(!JSON.stringify(result).includes('private-cookie'))
  assert.ok(!JSON.stringify(result).includes(probe.probeKey))
})

test('诊断器可只模拟上游404，证据接口仍能读取实际请求路径', async t => {
  const probe = createProbe({ upstreamStatus: 404 })
  await new Promise(resolve => probe.server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => probe.server.close(resolve)))
  const base = `http://127.0.0.1:${probe.server.address().port}`
  assert.equal((await fetch(`${base}/Users`, { headers: { 'X-Emby-Token': probe.probeKey } })).status, 404)
  const evidence = await (await fetch(`${base}/__probe/evidence`)).json()
  assert.equal(evidence.events[0].path, '/Users')
  assert.equal(evidence.events[0].fakeCredentialMatched, true)
})

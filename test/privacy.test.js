import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('汇总任一来源为 NSFW 就遮挡，单张解锁按服务器隔离，详情使用相同规则', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = source.indexOf('function sensitive(')
  const end = source.indexOf('function mediaCards(')
  const context = vm.createContext({ state: { servers: [], blurNsfw: true, revealed: new Set() }, e: String, itemPath: item => `/api/items/${item.serverId}/${item.id}` })
  vm.runInContext(source.slice(start, end), context)
  const item = { id: 'same', serverId: 'safe', title: '模拟', imageTag: 'tag', sources: [{ serverId: 'safe', nsfw: false }, { serverId: 'adult', nsfw: true }] }
  assert.match(context.posterButton(item), /class="poster blurred"/)
  context.state.revealed.add('adult:same')
  assert.match(context.posterButton(item), /class="poster blurred"/)
  context.state.revealed.add('safe:same')
  assert.doesNotMatch(context.posterButton(item), /class="poster blurred"/)
  context.state.revealed.clear()
  context.state.blurNsfw = false
  assert.doesNotMatch(context.posterButton(item), /class="poster blurred"/)
  context.state.blurNsfw = true
  assert.match(context.posterButton({ ...item, nsfw: true, sources: undefined }, true), /class="poster blurred"/)
  assert.doesNotMatch(context.posterButton({ ...item, nsfw: false, sources: undefined }), /class="poster blurred"/)
})

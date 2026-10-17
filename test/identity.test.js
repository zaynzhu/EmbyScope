import test from 'node:test'
import assert from 'node:assert/strict'
import { groupWorks, normalizeItem } from '../src/identity.js'
import { sampleMovie } from './fixtures.js'

const item = (id, ids, server = 's1', extra = {}) => normalizeItem(sampleMovie(id, ids, extra), server)

test('跨服相同编号合并，同名无编号独立，媒体类型隔离', () => {
  const result = groupWorks([
    item('1', { Tmdb: '10' }), item('1', { Tmdb: '10' }, 's2'),
    item('2', {}), item('2', {}, 's2'), item('3', { Tmdb: '10' }, 's1', { Type: 'Series' })
  ])
  assert.equal(result.length, 4)
  assert.equal(result[0].sources.length, 2)
  assert.notEqual(result[0].sources[0].key, result[0].sources[1].key)
})

test('直接和传递编号冲突全部保留，顺序不改变结果', () => {
  const values = [item('a', { Tmdb: '1', Imdb: 'tt2' }), item('b', { Tmdb: '1' }), item('c', { Imdb: 'tt2', Tmdb: '3' })]
  for (const input of [values, [...values].reverse(), [values[1], values[2], values[0]]]) {
    const result = groupWorks(input)
    assert.equal(result.length, 3)
    assert.ok(result.every(group => group.conflict && group.sources.length === 1))
  }
})

test('只保留合法编号与允许字段，不泄露资源路径或令牌', () => {
  const result = item('1', { Tmdb: '0', Imdb: 'TT123', Tvdb: 'n/a', Unknown: 'secret' }, 's1', { Path: '/secret', MediaSources: [{ Path: 'https://secret' }], AccessToken: 'secret', UserData: { PlayCount: 100 } })
  assert.deepEqual(result.providerIds, { imdb: 'tt123' })
  assert.equal(result.rating, 8.2)
  assert.equal(result.positionTicks, null)
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.ok(!('playCount' in result))
})

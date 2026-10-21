import test from 'node:test'
import assert from 'node:assert/strict'
import { comparisonGroups, matchesReview, scopeEvidence } from '../src/comparison.js'
import { normalizeItem, groupWorks } from '../src/identity.js'

const series = (id, title, server = 'a', ids = { Tmdb: '33880' }) => normalizeItem({ Id: id, Name: title, Type: 'Series', ProviderIds: ids }, server)

test('不同季不列为重复候选，同组两份第二季单独提示，作品统计不冒充资源统计', () => {
  const first = series('1', '科拉传奇 第 1 季')
  const second = series('2', '科拉传奇 第 2 季')
  const separate = comparisonGroups([first, second])[0]
  assert.deepEqual(separate.comparison.counts, { candidate: 0, distinct: 1, unknown: 0 })
  assert.equal(matchesReview(separate), false)
  assert.equal(matchesReview(separate, 'all'), true)
  assert.equal(separate.sources[0].scope.origin, 'title')
  const values = [first, second, series('2', '科拉传奇 第 2 季', 'b')]
  const mixed = comparisonGroups(values)[0]
  assert.deepEqual(mixed.comparison.counts, { candidate: 1, distinct: 2, unknown: 0 })
  assert.equal(mixed.comparison.hasMetadata, false)
  assert.equal(mixed.key, 'a:2')
  assert.equal(mixed.comparison.pairs.find(pair => pair.kind === 'candidate').leftKey, 'a:2')
  assert.equal(groupWorks(values).length, 1)
})

test('大组限量返回核对明细但优先保留重复候选，计数不截断', () => {
  const values = Array.from({ length: 22 }, (_, index) => series(String(index), `长剧 第 ${index + 1} 季`))
  values.push(series('copy', '长剧 第 22 季', 'b'))
  const result = comparisonGroups(values)[0]
  assert.equal(result.comparison.pairs.length, 200)
  assert.equal(result.comparison.truncated, true)
  assert.equal(result.comparison.counts.candidate, 1)
  assert.equal(result.comparison.counts.distinct, 252)
  assert.equal(result.comparison.pairs[0].kind, 'candidate')
  assert.equal(result.key, 'a:21')
})

test('缺季号不能默认第一季；中文和英文明确季号只作线索，年份不冒充季号', () => {
  const group = comparisonGroups([series('1', '谜探'), series('2', '谜探 第 2 季')])[0]
  assert.equal(group.comparison.counts.unknown, 1)
  assert.equal(matchesReview(group, 'resources'), false)
  assert.equal(matchesReview(group, 'unknown'), true)
  for (const title of ['谜探 第十二季', '谜探 Season 12', '谜探 S12']) assert.deepEqual(scopeEvidence(series('1', title)).seasons, [12])
  assert.deepEqual(scopeEvidence(series('1', '谜探 2026')).seasons, [])
  assert.deepEqual(scopeEvidence(series('1', '谜探 第一季')).seasons, [1])
})

test('按服务器及条目隔离季集缓存；标题与结构化季集不一致列元数据疑点', () => {
  const values = [series('1', '谜探 第一季'), series('1', '谜探 第二季', 'b')]
  const child = normalizeItem({ Id: 'ep', Type: 'Episode', SeriesId: '1', ParentIndexNumber: 2, IndexNumber: 1 }, 'a')
  const group = comparisonGroups(values, [child])[0]
  assert.equal(group.sources[0].scope.origin, 'cache')
  assert.equal(group.sources[0].scope.mismatch, true)
  assert.equal(group.sources[1].scope.origin, 'title')
  assert.equal(group.comparison.counts.candidate, 0)
  assert.equal(matchesReview(group, 'metadata'), true)
})

test('编号直接与传递冲突可排查但不归并、不推定重复，缺编号不凭同名连组', () => {
  const values = [series('1', '甲', 'a', { Tmdb: '1', Imdb: 'tt1' }), series('2', '甲', 'a', { Tmdb: '1' }), series('3', '甲', 'b', { Imdb: 'tt1', Tmdb: '2' })]
  for (const input of [values, [...values].reverse()]) {
    const result = comparisonGroups(input)[0]
    assert.equal(matchesReview(result, 'metadata'), true)
    assert.equal(result.comparison.counts.candidate, 0)
    assert.equal(result.sources.length, 3)
    assert.equal(groupWorks(input).length, 3)
  }
  assert.deepEqual(comparisonGroups([series('1', '甲', 'a', {}), series('2', '甲', 'b', {})]), [])
})

test('同编号不同标题或电影年份提示刮削核对而不是宣称出错；季年份差异不单独报警', () => {
  const a = normalizeItem({ Id: '1', Type: 'Movie', Name: '电影甲', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } }, 'a')
  const b = { ...a, id: '2', key: 'a:2', title: '电影乙', year: 2021 }
  const group = comparisonGroups([a, b])[0]
  assert.equal(group.comparison.reasons.length, 2)
  assert.equal(matchesReview(group, 'metadata'), true)
  assert.equal(matchesReview(group, 'resources'), true)
  const seasons = comparisonGroups([{ ...series('1', '甲 第一季'), year: 2020 }, { ...series('2', '甲 第二季'), year: 2021 }])[0]
  assert.equal(seasons.comparison.hasMetadata, false)
})

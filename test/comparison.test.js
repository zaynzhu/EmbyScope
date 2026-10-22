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

const movie = (id, title, year, providerIds = {}, serverId = 'a') => normalizeItem({ Id: id, Name: title, Type: 'Movie', ProductionYear: year, ProviderIds: providerIds }, serverId)
const locationCache = (path, extra = {}) => ({ data: { version: 2, locations: [{ path }] }, updatedAt: new Date().toISOString(), ...extra })

test('候选数量是记录配对数，三条同编号记录没有位置也不能宣称三个重复文件', () => {
  const items = ['1', '2', '3'].map(id => movie(id, '电影甲', 2020, { Tmdb: '1' }))
  const result = comparisonGroups(items)[0]
  assert.equal(result.sources.length, 3)
  assert.equal(result.comparison.counts.candidate, 3)
  assert.equal(result.comparison.label, '同作品／同季多条记录')
  assert.ok(result.comparison.pairs.every(pair => pair.reason.includes('需继续对照')))
})

test('同名同年但编号不同或缺失进入补充疑点，不改变去重，不推定重复', () => {
  for (const ids of [{ Tmdb: '2' }, {}]) {
    const items = [movie('1', '电影甲', 2020, { Tmdb: '1' }), movie('2', '电影甲', 2020, ids, 'b')]
    const result = comparisonGroups(items)[0]
    assert.equal(groupWorks(items).length, 2)
    assert.equal(result.conflict, false)
    assert.equal(matchesReview(result, 'supplemental'), true)
    assert.equal(result.comparison.counts.candidate, 0)
    assert.equal(result.comparison.hasMetadata, true)
    assert.match(result.comparison.pairs[0].basis.join(), /完整标题及年份相同/)
  }
  assert.equal(comparisonGroups([movie('1', '电影甲', 2020), movie('2', '电影甲', 2021)]).length, 0)
  assert.equal(comparisonGroups([movie('1', '电影甲', null), movie('2', '电影甲', null)]).length, 0)
  assert.equal(comparisonGroups([movie('1', '未命名条目', 2020), movie('2', '未命名条目', 2020)]).length, 0)
  assert.equal(comparisonGroups([movie('1', '甲-乙', 2020), movie('2', '甲乙', 2020)]).length, 0)
})

test('未关联的不同季、不同类型不凭标题连接；保留季号和年份限制', () => {
  const items = [{ ...series('1', '剧甲 第一季', 'a', {}), year: 2020 }, { ...series('2', '剧甲 第二季', 'b', {}), year: 2020 }]
  assert.equal(comparisonGroups(items).length, 0)
  items[1].title = items[0].title
  assert.equal(comparisonGroups(items)[0].comparison.supplemental, true)
  items[1].type = 'Movie'
  assert.equal(comparisonGroups(items).length, 0)
})

test('同服相同文件路径定位错刮与重复入库，跨服同路径、目录、远端路径均不连组', () => {
  const items = [movie('1', '甲', 2020, { Tmdb: '1' }), movie('2', '乙', 2021, { Tmdb: '2' })]
  const resources = new Map(items.map(item => [item.key, locationCache('/media/video.strm')]))
  const result = comparisonGroups(items, [], resources)[0]
  assert.equal(result.comparison.counts.candidate, 1)
  assert.equal(result.comparison.supplemental, true)
  assert.match(result.comparison.pairs[0].basis.join(), /同服务器/)
  assert.equal(groupWorks(items).length, 2)
  assert.ok(!JSON.stringify(result).includes('/media/video.strm'))
  const otherServer = { ...items[1], serverId: 'b', key: 'b:2' }
  resources.set(otherServer.key, locationCache('/media/video.strm'))
  assert.equal(comparisonGroups([items[0], otherServer], [], resources).length, 0)
  for (const path of ['/media/shared-directory', 'https://user:secret@host/video.mkv', '/media/video.mkv?token=secret']) {
    const unsafe = new Map(items.map(item => [item.key, locationCache(path)]))
    assert.equal(comparisonGroups(items, [], unsafe).length, 0)
  }
})

test('路径错误与旧格式缓存不参与线索，过期时间保留但标旧，消失条目不连组', () => {
  const items = [movie('1', '甲', 2020), movie('2', '乙', 2021)]
  const resources = new Map(items.map(item => [item.key, locationCache('/media/video.mkv')]))
  resources.get('a:1').error = '无权读取'
  assert.equal(comparisonGroups(items, [], resources).length, 0)
  resources.get('a:1').error = null
  resources.get('a:1').data.version = 1
  assert.equal(comparisonGroups(items, [], resources).length, 0)
  resources.get('a:1').data.version = 2
  resources.get('a:1').updatedAt = '2000-01-01T00:00:00Z'
  assert.match(comparisonGroups(items, [], resources)[0].comparison.pairs[0].basis.join(), /旧缓存/)
  assert.equal(comparisonGroups(items.slice(0, 1), [], resources).length, 0)
})

test('补充线索不具有传递证明力，顺序不改变配对证据', () => {
  const items = [movie('1', '甲', 2020), movie('2', '甲', 2020), movie('3', '乙', 2021)]
  const resources = new Map([['a:2', locationCache('/media/shared.mkv')], ['a:3', locationCache('/media/shared.mkv')]])
  for (const values of [items, [...items].reverse()]) {
    const result = comparisonGroups(values, [], resources)[0]
    assert.equal(result.comparison.counts.candidate, 1)
    const pair = result.comparison.pairs.find(pair => [pair.leftKey, pair.rightKey].includes('a:1') && [pair.leftKey, pair.rightKey].includes('a:3'))
    assert.equal(pair.kind, 'unknown')
    assert.match(pair.reason, /不具传递/)
  }
  assert.equal(groupWorks(items).length, 3)
})

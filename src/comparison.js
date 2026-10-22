import { workComponents } from './identity.js'
import { resourceLocations, RESOURCE_CACHE_VERSION } from './resources.js'

const validIndex = value => Number.isInteger(value) && value >= 0
const seasonPattern = /第\s*(\d{1,3}|[零〇一二两三四五六七八九十百]+)\s*季|\b(?:season\s*|s)(\d{1,3})\b/gi
const chineseNumber = value => {
  if (/^\d+$/.test(value)) return Number(value)
  let result = 0
  let digit = 0
  for (const character of value) {
    if ('十百'.includes(character)) { result += (digit || 1) * (character === '十' ? 10 : 100); digit = 0 }
    else digit = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[character]
  }
  return result + digit
}
const titleBase = item => (item.type === 'Series' ? item.title.replace(seasonPattern, '') : item.title)
  .normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

// 弱线索只进入排查，保留完整标题（含季号、标点），不改变作品去重。
const titleYearKey = item => {
  const title = item.title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  if (!Number.isInteger(item.year) || item.year < 1800 || item.year > 2200 || !title || ['未命名条目', '未知', 'unknown', 'untitled'].includes(title)) return null
  return JSON.stringify([item.type, title, item.year])
}

function reviewEvidence(items, resources) {
  const components = workComponents(items)
  const componentByKey = new Map()
  const conflicts = new Set()
  const parents = components.map((_, index) => index)
  const root = index => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index] }
    return index
  }
  components.forEach((members, index) => {
    const ids = {}
    for (const item of members) {
      componentByKey.set(item.key, index)
      for (const [provider, id] of Object.entries(item.providerIds)) {
        ids[provider] ??= new Set()
        ids[provider].add(id)
      }
    }
    if (Object.values(ids).some(values => values.size > 1)) conflicts.add(index)
  })
  const owners = new Map()
  const evidence = new Map()
  for (const item of items) {
    const cache = resources.get(item.key)
    // 只用当前格式且没有权限/读取错误的安全路径缓存；旧时间仍明确标旧。
    const paths = cache?.data?.version === RESOURCE_CACHE_VERSION && !cache.error
      ? resourceLocations({ MediaSources: (cache.data.locations || []).map(location => ({ Path: location.path })) }).locations
        .map(location => location.path).filter(path => /\.(?:mkv|mp4|avi|mov|m4v|wmv|ts|m2ts|iso|strm)$/i.test(path)) : []
    const titleKey = titleYearKey(item)
    const stale = paths.length > 0 && (!Number.isFinite(Date.parse(cache.updatedAt)) || Date.now() - Date.parse(cache.updatedAt) > 86400000)
    evidence.set(item.key, { titleKey, paths: new Set(paths), stale })
    const keys = [titleKey && `title:${titleKey}`, ...paths.map(path => JSON.stringify(['path', item.type, item.serverId, path]))].filter(Boolean)
    for (const key of keys) {
      const index = componentByKey.get(item.key)
      if (owners.has(key)) parents[root(index)] = root(owners.get(key))
      else owners.set(key, index)
    }
  }
  const grouped = new Map()
  components.forEach((members, index) => {
    const key = root(index)
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(...members)
  })
  return { groups: [...grouped.values()], componentByKey, conflicts, evidence }
}

// 标题只提供排查线索，不写回元数据，也不据此合并作品。
export function scopeEvidence(item, children = []) {
  if (item.type !== 'Series') return { seasons: [], label: '电影条目', origin: 'movie', mismatch: false }
  const hinted = [...new Set([...item.title.matchAll(seasonPattern)].map(match => chineseNumber(match[1] || match[2])))].sort((a, b) => a - b)
  const known = [...new Set(children.filter(child => child.serverId === item.serverId && child.seriesId === item.id)
    .map(child => child.type === 'Season' ? child.episode : child.type === 'Episode' ? child.season : null).filter(validIndex))].sort((a, b) => a - b)
  const mismatch = hinted.length > 0 && known.some(value => !hinted.includes(value))
  const seasons = known.length ? known : hinted
  const origin = known.length ? 'cache' : hinted.length ? 'title' : 'unknown'
  const label = seasons.length ? `第 ${seasons.join('、')} 季（${origin === 'cache' ? '季集缓存，可能不全' : '仅标题线索'}）` : '季范围未知，不能推定为第一季或全季'
  return { seasons, origin, label, mismatch }
}

// 排查组件包含编号冲突关联；与片库的作品去重严格分开。
export function comparisonGroups(items, children = [], resources = new Map()) {
  const childIndex = new Map()
  for (const child of children) {
    const key = `${child.serverId}:${child.seriesId}`
    if (!childIndex.has(key)) childIndex.set(key, [])
    childIndex.get(key).push(child)
  }
  const { groups, componentByKey, conflicts, evidence } = reviewEvidence(items, resources)
  return groups.filter(members => members.length > 1).map(members => {
    const sources = members.map(item => ({ ...item, scope: scopeEvidence(item, childIndex.get(item.key) || []) }))
    const conflict = sources.some(item => conflicts.has(componentByKey.get(item.key)))
    const reasons = []
    if (conflict) reasons.push('关联条目的外部编号互相冲突；仅展示关联证据，不认定为同一作品。')
    if (new Set(sources.map(titleBase)).size > 1) reasons.push('去掉明确季号后标题仍不一致；可能是译名差异，也可能刮削错误，请核对。')
    if (sources[0].type === 'Movie' && new Set(sources.map(item => item.year).filter(year => year > 0)).size > 1) reasons.push('关联电影的年份不一致，请核对版本与刮削结果。')
    if (sources.some(item => item.scope.mismatch)) reasons.push('标题季号与已缓存的季集范围不一致，请核对刮削结果。')
    const pairs = []
    let candidateSource = null
    const counts = { candidate: 0, distinct: 0, unknown: 0 }
    let supplemental = false
    for (let a = 0; a < sources.length; a++) for (let b = a + 1; b < sources.length; b++) {
      const left = sources[a]
      const right = sources[b]
      const leftEvidence = evidence.get(left.key)
      const rightEvidence = evidence.get(right.key)
      const sameComponent = componentByKey.get(left.key) === componentByKey.get(right.key)
      const sameTitleYear = leftEvidence.titleKey && leftEvidence.titleKey === rightEvidence.titleKey
      const samePath = left.serverId === right.serverId && [...leftEvidence.paths].some(path => rightEvidence.paths.has(path))
      const basis = []
      if (samePath) basis.push(`${leftEvidence.stale || rightEvidence.stale ? '旧缓存：' : ''}同服务器存在相同媒体文件路径文本`)
      if (sameTitleYear && !sameComponent) basis.push('完整标题及年份相同，但有效作品编号未关联（不同或缺失）')
      if (sameComponent) basis.push('通过有效作品编号关联')
      if (!basis.length) basis.push('仅经其他条目间接关联，这两条没有直接匹配依据')
      let kind = 'unknown'
      let reason = '季范围不足，无法判断是否包含相同季集。'
      if (!sameComponent) {
        if (samePath) { kind = 'candidate'; reason = '同服位置重合，可能重复入库或元数据不一致；不代表存了两份视频。' }
        else if (sameTitleYear) reason = '同名同年仍可能是不同作品；先核对外部编号、简介与位置，不据此合并或判定重复。'
        else reason = '关联不具传递证明力，请核对有直接依据的记录对。'
        if (samePath || sameTitleYear) supplemental = true
      }
      else if (conflicts.has(componentByKey.get(left.key))) reason = '作品编号冲突，先核对元数据，再判断资源是否重复。'
      else if (left.type === 'Movie') { kind = 'candidate'; reason = '相同电影编号的多条记录，需继续对照资源位置和版本。' }
      else if (left.scope.mismatch || right.scope.mismatch) reason = '季号证据冲突，不能据此判定同季重复。'
      else if (left.scope.seasons.length && right.scope.seasons.length) {
        const overlap = left.scope.seasons.filter(value => right.scope.seasons.includes(value))
        if (overlap.length) { kind = 'candidate'; reason = `已知范围包含相同的第 ${overlap.join('、')} 季；尚未确认是否为相同单集或相同文件。` }
        else { kind = 'distinct'; reason = '现有季范围没有重叠，不列为重复候选；标题或缓存可能不完整。' }
      }
      counts[kind]++
      if (kind === 'candidate' && !candidateSource) candidateSource = left
      // 大组件仍完整计数，详情最多返回 200 组，避免二次方响应。
      const pair = { leftKey: left.key, rightKey: right.key, kind, reason, basis }
      if (pairs.length < 200) pairs.push(pair)
      else if (kind === 'candidate') {
        const replace = pairs.findIndex(value => value.kind !== 'candidate')
        if (replace !== -1) pairs[replace] = pair
      }
    }
    if (supplemental) reasons.push('包含编号未关联的补充线索；同名同年或同服路径相同只供核对，不参与作品去重。')
    const hasMetadata = reasons.length > 0
    const label = conflict ? '编号冲突' : hasMetadata ? '元数据待核对' : counts.candidate ? '可能存在重复资源' : counts.unknown ? '季范围待确认' : '不同季，暂无线索'
    const priority = { candidate: 0, unknown: 1, distinct: 2 }
    pairs.sort((a, b) => priority[a.kind] - priority[b.kind])
    return { ...(candidateSource || sources[0]), sources, conflict, comparison: { label, reasons, counts, hasMetadata, supplemental, pairs, truncated: pairs.length < sources.length * (sources.length - 1) / 2 } }
  })
}

export function matchesReview(group, filter = 'issues') {
  const review = group.comparison
  if (filter === 'all') return true
  if (filter === 'resources') return review.counts.candidate > 0
  if (filter === 'metadata') return review.hasMetadata
  if (filter === 'supplemental') return review.supplemental
  if (filter === 'unknown') return review.counts.unknown > 0
  return review.hasMetadata || review.counts.candidate > 0 || review.counts.unknown > 0
}

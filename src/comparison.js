import { workComponents } from './identity.js'

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
export function comparisonGroups(items, children = []) {
  const childIndex = new Map()
  for (const child of children) {
    const key = `${child.serverId}:${child.seriesId}`
    if (!childIndex.has(key)) childIndex.set(key, [])
    childIndex.get(key).push(child)
  }
  return workComponents(items).filter(members => members.length > 1).map(members => {
    const sources = members.map(item => ({ ...item, scope: scopeEvidence(item, childIndex.get(item.key) || []) }))
    const ids = {}
    for (const item of sources) for (const [provider, id] of Object.entries(item.providerIds)) {
      ids[provider] ??= new Set()
      ids[provider].add(id)
    }
    const conflict = Object.values(ids).some(values => values.size > 1)
    const reasons = []
    if (conflict) reasons.push('关联条目的外部编号互相冲突；仅展示关联证据，不认定为同一作品。')
    if (new Set(sources.map(titleBase)).size > 1) reasons.push('去掉明确季号后标题仍不一致；可能是译名差异，也可能刮削错误，请核对。')
    if (sources[0].type === 'Movie' && new Set(sources.map(item => item.year).filter(year => year > 0)).size > 1) reasons.push('同编号电影的年份不一致，请核对版本与刮削结果。')
    if (sources.some(item => item.scope.mismatch)) reasons.push('标题季号与已缓存的季集范围不一致，请核对刮削结果。')
    const pairs = []
    let candidateSource = null
    const counts = { candidate: 0, distinct: 0, unknown: 0 }
    for (let a = 0; a < sources.length; a++) for (let b = a + 1; b < sources.length; b++) {
      const left = sources[a]
      const right = sources[b]
      let kind = 'unknown'
      let reason = '季范围不足，无法判断是否包含相同季集。'
      if (conflict) reason = '作品编号冲突，先核对元数据，再判断资源是否重复。'
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
      const pair = { leftKey: left.key, rightKey: right.key, kind, reason }
      if (pairs.length < 200) pairs.push(pair)
      else if (kind === 'candidate') {
        const replace = pairs.findIndex(value => value.kind !== 'candidate')
        if (replace !== -1) pairs[replace] = pair
      }
    }
    const hasMetadata = reasons.length > 0
    const label = conflict ? '编号冲突' : hasMetadata ? '元数据待核对' : counts.candidate ? '可能存在重复资源' : counts.unknown ? '季范围待确认' : '不同季，暂无线索'
    const priority = { candidate: 0, unknown: 1, distinct: 2 }
    pairs.sort((a, b) => priority[a.kind] - priority[b.kind])
    return { ...(candidateSource || sources[0]), sources, conflict, comparison: { label, reasons, counts, hasMetadata, pairs, truncated: pairs.length < sources.length * (sources.length - 1) / 2 } }
  })
}

export function matchesReview(group, filter = 'issues') {
  const review = group.comparison
  if (filter === 'all') return true
  if (filter === 'resources') return review.counts.candidate > 0
  if (filter === 'metadata') return review.hasMetadata
  if (filter === 'unknown') return review.counts.unknown > 0
  return review.hasMetadata || review.counts.candidate > 0 || review.counts.unknown > 0
}

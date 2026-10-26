import { groupWorks } from './identity.js'
import { scopeEvidence } from './comparison.js'
import { RemoteError } from './emby.js'

const validNumber = value => Number.isInteger(value) && value >= 0 && value <= 10000
const countRanges = ranges => ranges.reduce((total, range) => total + range.end - range.start + 1, 0)

// 用区间处理合并集，避免展开巨大编号或把多版本计成多集。
export function mergeRanges(ranges) {
  const merged = []
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1)
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}
function gaps(ranges, start, end) {
  const result = []
  let next = start
  for (const range of ranges) {
    if (range.start > next) result.push({ start: next, end: range.start - 1 })
    next = Math.max(next, range.end + 1)
  }
  if (next <= end) result.push({ start: next, end })
  return result
}
function intersection(left, right) {
  const result = []
  let a = 0, b = 0
  while (a < left.length && b < right.length) {
    const start = Math.max(left[a].start, right[b].start)
    const end = Math.min(left[a].end, right[b].end)
    if (start <= end) result.push({ start, end })
    if (left[a].end < right[b].end) a++
    else b++
  }
  return result
}

export function auditSource(item, episodes, { updatedAt = null, error = null, stale = false, available = false, running = false } = {}) {
  const seasons = new Map()
  let invalid = 0, legacy = 0, excluded = 0
  for (const episode of episodes) {
    if (episode.type !== 'Episode' || episode.seriesId !== item.id || episode.serverId !== item.serverId) continue
    if (episode.episodeNumberingVersion !== 1) { legacy++; continue }
    if (episode.virtual || episode.season === 0 || episode.episode === 0) { excluded++; continue }
    const end = episode.episodeEnd ?? episode.episode
    if (!validNumber(episode.season) || !validNumber(episode.episode) || !validNumber(end) || end < episode.episode) { invalid++; continue }
    if (!seasons.has(episode.season)) seasons.set(episode.season, [])
    seasons.get(episode.season).push({ start: episode.episode, end })
  }
  const mismatch = scopeEvidence(item, episodes.filter(episode => episode.season > 0 && !episode.virtual)).mismatch
  const reasons = [
    !available && '尚无完整单集快照，请按需读取本剧单集',
    error && '上次读取失败，以下保留旧快照',
    stale && '单集快照可能过期，请重新读取后确认',
    legacy > 0 && '旧缓存未保留合并集信息，需重新读取',
    invalid > 0 && '存在缺失或异常季集编号，暂不判定缺口',
    mismatch && '标题季号与单集季号冲突，暂不判定缺口',
    available && !seasons.size && !legacy && '没有可分析的正片单集'
  ].filter(Boolean)
  return {
    serverId: item.serverId, seriesId: item.id, title: item.title, serverName: item.serverName,
    updatedAt, error, stale, running, excluded, reasons, eligible: reasons.length === 0,
    seasons: [...seasons].sort(([a], [b]) => a - b).map(([number, ranges]) => {
      const present = mergeRanges(ranges)
      return { number, present, count: countRanges(present), gaps: [], missingCount: 0, alternatives: [] }
    })
  }
}

export function compareEpisodeSources(sources) {
  for (const source of sources) {
    if (!source.eligible) continue
    for (const season of source.seasons) {
      const peers = sources.filter(peer => peer !== source && peer.eligible)
        .flatMap(peer => peer.seasons.filter(other => other.number === season.number).map(other => ({ peer, other })))
      const observed = mergeRanges([...season.present, ...peers.flatMap(({ other }) => other.present)])
      season.start = observed[0].start
      season.end = observed.at(-1).end
      season.gaps = gaps(season.present, season.start, season.end)
      season.missingCount = countRanges(season.gaps)
      season.alternatives = peers.map(({ peer, other }) => ({
        serverId: peer.serverId, seriesId: peer.seriesId, serverName: peer.serverName,
        ranges: intersection(season.gaps, other.present)
      })).filter(peer => peer.ranges.length)
    }
  }
  return sources
}

export function episodeAudit(service, params) {
  const rows = service.selected(params.get('server'))
  const catalogs = new Map(rows.map(row => [row.id, service.store.cache(row.id, 'catalog')]))
  const groups = groupWorks(service.collect(rows, 'catalog', catalogs).filter(item => item.type === 'Series'))
  const rowById = new Map(rows.map(row => [row.id, row]))
  const children = new Map()
  const snapshots = new Map()
  for (const row of rows) {
    for (const item of catalogs.get(row.id)?.data || []) {
      if (item.type !== 'Episode' || !item.seriesId) continue
      const key = `${row.id}:${item.seriesId}`
      if (!children.has(key)) children.set(key, [])
      children.get(key).push(item)
    }
    for (const cache of service.store.db.prepare("SELECT kind,data,updatedAt,error FROM cache WHERE serverId=? AND kind LIKE 'episodes:%'").all(row.id)) {
      snapshots.set(`${row.id}:${cache.kind.slice(9)}`, { ...cache, data: cache.data ? JSON.parse(cache.data) : null })
    }
  }
  let items = groups.map(group => {
    const sources = group.sources.map(item => {
      const row = rowById.get(item.serverId)
      const catalog = catalogs.get(row.id)
      const direct = snapshots.get(item.key)
      const useDirect = direct && (direct.error || service.seasonMode(row.id) || !catalog?.data || direct.updatedAt >= catalog.updatedAt)
      const cache = useDirect ? direct : service.seasonMode(row.id) ? null : catalog
      const episodes = useDirect ? direct.data || [] : children.get(item.key) || []
      const age = (useDirect ? service.cacheMinutes / 60 : row.fullHours || 24) * 3600000
      return auditSource(item, episodes, {
        available: Array.isArray(cache?.data) && !(!useDirect && service.catalogWarning(catalog)),
        updatedAt: cache?.updatedAt || null, error: cache?.error || null,
        stale: !!cache?.updatedAt && (Date.now() - Date.parse(cache.updatedAt) > age || !useDirect && ['offline', 'denied', 'error'].includes(row.status)),
        running: service.detailJobs.has(`${row.id}:${row.revision}:${item.id}`)
      })
    })
    compareEpisodeSources(sources)
    const missingCount = sources.reduce((total, source) => total + source.seasons.reduce((n, season) => n + season.missingCount, 0), 0)
    return { key: group.key, title: group.title, conflict: group.conflict, sources, missingCount,
      state: missingCount ? 'gaps' : sources.some(source => !source.eligible) ? 'unknown' : 'continuous' }
  })
  const counts = Object.fromEntries(['gaps', 'unknown', 'continuous'].map(state => [state, items.filter(item => item.state === state).length]))
  const running = items.some(item => item.sources.some(source => source.running))
  const query = (params.get('q') || '').trim().toLocaleLowerCase().slice(0, 200)
  const state = params.get('state') || 'all'
  if (!['all', 'gaps', 'unknown', 'continuous'].includes(state)) throw new RemoteError('缺集检查筛选无效', 400)
  items = items.filter(item => (state === 'all' || state === item.state) && (!query || item.sources.some(source => source.title.toLocaleLowerCase().includes(query))))
  const order = { gaps: 0, unknown: 1, continuous: 2 }
  items.sort((a, b) => order[a.state] - order[b.state] || a.title.localeCompare(b.title, 'zh-CN') || a.key.localeCompare(b.key))
  const total = items.length
  const pages = Math.max(1, Math.ceil(total / 20))
  const page = Math.min(pages, Math.max(1, Number.parseInt(params.get('page')) || 1))
  return { items: items.slice((page - 1) * 20, page * 20), total, page, pages, counts, running, offline: service.offline,
    knownServers: rows.filter(row => catalogs.get(row.id)?.data != null).length, totalServers: rows.length }
}

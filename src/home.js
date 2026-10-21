// 只呈现账号返回的最后播放时间，不将继续观看、入库时间推断为观看历史。
export function homeSnapshot(store, rows, now = Date.now()) {
  const recent = []
  const resume = []
  const sources = []
  for (const row of rows) {
    const records = new Map()
    for (const kind of ['catalog', 'latest', 'resume']) {
      const cache = store.cache(row.id, kind)
      sources.push({ serverId: row.id, serverName: row.name, kind, updatedAt: cache?.updatedAt || null,
        error: cache?.error || row.error || null, available: Array.isArray(cache?.data),
        stale: !!cache?.data && (!!cache.error || !['online', 'partial'].includes(row.status) || now - Date.parse(cache.updatedAt) > (kind === 'catalog' ? (row.fullHours || 24) * 3600000 : row.lightMinutes * 60000)) })
      for (const item of cache?.data || []) {
        if (!['Movie', 'Episode', 'Series'].includes(item.type)) continue
        const record = { ...item, serverId: row.id, key: `${row.id}:${item.id}`, serverName: row.name, nsfw: !!row.nsfw, observedAt: cache.updatedAt }
        const previous = records.get(item.id)
        if (!previous || Date.parse(cache.updatedAt) >= Date.parse(previous.observedAt)) records.set(item.id, record)
        if (kind === 'resume') resume.push(record)
      }
    }
    for (const item of records.values()) {
      const time = Date.parse(item.lastPlayed)
      if (Number.isFinite(time) && time <= now) recent.push(item)
    }
  }
  const order = (a, b) => (Date.parse(b.lastPlayed) || 0) - (Date.parse(a.lastPlayed) || 0) || a.key.localeCompare(b.key)
  return {
    recent: recent.sort(order).slice(0, 24), resume: resume.sort(order).slice(0, 18), sources,
    historyAvailable: recent.length > 0,
    historyNote: '依据当前账号 LastPlayedDate 排序，每条目只显示最后一次；不是完整播放历史，也不代表观看完成。',
    emptyReason: recent.length ? null : '已缓存数据未提供有效的最后播放时间，暂时无法展示最近观看。继续观看单独保留，不用入库时间补齐。'
  }
}

// 编号连接成组后再检查冲突，避免合并结果依赖输入顺序。
export function groupWorks(items) {
  const parents = items.map((_, index) => index)
  function root(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]]
      index = parents[index]
    }
    return index
  }
  const owners = new Map()
  items.forEach((item, index) => {
    for (const [provider, id] of Object.entries(item.providerIds)) {
      const key = `${item.type}:${provider}:${id}`
      if (owners.has(key)) parents[root(index)] = root(owners.get(key))
      else owners.set(key, index)
    }
  })
  const components = new Map()
  items.forEach((item, index) => {
    const key = root(index)
    if (!components.has(key)) components.set(key, [])
    components.get(key).push(item)
  })
  const groups = []
  for (const members of components.values()) {
    const ids = {}
    for (const item of members) {
      for (const [provider, id] of Object.entries(item.providerIds)) {
        ids[provider] ??= new Set()
        ids[provider].add(id)
      }
    }
    const conflict = Object.values(ids).some(values => values.size > 1)
    if (conflict) groups.push(...members.map(item => ({ ...item, sources: [item], conflict: true })))
    else groups.push({ ...members[0], sources: members, conflict: false })
  }
  return groups
}

export function normalizeItem(item, serverId) {
  if (!item || typeof item.Id !== 'string' || !item.Id || item.Id.length > 200) throw new Error('invalid-item')
  const providerIds = {}
  for (const [key, value] of Object.entries(item.ProviderIds || {})) {
    const provider = key.toLowerCase()
    const id = String(value).trim().toLowerCase()
    if ((['tmdb', 'tvdb'].includes(provider) && /^[1-9]\d*$/.test(id)) || (provider === 'imdb' && /^tt\d+$/.test(id))) providerIds[provider] = id
  }
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
  const string = value => typeof value === 'string' ? value : null
  const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
  return {
    id: item.Id, serverId, key: `${serverId}:${item.Id}`, title: string(item.Name) || '未命名条目',
    type: string(item.Type), overview: string(item.Overview), year: number(item.ProductionYear),
    rating: number(item.CommunityRating), genres: Array.isArray(item.Genres) ? item.Genres.filter(x => typeof x === 'string') : [],
    providerIds, createdAt: validDate(item.DateCreated), premiereDate: validDate(item.PremiereDate),
    seriesId: string(item.SeriesId), seriesName: string(item.SeriesName), seasonId: string(item.SeasonId),
    season: number(item.ParentIndexNumber), episode: number(item.IndexNumber),
    imageTag: string(item.ImageTags?.Primary), runtimeTicks: number(item.RunTimeTicks),
    positionTicks: number(item.UserData?.PlaybackPositionTicks), lastPlayed: validDate(item.UserData?.LastPlayedDate)
  }
}

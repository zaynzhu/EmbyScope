import http from 'node:http'

export const sampleMovie = (id, providerIds = {}, extra = {}) => ({
  Id: id, Name: `测试电影 ${id}`, Type: 'Movie', ProductionYear: 2025,
  Overview: '这是一条用于验证功能的模拟媒体数据，不来自真实 Emby。',
  Genres: ['剧情'], CommunityRating: 8.2, ProviderIds: providerIds,
  DateCreated: '2026-10-10T10:00:00Z', ...extra
})

export async function mockEmby(label, { count = 29, requireCompatAuth = false, limitedCatalog = false } = {}) {
  const calls = []
  const state = { offline: false, denied: new Set(), badPages: false, slow: false }
  const movies = Array.from({ length: count }, (_, index) => sampleMovie(String(index + 1), { Tmdb: String(1000 + index) }, {
    Name: ['星际穿越', '千与千寻', '海上钢琴师', '楚门的世界', '天使爱美丽', '机器人总动员'][index % 6] + ` · ${index + 1}`,
    ImageTags: index === 0 ? { Primary: 'test-tag' } : undefined
  }))
  movies.push(sampleMovie('conflict', { Tmdb: '998', Imdb: label === 'A' ? 'tt100' : 'tt200' }, { Name: '冲突作品' }))
  movies.push(sampleMovie('missing', {}, { Name: '同名但无编号' }))
  const series = { Id: 'series', Name: '山海之间', Type: 'Series', ProviderIds: { Tvdb: '100' }, Genres: ['纪录片'], ProductionYear: 2026, Overview: '模拟电视剧，用于验证季集展示。' }
  const episodes = Array.from({ length: 55 }, (_, index) => ({ Id: `ep-${index}`, Type: 'Episode', Name: `山海之间 · 第 ${index + 1} 集`, SeriesId: 'series', SeriesName: '山海之间', ParentIndexNumber: index < 30 ? 1 : 2, IndexNumber: index < 30 ? index + 1 : index - 29 }))
  const catalog = [...movies, series, ...(limitedCatalog ? [{ Id: 'folder', Type: 'Folder', Name: '未按筛选排除的文件夹' }] : episodes)]
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = url.pathname
    calls.push({ path, method: request.method, at: Date.now(), auth: request.headers['x-emby-token'], query: Object.fromEntries(url.searchParams) })
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(data))
    }
    if (state.slow) await new Promise(resolve => setTimeout(resolve, 150))
    if (state.offline) return json(503, { Message: 'offline' })
    if (requireCompatAuth && !request.headers['x-emby-authorization']?.includes('DeviceId="')) {
      response.writeHead(400, { 'Content-Type': 'text/plain' })
      return response.end('DeviceId required in X-Emby-Authorization header')
    }
    if (path === '/Users/AuthenticateByName' && request.method === 'POST') {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      if (body.Username !== 'fixture-user' || body.Pw !== 'fixture-pass') return json(401, {})
      return json(200, { AccessToken: `secret-token-${label}`, User: { Id: 'same-user-id' } })
    }
    if (request.headers['x-emby-token'] !== `secret-token-${label}`) return json(401, {})
    if (state.denied.has('all')) return json(401, {})
    if (state.denied.has(path)) return json(403, {})
    if (request.method !== 'GET') return json(405, {})
    if (path === '/Users/same-user-id/Items') {
      const start = Number(url.searchParams.get('StartIndex'))
      // 故意比客户端请求页大小更小，验证依照实际返回数量推进分页。
      const items = catalog.slice(state.badPages ? 0 : start, (state.badPages ? 0 : start) + 23)
      return json(200, { Items: items, TotalRecordCount: catalog.length })
    }
    if (path.endsWith('/Views')) return json(200, { Items: [{ Id: 'view', Name: `${label} 的电影与电视剧`, CollectionType: 'mixed' }] })
    if (path.endsWith('/Latest')) return json(200, movies.slice(0, 6))
    if (path.endsWith('/Resume')) return json(200, { Items: [{ ...movies[0], RunTimeTicks: 100000000, UserData: { PlaybackPositionTicks: 40000000, LastPlayedDate: '2026-10-16T12:00:00Z' } }] })
    if (path === '/Items/1/Images/Primary') {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      return response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRp8AAAAASUVORK5CYII=', 'base64'))
    }
    return json(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, state, calls, catalog,
    close: () => new Promise(resolve => server.close(resolve)) }
}

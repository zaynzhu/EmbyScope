import { readFileSync, existsSync } from 'node:fs'
import { normalizeItem } from '../../src/identity.js'
import { RESOURCE_CACHE_VERSION } from '../../src/resources.js'

// 仅显式演示模式使用；所有来源与路径均虚构，不会连接真实服务器。
export function seedDemo(store, artwork) {
  if (store.servers().length) return
  const cover = artwork && existsSync(artwork) ? readFileSync(artwork) : null
  const spacePath = artwork?.replace('demo-cover.jpg', 'demo-space.jpg')
  const space = spacePath && existsSync(spacePath) ? readFileSync(spacePath) : cover
  const names = ['潮汐之后', '失重时刻', '山海来信', '最后一班列车', '明日花园', '长夜微光', '远山回声', '第七封信', '海岸线', '小城漫游', '雨停之前', '群星之间']
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
  const now = Date.now()
  ids.forEach((id, serverIndex) => {
    store.db.prepare('INSERT INTO servers(id,name,url,secret,status,error,nsfw) VALUES(?,?,?,?,?,?,?)')
      .run(id, serverIndex ? '云端收藏 · 演示' : '家庭影院 · 演示', `https://demo-${serverIndex}.invalid`, store.encrypt({ username: 'demo', password: 'demo' }), serverIndex ? 'offline' : 'online', serverIndex ? '模拟离线：保留上次缓存' : null, serverIndex)
    const items = Array.from({ length: 40 }, (_, index) => normalizeItem({
      Id: String(index), Name: names[index % names.length] + (index >= 12 ? ` · ${Math.floor(index / 12) + 1}` : ''),
      Type: index % 5 === 2 ? 'Series' : 'Movie', ProductionYear: 2026 - index % 4,
      Overview: index === 0 ? '一次归途，一封迟到的信。在潮汐与灯塔之间，她重新听见了生活的回声。' : '这是虚构的演示作品，用于预览海报、观看记录和跨服务器资源对照，不代表你的真实媒体数据。',
      Genres: index % 5 === 2 ? ['纪录片'] : ['剧情', '冒险'], CommunityRating: 7.1 + index % 6 * 0.3,
      ProviderIds: index === 10 ? { Tmdb: '999', Imdb: serverIndex ? 'tt222' : 'tt111' } : index === 11 ? {} : { Tmdb: String(100 + index) },
      DateCreated: new Date(now - index * 86400000).toISOString(), ImageTags: { Primary: 'demo-art' },
      RunTimeTicks: 72000000000,
      UserData: index < 8 ? { LastPlayedDate: new Date(now - (index * 25 + serverIndex * 3 + 2) * 3600000).toISOString(), PlaybackPositionTicks: index < 4 ? (28 + index * 12) * 600000000 : null } : {}
    }, id))
    store.saveCache(id, 'catalog', items)
    store.saveCache(id, 'views', [{ id: 'demo-library', serverId: id, name: '电影与剧集', type: 'mixed' }])
    store.saveCache(id, 'latest', items.slice(0, 12))
    store.saveCache(id, 'resume', serverIndex ? null : items.slice(0, 4))
    if (serverIndex) store.db.prepare("UPDATE cache SET error='模拟账号无权读取继续观看' WHERE serverId=? AND kind='resume'").run(id)
    for (const item of items) {
      store.saveCache(id, `resources:${item.id}`, { version: RESOURCE_CACHE_VERSION, locations: [{ path: `/演示资源/${serverIndex ? '云端' : '本地'}/${item.title}/影片.mkv`, label: '条目位置' }], hiddenRemote: false })
      if (cover) store.db.prepare('INSERT INTO images VALUES(?,?,?,?,?,?)').run(id, item.id, 'demo-art', 'image/jpeg', Number(item.id) % 2 ? space : cover, now)
    }
  })
}

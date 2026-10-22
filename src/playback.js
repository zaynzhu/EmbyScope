import { RemoteError } from './emby.js'
import { ResumeActivityDetector, ACTIVITY_INTERVAL, ACTIVITY_TTL, ACTIVITY_SNAPSHOT_TTL } from './playback-activity.js'

const SNAPSHOT_TTL = 60000
const REFRESH_INTERVAL = 10000
const ERROR_BACKOFF = 60000
const text = value => typeof value === 'string' && value.length <= 300 ? value : null
const ticks = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

// 会话不进入片库；只接受当前登录用户，丢弃地址、令牌和其他用户信息。
export function normalizeSessions(response, userId, now = Date.now()) {
  if (!Array.isArray(response)) throw new RemoteError('播放会话响应格式不支持')
  const sessions = new Map()
  for (const item of response) {
    if (!item || !userId || item.UserId !== userId || !item.NowPlayingItem) continue
    const id = text(item.Id)
    const mediaId = text(item.NowPlayingItem.Id)
    if (!id || !mediaId) continue
    const activity = Date.parse(item.LastActivityDate)
    const recent = Number.isFinite(activity) && now - activity >= -5000 && now - activity <= 90000
    sessions.set(id, {
      id, itemId: mediaId, title: text(item.NowPlayingItem.Name) || '未提供标题',
      client: text(item.Client), device: text(item.DeviceName),
      lastActivityAt: Number.isFinite(activity) ? new Date(activity).toISOString() : null,
      state: !recent ? 'unknown' : item.PlayState?.IsPaused === true ? 'paused' : item.PlayState?.IsPaused === false ? 'playing' : 'unknown',
      positionTicks: ticks(item.PlayState?.PositionTicks), runtimeTicks: ticks(item.NowPlayingItem.RunTimeTicks)
    })
  }
  return [...sessions.values()].slice(0, 100)
}

export function playbackSnapshot(store, rows, offline = false, now = Date.now()) {
  return { servers: rows.map(row => {
    const cache = store.cache(row.id, 'playback')
    const age = now - Date.parse(cache?.updatedAt)
    const activity = cache?.data?.mode === 'activity'
    const maxAgeMs = activity ? ACTIVITY_SNAPSHOT_TTL : SNAPSHOT_TTL
    const stale = offline || !!cache?.error || !Number.isFinite(age) || age < 0 || age > maxAgeMs
    const data = activity ? cache.data.sessions : cache?.data
    const available = Array.isArray(data)
    const sessions = available ? data.map(session => {
      const observedAge = now - Date.parse(session.observedAt)
      const expired = activity && (!Number.isFinite(observedAge) || observedAge < 0 || observedAge >= ACTIVITY_TTL)
      return { ...session, state: stale || expired ? 'unknown' : session.state }
    }) : []
    return { serverId: row.id, serverName: row.name, nsfw: !!row.nsfw, available, stale,
      mode: activity ? 'activity' : 'sessions', maxAgeSeconds: maxAgeMs / 1000,
      activityStatus: activity ? stale || sessions.some(session => session.state === 'unknown') ? 'unknown' : cache.data.status : null,
      checkedAt: cache?.updatedAt || null, error: cache?.error || null,
      sessions }
  }) }
}

export async function refreshPlayback(service, row, { compatibility = false, observationId = '' } = {}) {
  if (service.offline || service.stopping) throw new RemoteError('离线预览不能读取播放会话', 409)
  if (service.playbackJobs.has(row.id)) return service.playbackJobs.get(row.id)
  const attempt = service.store.cache(row.id, 'playbackAttempt')?.data?.at || 0
  const cooldown = service.store.cache(row.id, 'playback')?.error ? ERROR_BACKOFF : compatibility ? ACTIVITY_INTERVAL : REFRESH_INTERVAL
  if (Date.now() - attempt < cooldown) return
  service.store.saveCache(row.id, 'playbackAttempt', { at: Date.now() })
  const job = (async () => {
    try {
      const secret = service.store.decrypt(row.secret)
      if (!secret.token || !secret.userId) throw new RemoteError('尚未登录此媒体账号，请先完成连接登录', 401)
      // 使用原服务地址；关联反代只记录归属，不转发凭据或再创建一套会话。
      let data
      if (compatibility) {
        const key = JSON.stringify([row.revision, secret.userId, observationId])
        let observer = service.playbackObservers.get(row.id)
        if (observer?.key !== key) {
          observer = { key, detector: new ResumeActivityDetector() }
          service.playbackObservers.set(row.id, observer)
        }
        const response = await service.client.request(row,
          `/Users/${encodeURIComponent(secret.userId)}/Items/Resume?Limit=18&EnableUserData=true`,
          { token: secret.token, mediaBrowser: true, retries: 0, maxBytes: 1024 * 1024 })
        data = observer.detector.observe(response, secret.userId, Date.now())
      } else {
        service.playbackObservers.delete(row.id)
        const response = await service.client.request(row, '/Sessions', { token: secret.token })
        data = normalizeSessions(response, secret.userId)
      }
      if (service.current(row) && !service.stopping) service.store.saveCache(row.id, 'playback', data)
    } catch (error) {
      if (!service.current(row) || service.stopping) return
      service.playbackObservers.delete(row.id)
      const message = compatibility
        ? ({ 401: '当前账号登录已失效', 403: '当前账号无权读取续播记录', 404: '此服务的续播接口不可用' }[error.status] || '兼容检测读取失败，当前状态未知')
        : ({ 401: '当前账号登录已失效', 403: '当前账号无权读取播放会话', 404: '此服务的播放会话接口不可用' }[error.status] || '播放会话读取失败，当前状态未知')
      const cache = service.store.cache(row.id, 'playback')
      const sameMode = (cache?.data?.mode === 'activity') === compatibility
      const previous = ![401, 403].includes(error.status) && sameMode ? cache?.data : null
      const data = compatibility ? { mode: 'activity', status: 'unknown', sessions: previous?.sessions ?? [] } : previous ?? null
      service.store.db.prepare(`INSERT INTO cache VALUES(?,?,?,?,?) ON CONFLICT(serverId,kind)
        DO UPDATE SET data=excluded.data,updatedAt=excluded.updatedAt,error=excluded.error`)
        .run(row.id, 'playback', JSON.stringify(data), cache?.updatedAt || '', message)
    }
  })().finally(() => service.playbackJobs.delete(row.id))
  service.playbackJobs.set(row.id, job)
  return job
}

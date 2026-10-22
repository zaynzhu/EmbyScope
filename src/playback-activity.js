import { RemoteError } from './emby.js'

export const ACTIVITY_INTERVAL = 15000
export const ACTIVITY_TTL = 60000
export const ACTIVITY_SNAPSHOT_TTL = 35000
const MAX_SAMPLE_GAP = 45000
const safeText = value => typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null

// 仅保存本次观察的白名单数据；不将续播条目直接视为正在播放。
export class ResumeActivityDetector {
  constructor() {
    this.previous = new Map()
    this.checkedAt = null
    this.startedAt = null
    this.uncertainUntil = 0
  }
  observe(response, userId, now) {
    if (!userId || !Number.isFinite(now) || !Array.isArray(response?.Items) || response.Items.length > 18 ||
      (response.UserId !== undefined && response.UserId !== userId)) throw new RemoteError('续播活动响应格式不支持')
    const rows = new Map()
    for (const item of response.Items) {
      const id = safeText(item?.Id)
      if (!id || rows.has(id) || (item.UserId !== undefined && item.UserId !== userId) ||
        (item.UserData?.UserId !== undefined && item.UserData.UserId !== userId)) throw new RemoteError('续播活动身份或条目格式不支持')
      const position = item.UserData?.PlaybackPositionTicks
      const stamp = safeText(item.UserData?.LastPlayedDate)
      rows.set(id, { id, title: safeText(item.Name) || '未提供标题',
        position: Number.isSafeInteger(position) && position >= 0 ? position : null,
        stamp: stamp && Number.isFinite(Date.parse(stamp)) ? stamp : null })
    }
    if (this.checkedAt === null || now <= this.checkedAt || now - this.checkedAt > MAX_SAMPLE_GAP) {
      this.previous.clear()
      this.startedAt = now
      this.uncertainUntil = 0
    }
    const next = new Map()
    const sessions = []
    for (const [id, previous] of this.previous) {
      if (!rows.has(id) && previous.detectedAt !== null) this.uncertainUntil = Math.max(this.uncertainUntil, previous.detectedAt + ACTIVITY_TTL)
    }
    for (const [id, row] of rows) {
      const previous = this.previous.get(id)
      const elapsed = this.checkedAt === null ? 0 : now - this.checkedAt
      const valid = row.position !== null && row.stamp !== null
      const delta = valid && previous?.position !== null ? row.position - previous?.position : NaN
      // 放宽到三倍速并容纳上报批次；大跳转不能单独建立播放活动。
      const advancing = valid && previous?.stamp && row.stamp !== previous.stamp && elapsed >= ACTIVITY_INTERVAL &&
        delta > 0 && delta / 10000 <= elapsed * 3 + 10000
      const streak = advancing ? Math.min((previous.streak || 0) + 1, 2) : 0
      const detectedAt = !valid || delta < 0 || delta / 10000 > elapsed * 3 + 10000 ? null
        : streak >= 2 ? now : previous?.detectedAt ?? null
      next.set(id, { ...row, streak, detectedAt })
      if (detectedAt !== null && now - detectedAt < ACTIVITY_TTL) sessions.push({
        id, itemId: id, title: row.title, state: 'activity', observedAt: new Date(detectedAt).toISOString(),
        client: null, device: null, positionTicks: null, runtimeTicks: null
      })
    }
    this.previous = next
    this.checkedAt = now
    const incomplete = [...rows.values()].some(row => row.position === null || row.stamp === null)
    const status = sessions.length ? 'activity' : now < this.uncertainUntil || incomplete ? 'unknown'
      : now - this.startedAt < ACTIVITY_TTL ? 'warming' : 'no_activity'
    return { mode: 'activity', status, sessions }
  }
}

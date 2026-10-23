import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.js'
import { readDoubanState, saveDoubanState, allowedPoster, imageMime } from '../src/douban.js'
import { validDoubanDate } from '../src/douban-parser.js'

// 一次性复制；运行中的 PixelReel 也只通过只读事务取得一致视图，不复制凭据。
export function importPixelReel(sourcePath, store, posterDirectory) {
  if (store.db.prepare('SELECT count(*) AS count FROM douban_items').get().count || readDoubanState(store).importedAt) {
    throw new Error('映览已有豆瓣数据，拒绝重复迁移或覆盖')
  }
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  let began = false
  try {
    source.exec('PRAGMA query_only=ON; BEGIN')
    const account = source.prepare("SELECT account_identifier FROM source_account WHERE source='douban'").get()?.account_identifier
    const checkpointJSON = source.prepare("SELECT value FROM app_setting WHERE key='douban_harvest_checkpoint'").get()?.value
    const checkpoint = checkpointJSON ? JSON.parse(checkpointJSON) : null
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(account || '') || !checkpoint || checkpoint.accountIdentifier !== account || !validDoubanDate(checkpoint.date)) {
      throw new Error('来源账号或增量检查点无效，不能从记录日期推测同步起点')
    }
    if (source.prepare('SELECT count(*) AS count FROM douban_pending_harvest').get().count) throw new Error('来源还有待处理批次，请先完成原批次再迁移')
    const entries = []
    const ids = new Set()
    for (const [table, type] of [['movie', 'Movie'], ['tv_show', 'Series']]) {
      for (const row of source.prepare(`SELECT * FROM ${table} WHERE douban_id IS NOT NULL AND douban_id != ''`).all()) {
        if (!/^\d{1,20}$/.test(row.douban_id) || ids.has(row.douban_id) || row.status !== 'DONE') throw new Error('来源存在身份冲突或非已看记录，迁移已停止')
        ids.add(row.douban_id)
        const item = { id: row.douban_id, type, title: row.douban_title || row.title,
          altTitle: row.douban_alt_title, intro: row.douban_intro,
          rating: row.douban_rating, date: row.douban_date, comment: row.douban_comment,
          link: `https://movie.douban.com/subject/${row.douban_id}/`,
          posterUrl: row.poster_url || row.tmdb_poster_url || null,
          overview: row.overview || row.tmdb_overview || null,
          releaseDate: row.release_date || row.first_air_date || null, averageRating: row.douban_avg_rating,
          personalRating: row.rating, personalComment: row.short_review }
        if (!item.title || (item.rating != null && (!Number.isInteger(item.rating) || item.rating < 1 || item.rating > 5))) throw new Error('来源标题或评分无效')
        entries.push(item)
      }
    }
    if (!entries.length) throw new Error('来源没有可迁移的豆瓣已看数据')
    const last = source.prepare("SELECT * FROM sync_run WHERE source='douban' AND state='COMPLETED' AND operation IN ('douban_full','douban_incremental') ORDER BY finished_at DESC LIMIT 1").get()
    store.db.exec('BEGIN')
    began = true
    let images = 0
    for (const item of entries) {
      store.db.prepare('INSERT INTO douban_items VALUES(?,?,?)').run(item.id, item.type, JSON.stringify(item))
      if (!posterDirectory || !allowedPoster(item.posterUrl)) continue
      const path = join(posterDirectory, createHash('sha256').update(item.posterUrl).digest('hex'))
      if (!existsSync(path) || statSync(path).size > 8 * 1024 * 1024) continue
      const bytes = readFileSync(path)
      const mime = imageMime(bytes)
      if (!mime) continue
      store.db.prepare('INSERT INTO douban_images VALUES(?,?,?,?)').run(item.id, item.posterUrl, mime, bytes)
      images++
    }
    const state = { account, checkpoint: checkpoint.date, importedAt: new Date().toISOString(), source: 'PixelReel macOS',
      lastRun: last ? { mode: last.operation === 'douban_full' ? 'full' : 'incremental', state: 'completed',
        scanned: last.total, pages: 0, imported: last.imported, updated: last.updated, skipped: last.skipped,
        startedAt: last.started_at ? new Date(last.started_at * 1000).toISOString() : null,
        finishedAt: last.finished_at ? new Date(last.finished_at * 1000).toISOString() : null, error: null, migrated: true } : null }
    saveDoubanState(store, state)
    store.db.exec('COMMIT')
    began = false
    return { entries: entries.length, movies: entries.filter(item => item.type === 'Movie').length,
      series: entries.filter(item => item.type === 'Series').length, images, checkpoint: checkpoint.date }
  } catch (error) {
    if (began) store.db.exec('ROLLBACK')
    throw error
  } finally { source.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, destination, posters] = process.argv.slice(2)
  if (!source || !destination) throw new Error('用法：import-pixelreel.mjs 来源SQLite 映览配置目录 [旧海报缓存目录]')
  if (existsSync(join(destination, 'desktop.lock'))) throw new Error('请先正常退出映览，再迁移数据')
  const store = new Store(destination)
  try { console.log(JSON.stringify(importPixelReel(source, store, posters))) } finally { store.close() }
}

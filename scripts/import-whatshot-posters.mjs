import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.js'
import { validateS3 } from '../src/poster-s3.js'

export function importWhatShotPosters(directory, store) {
  if (store.db.prepare("SELECT value FROM settings WHERE name='posterS3'").get()) throw new Error('映览已有 S3 配置，拒绝覆盖')
  const source = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'))
  const config = validateS3({ endpoint: source.s3Endpoint, bucket: source.s3Bucket, accessKey: source.s3AccessKey, secretKey: source.s3SecretKey })
  const db = new DatabaseSync(join(directory, 'whatshot.sqlite3'), { readOnly: true })
  try {
    const prefix = `${config.endpoint}/${config.bucket}/`
    const matches = new Map()
    for (const row of db.prepare('SELECT douban_id,poster_url FROM videos WHERE douban_id IS NOT NULL').all()) {
      if (!row.poster_url?.startsWith(prefix)) continue
      const key = row.poster_url.slice(prefix.length)
      if (!/^posters\/[0-9]+\.jpg$/.test(key)) continue
      const id = String(row.douban_id)
      if (!matches.has(id)) matches.set(id, new Set())
      matches.get(id).add(key)
    }
    let reused = 0
    store.db.exec('BEGIN')
    try {
      store.db.prepare("INSERT INTO settings VALUES('posterS3',?)").run(store.encrypt(config))
      for (const row of store.db.prepare("SELECT id FROM douban_items WHERE coalesce(json_extract(data,'$.posterUrl'),'')=''").all()) {
        const keys = matches.get(row.id)
        if (keys?.size !== 1) continue
        store.db.prepare('INSERT INTO douban_poster_mirrors VALUES(?,?)').run(row.id, [...keys][0])
        reused++
      }
      store.db.exec('COMMIT')
    } catch (error) { store.db.exec('ROLLBACK'); throw error }
    return { configured: true, reused }
  } finally { db.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, target] = process.argv.slice(2)
  if (!source || !target) throw new Error('用法：import-whatshot-posters.mjs WhatShot配置目录 映览配置目录')
  if (existsSync(join(target, 'desktop.lock'))) throw new Error('请先正常退出映览')
  const store = new Store(target)
  try { console.log(importWhatShotPosters(source, store)) } finally { store.close() }
}

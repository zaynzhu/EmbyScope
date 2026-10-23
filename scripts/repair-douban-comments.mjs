import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDoubanPage } from '../src/douban-parser.js'
import { copyDataDirectory } from '../desktop/backend/data-transfer.js'

// 只处理已确认的旧采集错误，不改变普通同步的补空策略。
export function planCommentRepair(records, pages, account, repairedAt = new Date().toISOString()) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(account || '') || !pages.length) throw new Error('缺少有效账号或来源页面')
  const sources = new Map()
  for (const html of pages) {
    if (!html.includes(`href="/people/${account}/collect"`)) throw new Error('来源账号无法核对')
    const blocks = [...html.matchAll(/<li\b[^>]*id=["']list(\d+)["'][^>]*>([\s\S]*?)<\/li\s*>/gi)]
    // 豆瓣的“有用”计数不是用户短评内容。
    const cleaned = html.replace(/<span\b[^>]*class=["']pl["'][^>]*>[\s\S]*?<\/span\s*>/gi, '')
    for (const item of parseDoubanPage(cleaned)) {
      const block = blocks.find(match => match[1] === item.id)?.[2]
      if (!block || !new RegExp(`<div\\b[^>]*id=["']grid${item.id}["'][^>]*data-cid=["']\\d+["'][^>]*class=["']hide comment-item["']`).test(block) || !item.intro) {
        throw new Error('来源条目身份或详细容器不完整')
      }
      if (item.comment === null && !/<\/span>\s*(?:<br\s*\/?>)?\s*<\/div>\s*(?:<div\s+class=["']comment["']>\s*<\/div>\s*)?<\/div>\s*$/i.test(block)) {
        throw new Error('空短评结构无法确认，拒绝清除旧值')
      }
      if (sources.has(item.id)) throw new Error('来源包含重复条目，拒绝猜测')
      sources.set(item.id, item)
    }
  }
  const changes = []
  for (const record of records) {
    const old = JSON.parse(record.data)
    if (!old.comment?.trim() || old.comment.trim() !== old.intro?.trim()) continue
    const source = sources.get(record.id)
    if (old.id !== record.id || !source || source.date !== old.date || source.rating !== old.rating) throw new Error('异常条目未匹配或日期评分变化，未修复任何数据')
    if (source.comment && source.comment.trim() === source.intro.trim()) throw new Error('来源短评仍与影视信息相同')
    const next = { ...old, comment: source.comment,
      commentRepair: { previousComment: old.comment, previousPersonalComment: old.personalComment ?? null,
        repairedAt, source: 'douban-collect', sourceCommentPresent: source.comment !== null } }
    if (old.personalComment === old.comment) next.personalComment = source.comment
    changes.push({ id: record.id, before: record.data, after: JSON.stringify(next), hasComment: source.comment !== null })
  }
  return changes
}

export function applyCommentRepair(db, changes, originalState) {
  db.exec('BEGIN IMMEDIATE')
  try {
    if (db.prepare("SELECT value FROM settings WHERE name='doubanState'").get()?.value !== originalState) throw new Error('豆瓣账号或同步状态已变化')
    for (const change of changes) {
      if (db.prepare('SELECT data FROM douban_items WHERE id=?').get(change.id)?.data !== change.before) throw new Error('条目已变化，整批修复回滚')
      db.prepare('UPDATE douban_items SET data=? WHERE id=?').run(change.after, change.id)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, snapshotDirectory, mode] = process.argv.slice(2)
  if (!directory || !snapshotDirectory || (mode && mode !== '--apply')) throw new Error('用法：repair-douban-comments.mjs 映览配置目录 原始页面目录 [--apply]')
  if (existsSync(join(directory, 'desktop.lock'))) throw new Error('请先正常退出映览，再预览或修复')
  if (existsSync(join(directory, 'offline-preview'))) throw new Error('离线预览数据不执行来源修复')
  const files = readdirSync(snapshotDirectory).filter(name => /^page-\d+\.html$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))
  const pages = files.map(name => readFileSync(join(snapshotDirectory, name), 'utf8'))
  const db = new DatabaseSync(join(directory, 'embyscope.sqlite'), { readOnly: mode !== '--apply' })
  try {
    const state = db.prepare("SELECT value FROM settings WHERE name='doubanState'").get()?.value
    const account = state && JSON.parse(state).account
    const changes = planCommentRepair(db.prepare('SELECT id,data FROM douban_items').all(), pages, account)
    const summary = { candidates: changes.length, restored: changes.filter(c => c.hasComment).length, withoutComment: changes.filter(c => !c.hasComment).length, applied: false }
    if (mode === '--apply' && changes.length) {
      const backup = join(snapshotDirectory, 'backup-before-repair')
      await copyDataDirectory(directory, backup)
      writeFileSync(join(snapshotDirectory, 'repair-audit.json'), JSON.stringify({ account, backup, changes,
        pages: files.map((name, i) => ({ name, sha256: createHash('sha256').update(pages[i]).digest('hex') })) }, null, 2), { mode: 0o600, flag: 'wx' })
      if (existsSync(join(directory, 'desktop.lock'))) throw new Error('应用已重新启动，请退出后重试')
      applyCommentRepair(db, changes, state)
      summary.applied = true
    }
    console.log(JSON.stringify(summary))
  } finally { db.close() }
}

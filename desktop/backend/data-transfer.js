import { DatabaseSync, backup } from 'node:sqlite'
import { createDecipheriv } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, chmodSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

function destinationPath(value) {
  let parent = resolve(value)
  const missing = []
  while (!existsSync(parent)) {
    missing.unshift(basename(parent))
    parent = dirname(parent)
  }
  return join(realpathSync(parent), ...missing)
}

// 源连接只读；SQLite backup 包含已提交的 WAL，不复制运行中的主文件。
export async function copyDataDirectory(sourceDirectory, destinationDirectory, { offlinePreview = false } = {}) {
  const source = realpathSync(sourceDirectory)
  const destination = destinationPath(destinationDirectory)
  if (existsSync(destination)) throw new Error('目标目录已存在，拒绝覆盖')
  if (destination.startsWith(source + sep)) throw new Error('目标不能位于源配置目录内')
  const key = readFileSync(join(source, 'secret.key'))
  if (key.length !== 32) throw new Error('配置密钥无效')
  const sourceDb = new DatabaseSync(join(source, 'embyscope.sqlite'), { readOnly: true })
  let stage
  let copiedDb
  try {
    sourceDb.exec('PRAGMA query_only=ON')
    if (sourceDb.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('源数据库校验失败')
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    stage = mkdtempSync(join(dirname(destination), '.embyscope-transfer-'))
    chmodSync(stage, 0o700)
    const databasePath = join(stage, 'embyscope.sqlite')
    await backup(sourceDb, databasePath)
    chmodSync(databasePath, 0o600)
    writeFileSync(join(stage, 'secret.key'), key, { mode: 0o600, flag: 'wx' })
    copiedDb = new DatabaseSync(databasePath)
    if (copiedDb.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('复制件校验失败')
    // 确认密钥与快照匹配，只验证解密，不输出或另存明文。
    for (const row of copiedDb.prepare('SELECT secret FROM servers').iterate()) {
      const bytes = Buffer.from(row.secret, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString())
    }
    if (!key.equals(readFileSync(join(source, 'secret.key')))) throw new Error('复制期间密钥变化，请重试')
    if (offlinePreview) {
      copiedDb.exec("BEGIN; DELETE FROM sessions; INSERT OR REPLACE INTO settings VALUES('automaticUpdates','false'); COMMIT")
      writeFileSync(join(stage, 'offline-preview'), '离线导入预览：退出应用后移除此文件才能允许远端读取。\n', { mode: 0o600, flag: 'wx' })
    } else if (existsSync(join(source, 'offline-preview'))) {
      writeFileSync(join(stage, 'offline-preview'), '离线预览\n', { mode: 0o600, flag: 'wx' })
    }
    const result = {
      servers: copiedDb.prepare('SELECT count(*) AS count FROM servers').get().count,
      entries: copiedDb.prepare("SELECT coalesce(sum(json_array_length(data)),0) AS count FROM cache WHERE kind='catalog'").get().count,
      images: copiedDb.prepare('SELECT count(*) AS count FROM images').get().count,
      offlinePreview: existsSync(join(stage, 'offline-preview'))
    }
    copiedDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copiedDb.close()
    copiedDb = null
    if (existsSync(destination)) throw new Error('目标目录已出现，拒绝覆盖')
    renameSync(stage, destination)
    stage = null
    return result
  } finally {
    copiedDb?.close()
    sourceDb.close()
    if (stage) rmSync(stage, { recursive: true, force: true })
  }
}

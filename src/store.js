import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const keyPath = join(directory, 'secret.key')
    const dbPath = join(directory, 'embyscope.sqlite')
    if (!existsSync(keyPath)) {
      if (existsSync(dbPath)) throw new Error('配置密钥丢失，请恢复完整配置目录备份')
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' })
    }
    this.key = readFileSync(keyPath)
    if (this.key.length !== 32) throw new Error('配置密钥长度不正确')
    chmodSync(keyPath, 0o600)
    this.db = new DatabaseSync(dbPath)
    chmodSync(dbPath, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES('automaticUpdates', 'false');
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
        secret TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending', error TEXT, attemptedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS cache (
        serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, data TEXT NOT NULL, updatedAt TEXT NOT NULL,
        error TEXT, PRIMARY KEY(serverId, kind)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        mode TEXT NOT NULL, trigger TEXT NOT NULL, startedAt TEXT NOT NULL,
        finishedAt TEXT, state TEXT NOT NULL, steps TEXT NOT NULL, message TEXT
      );
      CREATE TABLE IF NOT EXISTS images (
        serverId TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        itemId TEXT NOT NULL, tag TEXT NOT NULL, mime TEXT NOT NULL,
        data BLOB NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(serverId, itemId, tag)
      );
      CREATE TABLE IF NOT EXISTS douban_items (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS douban_images (
        id TEXT PRIMARY KEY REFERENCES douban_items(id), url TEXT NOT NULL,
        mime TEXT NOT NULL, data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS douban_poster_attempts (
        id TEXT PRIMARY KEY REFERENCES douban_items(id), attemptedAt TEXT NOT NULL, state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS douban_poster_mirrors (
        id TEXT PRIMARY KEY REFERENCES douban_items(id), objectKey TEXT NOT NULL
      );
    `)
    for (const [name, value] of [['lightMinutes', 60], ['fullHours', 24]]) {
      if (!this.db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === name)) {
        this.db.exec(`ALTER TABLE servers ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${value}`)
      }
    }
    if (!this.db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'proxyUrl')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN proxyUrl TEXT')
    }
    if (!this.db.prepare('PRAGMA table_info(servers)').all().some(column => column.name === 'nsfw')) {
      this.db.exec('ALTER TABLE servers ADD COLUMN nsfw INTEGER NOT NULL DEFAULT 0')
    }
  }

  encrypt(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
  }

  decrypt(value) {
    const bytes = Buffer.from(value, 'base64')
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
    cipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString())
  }

  server(id) { return this.db.prepare('SELECT * FROM servers WHERE id=?').get(id) }
  servers() { return this.db.prepare('SELECT * FROM servers ORDER BY rowid').all() }
  cache(id, kind) {
    const row = this.db.prepare('SELECT * FROM cache WHERE serverId=? AND kind=?').get(id, kind)
    return row ? { ...row, data: JSON.parse(row.data) } : null
  }
  saveCache(id, kind, data) {
    this.db.prepare(`INSERT INTO cache VALUES(?,?,?,?,NULL)
      ON CONFLICT(serverId,kind) DO UPDATE SET data=excluded.data, updatedAt=excluded.updatedAt,error=NULL`)
      .run(id, kind, JSON.stringify(data), new Date().toISOString())
  }
  close() { this.db.close() }
}

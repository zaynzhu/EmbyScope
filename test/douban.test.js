import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/store.js'
import { RateLimiter } from '../src/emby.js'
import { DoubanService, saveDoubanState, readDoubanState, allowedPoster } from '../src/douban.js'
import { parseDoubanPage } from '../src/douban-parser.js'
import { importPixelReel } from '../scripts/import-pixelreel.mjs'
import { createApp } from '../src/server.js'

const item = (id, date = '2026-10-11', title = `电影${id}`) => `<li id="list${id}" class="item"><div class="title"><a href="https://movie.douban.com/subject/${id}/">${title} / Other</a></div><span class="intro">简介</span><span class="rating4-t"></span><div class="date">${date}</div><div class="comment">短评 &amp; &#x597d;</div></li>`
const html = (...items) => `<ul class="list-view">${items.join('')}</ul>`
function fixture(t, pages = []) {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-douban-'))
  const store = new Store(directory)
  const calls = []
  const service = new DoubanService(store, { limiter: new RateLimiter(1), fetchImpl: async url => {
    calls.push(Number(new URL(url).searchParams.get('start')))
    const page = pages[calls.length - 1] ?? html()
    return new Response(page instanceof Error ? '' : page, { status: page instanceof Error ? 403 : 200, headers: { 'Content-Type': 'text/html' } })
  } })
  saveDoubanState(store, { account: 'fixture-user', checkpoint: '2026-10-11', lastRun: null })
  t.after(async () => { await service.close(); store.close(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, store, service, calls }
}

test('豆瓣严格解析整页、实体解码，拒绝验证页和部分坏条目', () => {
  assert.equal(parseDoubanPage(html(item('1')))[0].comment, '短评 & 好')
  assert.equal(parseDoubanPage(html(item('1')))[0].type, 'Unknown')
  assert.deepEqual(parseDoubanPage(html()), [])
  for (const page of ['登录页', 'captcha', html(item('1'), '<li class="item">损坏</li>'), html(item('1', '2026-02-30'))]) assert.throws(() => parseDoubanPage(page))
})

test('豆瓣日期内嵌评分节点，短评不误取 comment-item 容器内容', () => {
  const page = html(`<li id="list123" class="item"><div class="item-show"><div class="title"><a href="https://movie.douban.com/subject/123/">测试片名</a></div><div class="date"><span class="rating5-t"></span>2026-10-11</div></div><div class="hide comment-item"><div class="grid-date"><span class="intro">导演和年份</span></div><div class="comment">真正的短评</div></div></li>`)
  const parsed = parseDoubanPage(page)[0]
  assert.equal(parsed.date, '2026-10-11')
  assert.equal(parsed.comment, '真正的短评')
  assert.equal(parsed.intro, '导演和年份')
  assert.equal(parsed.rating, 5)
})

test('豆瓣增量包含截止当天，按实际行数分页，整批提交后推进检查点', async t => {
  const f = fixture(t, [html(item('1', '2026-10-12'), item('2')), html(item('3'), item('4', '2026-10-10'))])
  f.service.start('incremental')
  assert.throws(() => f.service.start('full'), /正在进行/)
  await f.service.job
  assert.deepEqual(f.calls, [0, 2])
  assert.equal(f.service.status().total, 3)
  assert.equal(f.service.status().checkpoint, '2026-10-12')
  assert.equal(f.service.status().lastRun.imported, 3)
})

test('豆瓣全量保留原评分短评、只补空字段、不删除来源未再返回的条目', async t => {
  const f = fixture(t, [html(item('1', '2026-10-12')), html()])
  const old = { id: '1', type: 'Movie', title: '原片名', rating: 2, date: '2026-10-01', comment: '原短评', intro: null }
  f.store.db.prepare('INSERT INTO douban_items VALUES(?,?,?)').run('1', 'Movie', JSON.stringify(old))
  f.store.db.prepare('INSERT INTO douban_items VALUES(?,?,?)').run('2', 'Series', JSON.stringify({ id: '2', type: 'Series', title: '原剧集' }))
  f.service.start('full')
  await f.service.job
  const saved = JSON.parse(f.store.db.prepare("SELECT data FROM douban_items WHERE id='1'").get().data)
  assert.equal(saved.title, old.title)
  assert.equal(saved.rating, old.rating)
  assert.equal(saved.comment, old.comment)
  assert.equal(saved.intro, '简介')
  assert.equal(f.service.status().total, 2)
})

test('重复页、后续失败和日期乱序均不写入部分结果或推进检查点', async t => {
  for (const pages of [[html(item('1')), html(item('1'))], [html(item('1')), new Error('403')], [html(item('1', '2026-10-12'), item('2', '2026-10-13'))]]) {
    const f = fixture(t, pages)
    f.service.start('full')
    await f.service.job
    assert.equal(f.service.status().total, 0)
    assert.equal(f.service.status().checkpoint, '2026-10-11')
    assert.equal(f.service.status().lastRun.state, 'failed')
    assert.ok(f.calls.length <= 2)
  }
})

test('缺检查点拒绝增量且不联网，空增量保留检查点', async t => {
  const f = fixture(t, [html()])
  saveDoubanState(f.store, { account: 'fixture-user', checkpoint: null })
  assert.throws(() => f.service.start('incremental'), /缺少/)
  assert.equal(f.calls.length, 0)
  saveDoubanState(f.store, { account: 'fixture-user', checkpoint: '2026-10-11' })
  f.service.start('incremental')
  await f.service.job
  assert.equal(f.service.status().checkpoint, '2026-10-11')
  assert.equal(f.service.status().lastRun.state, 'completed')
})

test('同步取消后不发下一页、不提交数据，重启标记未完成任务', async t => {
  const f = fixture(t)
  f.service.fetchImpl = async () => { f.calls.push(0); f.service.cancel(); return new Response(html(item('1')), { headers: { 'Content-Type': 'text/html' } }) }
  f.service.start('full')
  await f.service.job
  assert.equal(f.calls.length, 1)
  assert.equal(f.service.status().total, 0)
  assert.equal(f.service.status().lastRun.state, 'cancelled')
  saveDoubanState(f.store, { account: 'fixture-user', checkpoint: '2026-10-11', lastRun: { state: 'running' } })
  const restarted = new DoubanService(f.store)
  assert.equal(restarted.status().lastRun.state, 'interrupted')
  assert.equal(restarted.status().checkpoint, '2026-10-11')
  await restarted.close()
})

test('分页筛选只读本地，离线阻止同步和图片请求，图片地址限定来源', async t => {
  const f = fixture(t)
  for (let i = 1; i <= 30; i++) f.store.db.prepare('INSERT INTO douban_items VALUES(?,?,?)').run(String(i), 'Movie', JSON.stringify({ id: String(i), type: 'Movie', title: `电影${i}`, date: '2026-10-11' }))
  assert.equal(f.service.list(new URLSearchParams('page=2')).items.length, 6)
  assert.equal(f.service.list(new URLSearchParams('q=电影30')).total, 1)
  assert.equal(f.service.list(new URLSearchParams('type=Series')).total, 0)
  assert.throws(() => f.service.configure({ account: 'other' }), /原豆瓣账号/)
  f.service.offline = () => true
  assert.throws(() => f.service.start('full'), /离线/)
  await assert.rejects(f.service.poster('1'), /没有本地海报/)
  assert.equal(f.calls.length, 0)
  assert.ok(allowedPoster('https://img1.doubanio.com/view/photo/test.jpg'))
  for (const url of ['http://img1.doubanio.com/a', 'https://127.0.0.1/a', 'https://img1.doubanio.com.evil.com/a', 'https://a:b@img1.doubanio.com/a', 'https://img1.doubanio.com/a?key=x']) assert.equal(allowedPoster(url), false)
})

function sourceFixture(path, duplicate = false) {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE source_account(source TEXT,account_identifier TEXT);
    INSERT INTO source_account VALUES('douban','fixture-user');
    CREATE TABLE app_setting(key TEXT,value TEXT);
    INSERT INTO app_setting VALUES('douban_harvest_checkpoint','{"accountIdentifier":"fixture-user","date":"2026-10-11"}');
    CREATE TABLE douban_pending_harvest(payload TEXT);
    CREATE TABLE sync_run(source TEXT,state TEXT,operation TEXT,finished_at INTEGER);
    CREATE TABLE movie(douban_id TEXT,title TEXT,status TEXT,douban_rating INTEGER,douban_date TEXT);
    CREATE TABLE tv_show(douban_id TEXT,title TEXT,status TEXT,douban_rating INTEGER,douban_date TEXT);
    INSERT INTO movie VALUES('1','电影','DONE',4,'2026-10-11');`)
  if (duplicate) db.exec("INSERT INTO tv_show VALUES('1','重复','DONE',4,'2026-10-11')")
  db.close()
}

test('迁移复制数据及账号绑定检查点，不修改源库、不允许二次覆盖', async t => {
  const f = fixture(t)
  const path = join(f.directory, 'source.sqlite')
  sourceFixture(path)
  const result = importPixelReel(path, f.store)
  assert.equal(result.entries, 1)
  assert.equal(readDoubanState(f.store).checkpoint, '2026-10-11')
  assert.throws(() => importPixelReel(path, f.store), /拒绝重复/)
  const source = new DatabaseSync(path, { readOnly: true })
  assert.equal(source.prepare('SELECT count(*) AS n FROM movie').get().n, 1)
  assert.equal(source.prepare("SELECT value FROM app_setting WHERE key='douban_harvest_checkpoint'").get().value, '{"accountIdentifier":"fixture-user","date":"2026-10-11"}')
  source.close()
})

test('迁移遇到跨表身份冲突时目标库不写入任何数据', async t => {
  const f = fixture(t)
  const path = join(f.directory, 'source.sqlite')
  sourceFixture(path, true)
  assert.throws(() => importPixelReel(path, f.store), /身份冲突/)
  assert.equal(f.service.status().total, 0)
  assert.equal(readDoubanState(f.store).importedAt, undefined)
})

test('豆瓣API遵循桌面认证、来源校验和离线边界', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'embyscope-douban-api-'))
  let calls = 0
  const key = 'a'.repeat(64)
  const app = createApp({ dataDir: directory, scheduler: false, desktopKey: key, offline: true,
    doubanOptions: { fetchImpl: async () => { calls++; throw new Error('不可联网') } } })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${app.server.address().port}`
  assert.equal((await fetch(base + '/api/douban/items')).status, 403)
  const headers = { 'X-EmbyScope-Desktop': key, 'Content-Type': 'application/json', 'X-EmbyScope': '1' }
  assert.equal((await fetch(base + '/api/douban/items', { headers })).status, 200)
  assert.equal((await fetch(base + '/api/douban/sync', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{"mode":"full"}' })).status, 403)
  assert.equal((await fetch(base + '/api/douban/sync', { method: 'POST', headers, body: '{"mode":"full"}' })).status, 409)
  assert.equal(calls, 0)
})

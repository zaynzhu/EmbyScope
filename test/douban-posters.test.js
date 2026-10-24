import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/store.js'
import { RateLimiter } from '../src/emby.js'
import { DoubanService, allowedPoster, saveDoubanState } from '../src/douban.js'
import { exactPoster } from '../src/douban-posters.js'
import { s3Request, validateS3 } from '../src/poster-s3.js'
import { importWhatShotPosters } from '../scripts/import-whatshot-posters.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfXkAAAAASUVORK5CYII=', 'base64')
const url = 'https://img3.doubanio.com/view/photo/a.jpg'
const config = { endpoint: 'https://storage.example', bucket: 'posters', accessKey: 'TEST_ACCESS', secretKey: 'TEST_SECRET', region: 'us-east-1' }
const collected = (id, date) => `<li id="list${id}" class="item"><div class="title"><a href="https://movie.douban.com/subject/${id}/">test${id}</a></div><div class="date">${date}</div><div class="comment">新短评</div></li>`
function fixture(t, s3 = false) {
  const dir = mkdtempSync(join(tmpdir(), 'poster-test-'))
  const store = new Store(dir)
  if (s3) store.db.prepare("INSERT INTO settings VALUES('posterS3',?)").run(store.encrypt(config))
  saveDoubanState(store, { account: 'test', checkpoint: '2026-10-11' })
  const originals = []
  for (const id of ['1', '2']) {
    const item = { id, type: 'Movie', title: 'test' + id, rating: 4, date: '2026-10-11', comment: '不可覆盖', posterUrl: null }
    store.db.prepare('INSERT INTO douban_items VALUES(?,?,?)').run(id, 'Movie', JSON.stringify(item))
    originals.push(item)
  }
  const service = new DoubanService(store, { limiter: new RateLimiter(1) })
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  return { store, service, originals, dir }
}

test('海报只接受精确ID唯一安全地址，标题同名与冲突不猜选', () => {
  assert.equal(exactPoster([{ id: '2', img: url }], '1', allowedPoster), null)
  assert.equal(exactPoster([{ id: '1', img: url }, { id: '1', img: url }], '1', allowedPoster), url)
  assert.equal(exactPoster([{ id: '1', img: url }, { id: '1', img: url + 'x' }], '1', allowedPoster), null)
  assert.equal(exactPoster([{ id: '1', img: 'http://127.0.0.1/a' }], '1', allowedPoster), null)
  assert.throws(() => exactPoster({}, '1', allowedPoster))
})

test('增量成功后自动下载本次缺图并镜像S3，不扫描截止日期前的旧库', async t => {
  const f = fixture(t, true)
  const queries = []
  f.service.fetchImpl = async input => {
    const target = new URL(input)
    if (target.pathname.endsWith('/collect')) return new Response(`<ul class="list-view">${collected('3', '2026-10-12')}${collected('9', '2026-10-10')}</ul>`, { headers: { 'Content-Type': 'text/html' } })
    if (target.pathname === '/j/subject_suggest') {
      queries.push(target.searchParams.get('q'))
      return Response.json([{ id: '3', img: url }])
    }
    if (target.hostname === 'storage.example') return new Response('')
    return new Response(png)
  }
  f.service.start('incremental')
  await f.service.job
  await f.service.posters.job
  assert.deepEqual(queries, ['test3'])
  assert.equal(f.service.status().lastRun.state, 'completed')
  assert.equal(f.service.status().checkpoint, '2026-10-12')
  assert.equal(f.service.status().posters.lastRun.total, 1)
  assert.equal(f.service.status().posters.lastRun.state, 'completed')
  assert.equal(f.service.status().posters.cached, 1)
  assert.equal(f.service.status().posters.mirrored, 1)
  assert.equal(JSON.parse(f.store.db.prepare("SELECT data FROM douban_items WHERE id='3'").get().data).comment, '新短评')
  for (const old of f.originals) assert.deepEqual(JSON.parse(f.store.db.prepare('SELECT data FROM douban_items WHERE id=?').get(old.id).data), old)
})

test('自动补图失败不回滚已提交的增量，重试增量可修复同日已有缺图', async t => {
  const f = fixture(t)
  let blocked = true
  let queries = 0
  f.service.fetchImpl = async input => {
    const target = new URL(input)
    if (target.pathname.endsWith('/collect')) return new Response(`<ul class="list-view">${collected('3', '2026-10-12')}${collected('9', '2026-10-10')}</ul>`, { headers: { 'Content-Type': 'text/html' } })
    if (target.pathname === '/j/subject_suggest') {
      queries++
      return blocked ? new Response('', { status: 403 }) : Response.json([{ id: '3', img: url }])
    }
    return new Response(png)
  }
  f.service.start('incremental')
  await f.service.job
  await f.service.posters.job
  assert.equal(queries, 1)
  assert.equal(f.service.status().lastRun.state, 'completed')
  assert.equal(f.service.status().checkpoint, '2026-10-12')
  assert.equal(f.service.status().total, 3)
  assert.equal(f.service.status().posters.lastRun.state, 'failed')
  blocked = false
  f.service.start('incremental')
  await f.service.job
  await f.service.posters.job
  assert.equal(f.service.status().lastRun.imported, 0)
  assert.equal(f.service.status().posters.cached, 1)
  assert.equal(queries, 2)
  f.service.start('incremental')
  await f.service.job
  assert.equal(f.service.posters.job, null)
  assert.equal(queries, 2)
})

test('补图下载后保存本地并上传S3，其他个人字段和检查点不变，可离线读取', async t => {
  const f = fixture(t, true)
  const uploads = []
  f.service.fetchImpl = async (input, options) => {
    const target = new URL(input)
    if (target.pathname === '/j/subject_suggest') return Response.json([{ id: target.searchParams.get('q').slice(-1), img: url }])
    if (target.hostname === 'storage.example') { uploads.push({ target, options }); return new Response('') }
    assert.equal(options.headers.Referer, 'https://movie.douban.com/')
    return new Response(png)
  }
  f.service.posters.start()
  assert.throws(() => f.service.start('full'), /海报/)
  await f.service.posters.job
  assert.equal(f.service.status().posters.lastRun.state, 'completed')
  assert.equal(uploads.length, 2)
  assert.equal(uploads[0].options.redirect, 'manual')
  assert.match(uploads[0].target.pathname, /\/posters\/embyscope\/douban\/1\/[a-f0-9]{64}\.png$/)
  assert.ok(uploads[0].options.headers.Authorization.startsWith('AWS4-HMAC-SHA256 '))
  for (const old of f.originals) {
    const now = JSON.parse(f.store.db.prepare('SELECT data FROM douban_items WHERE id=?').get(old.id).data)
    assert.deepEqual({ ...now, posterUrl: null }, old)
  }
  assert.equal(f.service.status().checkpoint, '2026-10-11')
  assert.equal(JSON.stringify(f.service.status()).includes('TEST_SECRET'), false)
  f.service.offline = () => true
  assert.deepEqual(Buffer.from((await f.service.poster('1')).buffer), png)
})

test('S3失败保留本地图片，续跑不重新查找下载，未尝试条目优先', async t => {
  const f = fixture(t, true)
  const queries = []
  let fail = true
  f.service.fetchImpl = async input => {
    const target = new URL(input)
    if (target.hostname === 'storage.example') return new Response('', { status: fail ? 403 : 200 })
    if (target.pathname === '/j/subject_suggest') {
      const id = target.searchParams.get('q').slice(-1)
      queries.push(id)
      return Response.json([{ id, img: url }])
    }
    return new Response(png)
  }
  f.service.posters.start()
  await f.service.posters.job
  assert.equal(f.service.status().posters.lastRun.state, 'failed')
  assert.equal(f.service.status().posters.cached, 1)
  assert.equal(f.service.status().posters.pendingMirror, 1)
  fail = false
  f.service.posters.start()
  await f.service.posters.job
  assert.deepEqual(queries, ['1', '2'])
  assert.equal(f.service.status().posters.mirrored, 2)
})

test('查询403立即停止、取消不提交，重启保留尝试顺序且不自动联网', async t => {
  const f = fixture(t)
  let count = 0
  f.service.fetchImpl = async () => { count++; return new Response('', { status: 403 }) }
  f.service.posters.start()
  await f.service.posters.job
  assert.equal(count, 1)
  assert.equal(f.service.status().posters.cached, 0)
  f.service.fetchImpl = async () => { f.service.posters.cancel(); return Response.json([{ id: '2', img: url }]) }
  f.service.posters.start()
  await f.service.posters.job
  assert.equal(f.service.status().posters.lastRun.state, 'cancelled')
  assert.equal(f.service.status().posters.cached, 0)
  f.store.db.prepare("UPDATE settings SET value=? WHERE name='doubanPosterRun'").run(JSON.stringify({ state: 'running' }))
  const restarted = new DoubanService(f.store, { fetchImpl: async () => { throw Error('不可联网') } })
  assert.equal(restarted.status().posters.lastRun.state, 'interrupted')
  await restarted.close()
})

test('未匹配不阻塞后续，非图片响应不得写入海报地址或缓存', async t => {
  const f = fixture(t)
  f.service.fetchImpl = async input => {
    const target = new URL(input)
    if (target.searchParams.get('q') === 'test1') return Response.json([])
    if (target.hostname === 'm.douban.com') return new Response('', { status: 404 })
    if (target.pathname === '/j/subject_suggest') return Response.json([{ id: '2', img: url }])
    return new Response('<html>not image</html>')
  }
  f.service.posters.start()
  await f.service.posters.job
  assert.equal(f.service.status().posters.lastRun.unmatched, 1)
  assert.equal(f.service.status().posters.lastRun.state, 'failed')
  assert.equal(f.service.status().posters.cached, 0)
  assert.equal(f.service.status().posters.missing, 2)
})

test('S3签名固定时间稳定、端点及对象边界严格，秘密不写明文配置', () => {
  assert.throws(() => validateS3({ ...config, endpoint: 'http://public.example' }))
  assert.throws(() => validateS3({ ...config, endpoint: 'https://storage.example/path' }))
  assert.throws(() => s3Request(config, 'GET', '../config'))
  const request = s3Request(config, 'GET', 'posters/1.jpg', undefined, new Date('2026-10-23T00:00:00Z'))
  assert.equal(request.headers['x-amz-date'], '20261023T000000Z')
  assert.match(request.headers.Authorization, /Credential=TEST_ACCESS\/20261023\/us-east-1\/s3\/aws4_request/)
  assert.equal(request.headers.Authorization.includes(config.secretKey), false)
})

test('按需下载也镜像S3，上传失败仍显示本地海报并保留待上传数', async t => {
  const f = fixture(t, true)
  f.store.db.prepare('UPDATE douban_items SET data=? WHERE id=?').run(JSON.stringify({ ...f.originals[0], posterUrl: url }), '1')
  let uploads = 0
  f.service.fetchImpl = async input => {
    if (new URL(input).hostname === 'storage.example') { uploads++; return new Response('', { status: 503 }) }
    return new Response(png)
  }
  assert.deepEqual((await f.service.poster('1')).buffer, png)
  assert.equal(uploads, 1)
  assert.equal(f.service.status().posters.pendingMirror, 1)
  assert.deepEqual(Buffer.from((await f.service.poster('1')).buffer), png)
  assert.equal(uploads, 1)
})

test('WhatShot只复制加密配置和精确ID唯一镜像，不改源库，读取走签名GET', async t => {
  const f = fixture(t)
  writeFileSync(join(f.dir, 'settings.json'), JSON.stringify({ s3Endpoint: config.endpoint, s3Bucket: config.bucket, s3AccessKey: config.accessKey, s3SecretKey: config.secretKey }))
  const source = new DatabaseSync(join(f.dir, 'whatshot.sqlite3'))
  source.exec("CREATE TABLE videos(douban_id INTEGER,poster_url TEXT)")
  source.prepare('INSERT INTO videos VALUES(?,?)').run(1, config.endpoint + '/posters/posters/99.jpg')
  source.close()
  assert.deepEqual(importWhatShotPosters(f.dir, f.store), { configured: true, reused: 1 })
  assert.equal(f.store.db.prepare("SELECT value FROM settings WHERE name='posterS3'").get().value.includes('TEST_SECRET'), false)
  assert.throws(() => importWhatShotPosters(f.dir, f.store), /拒绝覆盖/)
  const service = new DoubanService(f.store, { limiter: new RateLimiter(1), fetchImpl: async (input, options) => {
    assert.equal(new URL(input).pathname, '/posters/posters/99.jpg')
    assert.equal(options.method, 'GET')
    return new Response(png)
  } })
  assert.deepEqual((await service.poster('1')).buffer, png)
  await service.close()
})

test('建议接口未匹配时按精确豆瓣ID补查详情，404回退类型且不接受错误身份', async t => {
  const f = fixture(t)
  const paths = []
  f.service.fetchImpl = async input => {
    const target = new URL(input)
    paths.push(target.pathname)
    if (target.pathname === '/j/subject_suggest') return Response.json([])
    if (target.pathname === '/rexxar/api/v2/movie/1') return new Response('', { status: 404 })
    if (target.hostname === 'm.douban.com') return Response.json({ id: target.pathname.endsWith('/1') ? '1' : '999', pic: { large: url } })
    return new Response(png)
  }
  f.service.posters.start()
  await f.service.posters.job
  assert.equal(f.service.status().posters.cached, 1)
  assert.ok(paths.includes('/rexxar/api/v2/tv/1'))
  assert.equal(f.service.status().posters.lastRun.state, 'failed')
  assert.match(f.service.status().posters.lastRun.error, /身份不匹配/)
})

test('详情403停止且不尝试另一路径，之前未匹配条目跳过重复建议查询', async t => {
  const f = fixture(t)
  for (const id of ['1', '2']) f.store.db.prepare('INSERT INTO douban_poster_attempts VALUES(?,?,?)').run(id, '2026-10-11', 'unmatched')
  const paths = []
  f.service.fetchImpl = async input => { paths.push(new URL(input).pathname); return new Response('', { status: 403 }) }
  f.service.posters.start()
  await f.service.posters.job
  assert.deepEqual(paths, ['/rexxar/api/v2/movie/1'])
  assert.equal(f.service.status().posters.lastRun.state, 'failed')
})

test('S3设置读出不泄露凭据，空密钥保留、修改即时生效并在重启后持久化', async t => {
  const f = fixture(t, true)
  let calls = 0
  f.service.fetchImpl = async () => { calls++; throw Error('配置不应联网') }
  const result = f.service.s3.configure({ endpoint: config.endpoint + '/', bucket: config.bucket, region: 'eu-west-1', accessKey: '', secretKey: '' })
  assert.equal(result.endpoint, config.endpoint)
  assert.equal(result.credentialsConfigured, true)
  assert.equal(JSON.stringify(result).includes('TEST_ACCESS'), false)
  assert.equal(JSON.stringify(f.service.status()).includes('TEST_SECRET'), false)
  assert.equal(f.service.s3.config.accessKey, config.accessKey)
  assert.equal(f.service.s3.config.region, 'eu-west-1')
  assert.equal(calls, 0)
  const restarted = new DoubanService(f.store)
  assert.equal(restarted.s3.config.secretKey, config.secretKey)
  assert.equal(restarted.s3.config.region, 'eu-west-1')
  await restarted.close()
})

test('S3换桶不复用旧凭据或错误对象引用，保留本地图片并进入待上传', async t => {
  const f = fixture(t, true)
  f.store.db.prepare('INSERT INTO douban_poster_mirrors VALUES(?,?)').run('1', 'posters/99.jpg')
  const draft = { ...config, endpoint: 'https://new-storage.example', bucket: 'new-posters' }
  assert.throws(() => f.service.s3.configure({ ...draft, accessKey: '', secretKey: '' }), /重新填写/)
  assert.throws(() => f.service.s3.configure(draft), /未缓存到本地/)
  assert.equal(f.service.s3.config.endpoint, config.endpoint)
  f.store.db.prepare('INSERT INTO douban_images VALUES(?,?,?,?)').run('1', 's3:posters/99.jpg', 'image/png', png)
  f.service.s3.configure(draft)
  assert.equal(f.service.status().posters.mirrored, 0)
  assert.equal(f.service.status().posters.pendingMirror, 1)
  assert.deepEqual(Buffer.from((await f.service.poster('1')).buffer), png)
  assert.equal(f.service.status().checkpoint, '2026-10-11')
})

test('S3设置无效输入、离线和进行中的图片任务拒绝修改，失败保留旧配置', async t => {
  const f = fixture(t, true)
  for (const input of [null, [], { ...config, accessKey: 123 }, { ...config, secretKey: 'bad\nkey' }, { ...config, region: 'bad/region' }, { ...config, endpoint: 'http://public.example' }]) {
    assert.throws(() => f.service.s3.configure(input))
    assert.equal(f.service.s3.config.endpoint, config.endpoint)
  }
  f.service.posterJobs.set('1', Promise.resolve())
  assert.throws(() => f.service.s3.configure(config), /等待/)
  f.service.posterJobs.clear()
  f.service.offline = () => true
  assert.throws(() => f.service.s3.configure(config), /当前模式/)
})

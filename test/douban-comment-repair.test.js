import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { planCommentRepair, applyCommentRepair } from '../scripts/repair-douban-comments.mjs'

const record = (id, extra = {}) => ({ id, data: JSON.stringify({ id, title: '测试影视', type: 'Movie', intro: '影视介绍', comment: '影视介绍', personalComment: '影视介绍', rating: 4, date: '2026-10-11', posterUrl: '保留的海报', ...extra }) })
const block = (id, comment = '真实短评', extra = '') => `<li id="list${id}" class="item"><div class="title"><a href="https://movie.douban.com/subject/${id}/">测试影视</a></div><div class="date"><span class="rating4-t"></span>2026-10-11</div><div id="grid${id}" data-cid="123" class="hide comment-item"><div><span class="intro">影视介绍</span></div>${comment === null ? '' : `<div class="comment">${comment}${extra}</div>`}</div></li>`
const page = (...blocks) => `<a href="/people/fixture-user/collect">已看</a><ul class="list-view">${blocks.join('')}</ul>`
const plan = (rows, pages) => planCommentRepair(rows, pages, 'fixture-user', '2026-10-24T00:00:00Z')

test('只修复异常短评，保存旧值，去掉有用计数并保留其他字段和个人编辑', () => {
  const rows = [record('1'), record('2', { personalComment: '我另外编辑的短评' }), record('3', { comment: '正常旧短评' })]
  const changes = plan(rows, [page(block('1', '真实 &amp; 短评', '<span class="pl">(2 有用)</span>'), block('2'))])
  assert.equal(changes.length, 2)
  for (const change of changes) {
    const old = JSON.parse(change.before)
    const next = JSON.parse(change.after)
    assert.equal(next.commentRepair.previousComment, old.comment)
    assert.equal(next.commentRepair.sourceCommentPresent, true)
    for (const key of ['id', 'title', 'type', 'intro', 'rating', 'date', 'posterUrl']) assert.equal(next[key], old[key])
  }
  assert.equal(JSON.parse(changes[0].after).comment, '真实 & 短评')
  assert.equal(JSON.parse(changes[0].after).personalComment, '真实 & 短评')
  assert.equal(JSON.parse(changes[1].after).personalComment, '我另外编辑的短评')
  assert.deepEqual(plan(changes.map(c => ({ id: c.id, data: c.after })), [page(block('1'), block('2'))]), [])
})

test('完整来源未提供短评时清除错误介绍，旧原文保留在修复记录', () => {
  const changes = plan([record('1')], [page(block('1', null))])
  const next = JSON.parse(changes[0].after)
  assert.equal(next.comment, null)
  assert.equal(next.personalComment, null)
  assert.equal(next.commentRepair.previousComment, '影视介绍')
  assert.equal(next.commentRepair.sourceCommentPresent, false)
})

test('缺页、错账号、身份冲突、空结构和日期评分变化拒绝修复', () => {
  const good = page(block('1'))
  for (const html of [page(), good.replaceAll('fixture-user', 'other-user'), good.replace('list1', 'list2'), good.replace('grid1', 'grid2'), good.replace('data-cid="123"', ''), good.replace('2026-10-11', '2026-10-12'), good.replace('rating4-t', 'rating3-t'), good + '验证码', page(block('1', '影视介绍')), good.replace('class="comment"', 'class="new-comment"')]) {
    assert.throws(() => plan([record('1')], [html]))
  }
  assert.throws(() => plan([record('1')], [good, good]), /重复/)
  assert.throws(() => plan([record('1'), record('2')], [good]), /未匹配/)
})

test('写入前完整原值冲突或账号状态变化时整批回滚，成功不改检查点', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec("CREATE TABLE douban_items(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE settings(name TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('doubanState','original-state')")
    const rows = [record('1'), record('2')]
    for (const row of rows) db.prepare('INSERT INTO douban_items VALUES(?,?)').run(row.id, row.data)
    const changes = plan(rows, [page(block('1'), block('2', null))])
    assert.throws(() => applyCommentRepair(db, changes, 'changed-state'), /状态已变化/)
    db.prepare('UPDATE douban_items SET data=? WHERE id=?').run(record('2', { comment: '用户刚编辑' }).data, '2')
    assert.throws(() => applyCommentRepair(db, changes, 'original-state'), /回滚/)
    assert.equal(db.prepare("SELECT data FROM douban_items WHERE id='1'").get().data, rows[0].data)
    db.prepare('UPDATE douban_items SET data=? WHERE id=?').run(rows[1].data, '2')
    applyCommentRepair(db, changes, 'original-state')
    assert.equal(db.prepare("SELECT data FROM douban_items WHERE id='1'").get().data, changes[0].after)
    assert.equal(db.prepare("SELECT value FROM settings WHERE name='doubanState'").get().value, 'original-state')
  } finally { db.close() }
})

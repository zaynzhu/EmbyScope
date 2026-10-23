// 记录是旁路信息：写日志失败不能改变同步、缓存与调度的结果。
export class SyncHistory {
  constructor(store) {
    this.db = store.db
    this.available = true
    this.write(() => this.db.prepare("UPDATE sync_runs SET state='interrupted',finishedAt=?,message='上次退出时任务未完成，结果待重新确认' WHERE state='running'").run(new Date().toISOString()))
  }
  write(work) {
    try { return work() } catch {
      this.available = false
      console.error('同步记录写入失败，原同步流程继续')
    }
  }
  start(row, mode, trigger) {
    const run = { id: null, state: 'running', steps: [], message: null }
    run.id = this.write(() => this.db.prepare("INSERT INTO sync_runs(serverId,mode,trigger,startedAt,state,steps) VALUES(?,?,?,?,'running','[]')").run(row.id, mode, trigger, new Date().toISOString()).lastInsertRowid)
    return run
  }
  step(run, kind, count, error) {
    const code = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : null
    run.steps.push({ kind, state: error ? 'failed' : 'completed', count: error ? null : count,
      error: error ? code ? `读取失败（HTTP ${code}）` : '读取失败，连接或响应异常' : null })
    this.write(() => this.db.prepare('UPDATE sync_runs SET steps=? WHERE id=?').run(JSON.stringify(run.steps), run.id ?? -1))
  }
  async track(service, row, mode, trigger, work) {
    const run = this.start(row, mode, trigger)
    try { return await work(run) }
    catch (error) { run.state = 'failed'; run.message = '任务异常结束，未完整更新'; throw error }
    finally {
      if (run.state === 'running') {
        run.state = service.stopping ? 'interrupted' : !service.current(row) ? 'superseded' : 'cancelled'
        run.message = service.stopping ? '应用退出，任务未完成' : !service.current(row) ? '连接已变更，旧任务停止' : '自动更新已暂停，任务未完成'
      }
      this.write(() => {
        this.db.prepare('UPDATE sync_runs SET state=?,finishedAt=?,message=?,steps=? WHERE id=?')
          .run(run.state, new Date().toISOString(), run.message, JSON.stringify(run.steps), run.id ?? -1)
        this.db.exec("DELETE FROM sync_runs WHERE state!='running' AND id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 2000)")
      })
    }
  }
  list(rows) {
    const ids = new Set(rows.map(row => row.id))
    return { available: this.available, limit: 100, retained: 2000,
      items: this.db.prepare('SELECT r.*,s.name AS serverName FROM sync_runs r JOIN servers s ON s.id=r.serverId ORDER BY r.id DESC').all()
        .filter(row => ids.has(row.serverId)).slice(0, 100).map(row => ({ ...row, steps: JSON.parse(row.steps) })) }
  }
}

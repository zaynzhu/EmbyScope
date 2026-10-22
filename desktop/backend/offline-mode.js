import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { RemoteError } from '../../src/emby.js'

// 先暂停调度，再移除持久标记；失败时仍保留离线状态，不产生远端请求。
export function exitOfflinePreview(store, directory) {
  store.db.prepare("UPDATE settings SET value='false' WHERE name='automaticUpdates'").run()
  try { unlinkSync(join(directory, 'offline-preview')) } catch (error) {
    if (error.code !== 'ENOENT') throw new RemoteError('无法退出离线预览，请检查本地配置目录是否可写', 409)
  }
}

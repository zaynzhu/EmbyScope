import { copyDataDirectory } from './data-transfer.js'

const [mode, source, destination] = process.argv.slice(2)
if (!['import', 'backup'].includes(mode) || !source || !destination) {
  console.error('用法：manage-data.js import|backup 源配置目录 新目标目录')
  process.exitCode = 1
} else {
  try {
    const result = await copyDataDirectory(source, destination, { offlinePreview: mode === 'import' })
    console.log(JSON.stringify({ ok: true, ...result }))
  } catch {
    console.error('复制未完成。请检查源数据库与密钥是否完整，且目标目录不存在；源数据未修改。')
    process.exitCode = 1
  }
}

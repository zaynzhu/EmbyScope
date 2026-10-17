import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const checksums = readFileSync('bundle/SHA256SUMS', 'utf8')
const manifest = JSON.parse(readFileSync('bundle/manifest.json', 'utf8'))
writeFileSync('bundle/VERIFIED.json', JSON.stringify({
  commit: manifest.commit, run: manifest.run, platform: manifest.platform, imageId: manifest.imageId,
  validatedChecksumFileSha256: createHash('sha256').update(checksums).digest('hex'),
  checks: ['源码模拟接口测试', 'Compose 配置校验', 'amd64 构建和运行', '独立 runner 校验 SHA256 并 docker load', '包内 Compose 禁止拉取和构建启动', '首次初始化、鉴权与页面/API', '容器重启后持久化', '已有 bridge 网络覆盖配置解析'],
  unverified: ['真实 Emby 接口及版本兼容性', '极空间 NAS 实机', '完全断网运行（Emby 读取需要网络）'],
  verifiedAt: new Date().toISOString()
}, null, 2))
const report = readFileSync('bundle/VERIFIED.json')
writeFileSync('bundle/VERIFIED.sha256', `${createHash('sha256').update(report).digest('hex')}  VERIFIED.json\n`)

import { createHash, createHmac } from 'node:crypto'
import { RemoteError } from './emby.js'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value).digest()

export function validateS3(config) {
  let url
  try { url = new URL(config.endpoint) } catch { throw new Error('S3 端点无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('S3 端点必须为不含路径和凭据的 HTTP(S) 地址')
  if (url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|10\.[\d.]+|192\.168\.[\d.]+|172\.(1[6-9]|2\d|3[01])\.[\d.]+|[a-z\d.-]+\.local)$/.test(url.hostname)) throw new Error('S3 公网端点必须使用 HTTPS')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !config.accessKey || !config.secretKey) throw new Error('S3 配置不完整')
  return { ...config, endpoint: url.origin, region: config.region || 'us-east-1' }
}

// 移植 WhatShot 的 SigV4/path-style 签名，凭据不出本机 API，也不跟随重定向。
export function s3Request(config, method, key, body = Buffer.alloc(0), date = new Date()) {
  if (!/^(embyscope\/douban\/[0-9]+\/[a-f0-9]{64}\.(jpg|png|webp)|posters\/[0-9]+\.jpg)$/.test(key)) throw new Error('S3 海报对象路径无效')
  const url = new URL(`${config.endpoint}/${config.bucket}/${key}`)
  const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = timestamp.slice(0, 8)
  const digest = sha256(body)
  const headers = { host: url.host, 'x-amz-content-sha256': digest, 'x-amz-date': timestamp }
  const signed = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = [method, url.pathname, '', Object.entries(headers).map(([k, v]) => `${k}:${v}\n`).join(''), signed, digest].join('\n')
  const scope = `${day}/${config.region}/s3/aws4_request`
  const signing = hmac(hmac(hmac(hmac('AWS4' + config.secretKey, day), config.region), 's3'), 'aws4_request')
  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${hmac(signing, ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonical)].join('\n')).toString('hex')}`
  return { url, headers }
}

export class PosterS3 {
  constructor(service) {
    this.service = service
    const row = service.store.db.prepare("SELECT value FROM settings WHERE name='posterS3'").get()
    this.config = row ? validateS3(service.store.decrypt(row.value)) : null
  }
  async request(method, key, signal, bytes, mime) {
    const config = this.config
    if (!config) throw new RemoteError('尚未配置 S3 海报存储', 409)
    return this.service.limiter.run('poster-s3', async () => {
      signal.throwIfAborted()
      if (this.service.offline() || this.service.stopping) throw new RemoteError('当前模式不允许访问 S3', 409)
      const { url, headers } = s3Request(config, method, key, bytes)
      if (mime) headers['Content-Type'] = mime
      const response = await this.service.fetchImpl(url, { method, headers, body: method === 'PUT' ? bytes : undefined,
        redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) })
      if (!response.ok) {
        await response.body?.cancel()
        throw new RemoteError([401, 403].includes(response.status) ? 'S3 权限被拒绝，补图已停止' : `S3 读取或上传失败（HTTP ${response.status}），已保存图片仍可使用`, 502)
      }
      let size = 0
      const chunks = []
      for await (const chunk of response.body || []) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new RemoteError('S3 图片响应过大', 502)
        chunks.push(chunk)
      }
      signal.throwIfAborted()
      return Buffer.concat(chunks)
    }, signal)
  }
  async mirror(id, bytes, mime, signal) {
    if (!this.config) return null
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime]
    const key = `embyscope/douban/${id}/${sha256(bytes)}.${extension}`
    await this.request('PUT', key, signal, bytes, mime)
    return key
  }
}

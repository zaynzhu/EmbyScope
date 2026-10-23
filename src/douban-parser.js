import { RemoteError } from './emby.js'

export function validDoubanDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}

function plainText(value = '') {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    if (entities[entity.toLowerCase()]) return entities[entity.toLowerCase()]
    const number = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match
  }).replace(/\s+/g, ' ').trim()
}

// 复用 PixelReel macOS 的严格整页解析：结构变动不能伪装成空列表或跳过坏条目。
export function parseDoubanPage(html) {
  if (/访问频率|验证码|captcha|sec\.douban\.com/i.test(html)) throw new RemoteError('豆瓣要求验证或限制访问，已停止同步，请稍后在浏览器检查', 429)
  const list = html.match(/<ul\b[^>]*class\s*=\s*["'][^"']*\blist-view\b[^"']*["'][^>]*>([\s\S]*?)<\/ul\s*>/i)?.[1]
  const invalid = () => new RemoteError('豆瓣列表结构或日期异常，未写入数据和同步进度', 502)
  if (list === undefined) throw invalid()
  if (!list.trim()) return []
  const starts = [...list.matchAll(/<li\b([^>]*)>/gi)]
  const blocks = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)]
  if (!starts.length || starts.length !== blocks.length) throw invalid()
  return blocks.map((match, index) => {
    const attributes = starts[index][1]
    const id = attributes.match(/\bid\s*=\s*["']list(\d{1,20})["']/i)?.[1]
    const classes = attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]?.split(/\s+/) || []
    const block = match[1]
    const link = block.match(/href\s*=\s*["'](https:\/\/movie\.douban\.com\/subject\/(\d{1,20})\/)["']/i)
    const rawTitle = block.match(/<div\b[^>]*class\s*=\s*["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1]
    if (!id || !classes.includes('item') || !link || !rawTitle) throw invalid()
    const [title, ...otherTitles] = plainText(rawTitle).split(' / ')
    const field = name => block.match(new RegExp(`<(div|span)\\b[^>]*class\\s*=\\s*["'](?:[^"']*\\s)?${name}(?:\\s[^"']*)?["'][^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, 'i'))?.[2]
    const date = plainText(field('date')).match(/\d{4}-\d{2}-\d{2}/)?.[0]
    if (!title || title.length > 500 || !validDoubanDate(date)) throw invalid()
    const comment = plainText(field('comment'))
    const intro = plainText(field('intro'))
    if (comment.length > 10000 || intro.length > 10000) throw invalid()
    return { id: link[2], type: 'Unknown', title, altTitle: otherTitles.join(' / ') || null, intro: intro || null,
      rating: Number(block.match(/class\s*=\s*["'][^"']*\brating([1-5])-t\b/i)?.[1]) || null,
      date, comment: comment || null, link: link[1], posterUrl: null }
  })
}

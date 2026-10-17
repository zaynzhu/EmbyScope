// 仅展示服务端报告的绝对文件路径，不回传流地址、查询令牌和认证字段。
export function resourceLocations(item) {
  const locations = []
  let hiddenRemote = false
  for (const [index, source] of [{ Path: item.Path, Name: '条目位置' }, ...(Array.isArray(item.MediaSources) ? item.MediaSources : [])].entries()) {
    const path = source?.Path
    if (typeof path !== 'string' || !path.trim()) continue
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /[?#\u0000-\u001f]/.test(path) || path.includes('@') || !(/^(\/|[a-z]:[\\/]|\\\\)/i.test(path))) {
      hiddenRemote = true
      continue
    }
    if (locations.some(location => location.path === path)) continue
    locations.push({ path: path.slice(0, 8192), label: index ? `媒体版本 ${index}` : '条目位置' })
  }
  return { locations, hiddenRemote }
}

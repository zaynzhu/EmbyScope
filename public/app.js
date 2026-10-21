const app = document.querySelector('#app')
const dialog = document.querySelector('#dialog')
const state = { page: 'overview', server: 'all', servers: [], settings: { automaticUpdates: false }, query: '', type: '', duplicates: false, review: 'issues', libraryPage: 1, request: 0, authenticated: false, detail: null, blurNsfw: true, revealed: new Set() }
const titles = { overview: '概览', library: '片库', settings: '服务器设置' }
const statuses = { online: '在线', offline: '离线', partial: '部分可用', denied: '认证 / 权限异常', pending: '等待同步', error: '同步异常' }
const datasetNames = { catalog: '片库', views: '媒体库', latest: '最近入库', resume: '继续观看' }
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未同步'
const count = value => value == null ? '不可用' : value.toLocaleString('zh-CN')
const itemPath = item => `/api/items/${encodeURIComponent(item.serverId)}/${encodeURIComponent(item.id)}`
let toastTimer
let searchTimer

function toast(message) {
  const node = document.querySelector('#toast')
  node.textContent = message
  node.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.hidden = true }, 4500)
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-EmbyScope': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) {
    if (response.status === 401 && state.authenticated) {
      state.authenticated = false
      dialog.close()
      await boot()
    }
    throw new Error(data.error || '请求失败')
  }
  return data
}

function brand() {
  return '<div class="brand"><img src="/favicon.svg" alt=""><div><strong>映览</strong><small>EmbyScope</small></div></div>'
}

function shell() {
  app.innerHTML = `<div class="layout"><aside class="sidebar">${brand()}<div class="nav-caption">我的媒体空间</div>
    <nav aria-label="主要导航">${[['overview', '▦'], ['library', '▤'], ['settings', '⚙']].map(([key, icon]) => `<button data-nav="${key}" ${state.page === key ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${titles[key]}</button>`).join('')}</nav>
    <div class="sidebar-bottom"><small>个人媒体，清晰呈现</small><p>一个账号 · 多个 Emby<br>仅展示账号可见内容</p><button class="subtle" data-action="logout">退出登录</button></div></aside>
    <div><header class="topbar"><span class="topbar-label">我的媒体空间 / <span id="breadcrumb">${titles[state.page]}</span></span>
      <div class="server-switch"><button data-action="toggle-blur" aria-pressed="true">NSFW 海报：已虚化</button><label for="server-select">数据来源</label><select id="server-select" aria-label="选择服务器"></select><button class="subtle" data-action="logout" aria-label="退出登录">退出</button></div></header>
      <main id="content"><div class="empty">正在读取本地缓存…</div></main></div></div>`
  updateServers()
}

function updateServers() {
  const select = document.querySelector('#server-select')
  if (!select) return
  if (state.server !== 'all' && !state.servers.some(server => server.id === state.server)) state.server = 'all'
  select.innerHTML = `<option value="all">全部服务器 · 汇总视图</option>${state.servers.map(server => `<option value="${e(server.id)}">${e(server.name)}${server.nsfw ? ' · NSFW' : ''}</option>`).join('')}`
  select.value = state.server
}

function statusLabel(server) {
  return `<span class="status-label ${e(server.status)}"><i class="dot"></i>${server.syncing ? '同步中' : e(statuses[server.status] || server.status)}</span>`
}

function statusCards(servers) {
  return `<div class="status-list">${servers.map(server => `<div class="server-status"><div class="status-title"><strong>${e(server.name)}</strong>${statusLabel(server)}</div>
    <small>片库缓存 ${date(server.datasets.catalog.updatedAt)}${server.datasets.catalog.stale ? ' · 旧数据' : ''}</small>
    ${server.error ? `<small>${e(server.error)}</small>` : '<small>统计范围：当前 Emby 账号可见条目</small>'}
    <small>轻量更新 ${server.lightMinutes} 分钟 · 完整片库 ${server.fullHours ? `${server.fullHours} 小时` : '仅手动'}</small>
    ${server.catalogProgress ? `<small>目录读取：${server.catalogProgress.directories} / ${server.catalogProgress.discovered} 个已发现目录 · 已找到 ${count(server.catalogProgress.items)} 条媒体</small>` : ''}
    ${server.episodeSync ? `<small>单集核对：${server.episodeSync.completed} / ${server.episodeSync.series} 部剧 · ${server.episodeSync.syncing ? '后台补全中' : server.episodeSync.total === null ? '待补全' : '已核对'} · 已核对 ${count(server.episodeSync.knownEpisodes)} 集${server.episodeSync.failed ? ` · ${server.episodeSync.failed} 部读取异常` : ''}</small><small>按季接口集数汇总 · 最旧核对 ${date(server.episodeSync.updatedAt)}${server.episodeSync.stale ? ' · 旧数据' : ''} · 每 ${server.episodeSync.batchMinutes} 分钟最多 ${server.episodeSync.batchSize} 部 · 缓存 ${server.episodeSync.cacheHours} 小时</small>` : ''}</div>`).join('')}</div>`
}

function datasetNotice(servers, kind) {
  const errors = servers.filter(server => !server.datasets[kind].available || server.datasets[kind].stale || server.datasets[kind].warning)
  if (!errors.length) return ''
  return `<p class="notice">${errors.map(server => `${e(server.name)}：${e(server.datasets[kind].error || server.datasets[kind].warning || (server.datasets[kind].available ? '缓存待更新' : '尚无可用数据'))}${server.datasets[kind].updatedAt ? `（缓存 ${date(server.datasets[kind].updatedAt)}）` : ''}`).join('；')}</p>`
}

function sensitive(item) {
  return (item.sources || [item]).some(source => source.nsfw || state.servers.find(server => server.id === source.serverId)?.nsfw)
}

function posterButton(item, detail = false) {
  const key = `${item.serverId}:${item.id}`
  const nsfw = sensitive(item)
  const blurred = nsfw && state.blurNsfw && !state.revealed.has(key)
  return `<button class="poster${blurred ? ' blurred' : ''}" data-poster-key="${e(key)}" data-sensitive="${nsfw}" data-title="${e(item.title)}" ${detail ? '' : `data-item="${e(item.id)}" data-server="${e(item.serverId)}"`} aria-label="${blurred ? '解除此海报虚化' : `查看 ${e(item.title)}`}">${poster(item)}<span class="blur-label" ${blurred ? '' : 'hidden'}>NSFW · 点击显示</span></button>`
}

function updatePosters() {
  document.querySelectorAll('[data-poster-key]').forEach(button => {
    const blurred = button.dataset.sensitive === 'true' && state.blurNsfw && !state.revealed.has(button.dataset.posterKey)
    button.classList.toggle('blurred', blurred)
    button.querySelector('.blur-label').hidden = !blurred
    button.setAttribute('aria-label', blurred ? '解除此海报虚化' : `查看 ${button.dataset.title}`)
  })
  document.querySelectorAll('[data-action="toggle-blur"]').forEach(button => {
    button.textContent = state.blurNsfw ? 'NSFW 海报：已虚化' : 'NSFW 海报：已显示'
    button.setAttribute('aria-pressed', String(state.blurNsfw))
  })
}

function poster(item) {
  return `<span class="poster-placeholder"><b aria-hidden="true">映</b>暂无海报</span>${item.imageTag ? `<img src="${itemPath(item)}/poster" alt="${e(item.title)}海报" loading="lazy">` : ''}`
}

function mediaCards(items, resume = false) {
  if (!items.length) return '<div class="empty">暂无可展示内容。接口未提供数据时，不推断为已看完或数量为零。</div>'
  return `<div class="poster-grid">${items.map(item => {
    const sources = item.sources || [item]
    const progress = resume && item.runtimeTicks > 0 && item.positionTicks !== null ? Math.min(100, Math.max(0, item.positionTicks / item.runtimeTicks * 100)) : null
    return `<article class="media-card">${posterButton(item)}
      <button class="card-title" data-item="${e(item.id)}" data-server="${e(item.serverId)}" title="${e(item.title)}">${e(item.title)}</button>
      <div class="card-meta"><span>${item.year ?? '年份未知'} · ${{ Movie: '电影', Series: '电视剧', Episode: '单集', Season: '季' }[item.type] || '媒体'}</span><span class="rating">${item.rating != null ? `★ ${item.rating.toFixed(1)}` : ''}</span></div>
      <div class="sources">${sources.map(source => `<button class="source" data-item="${e(source.id)}" data-server="${e(source.serverId)}" title="查看此服务器条目">${e(source.serverName || state.servers.find(server => server.id === source.serverId)?.name || '服务器')}${source.nsfw || state.servers.find(server => server.id === source.serverId)?.nsfw ? ' · NSFW' : ''}</button>`).join('')}</div>
      ${sources.length > 1 ? `<button class="duplicate-count" data-item="${e(item.id)}" data-server="${e(item.serverId)}">同作品 ${sources.length} 条媒体库记录 · 查看对照</button>` : ''}
      ${item.conflict ? '<div class="conflict">编号冲突 · 独立保留</div>' : ''}
      ${progress !== null ? `<progress value="${progress}" max="100" aria-label="当前账号观看进度"></progress><small>已观看 ${Math.round(progress)}%</small>` : ''}</article>`
  }).join('')}</div>`
}

function heading(title, description, buttons = '') {
  return `<div class="page-heading"><div><h1>${title}</h1><p>${description}</p></div><div class="actions">${buttons}</div></div>`
}

function emptyConnections() {
  return '<div class="panel"><div class="empty"><h2>连接媒体，开始映览</h2><p>添加你的 Emby 地址与账号，媒体概览会在首次同步后出现。</p><button class="primary" data-action="add">添加服务器</button></div></div>'
}

function overview(data) {
  const stats = data.stats
  const title = state.server === 'all' ? '媒体概览' : `${e(data.servers[0]?.name)} · 概览`
  if (!state.servers.length) return heading('媒体概览', '你的媒体收藏，在这里汇合。') + emptyConnections()
  return heading(title, '你的媒体收藏，在这里汇合。', '<button data-action="refresh">↻ 更新概览</button><button data-action="full-refresh">完整校准片库</button><button class="primary" data-nav="library">浏览片库</button>') +
    statusCards(data.servers) +
    `<div class="stats">${[['媒体库', stats.libraries, '当前账号可见'], ['电影', stats.movies, '各服条目合计'], ['电视剧', stats.series, '各服条目合计'], ['单集', stats.episodes, '各服条目合计'], ['作品条目', stats.entries, '电影 + 电视剧'], ['去重作品', stats.uniqueWorks, '按有效编号匹配']].map(([name, value, hint], index) => `<div class="stat ${index === 5 ? 'accent' : ''}"><small>${name}</small><strong>${count(value)}</strong><span>${hint}</span></div>`).join('')}</div>
    <p class="notice">${stats.complete ? '统计覆盖全部所选服务器的可用缓存。' : `当前 ${stats.knownServers} / ${stats.totalServers} 台服务器具有片库缓存，数值为已知部分合计。`}${data.servers.some(server => server.episodeSync?.total === null) ? ' 单集总数正在按季接口补全，尚未核对完时显示不可用。' : ''}${stats.limitedServers ? ` ${stats.limitedServers} 台服务器未遵循筛选条件，无法确认完整片库及单集总数。` : ''} 轻量数据与片库分开更新，周期见服务器状态。${stats.conflicts ? ` 有 ${stats.conflicts} 个编号冲突条目独立保留。` : ''} 编号缺失时不按同名合并；去重作品数包含无法确认是否重复的独立条目。</p>
    <p class="notice">有 ${count(stats.duplicateGroups)} 部作品匹配到多条媒体库记录；按每部作品只计 1 条后，多出 ${count(stats.extraEntries)} 条记录。<button data-action="duplicates">重复与刮削排查</button> 这是整部作品的编号归组，不是重复文件检测；不同季也可能在同一组。排查页会另行区分季范围与元数据疑点。</p>
    <section class="panel"><div class="section-title"><h2>我的媒体库</h2><small>当前账号的顶层媒体库</small></div>${datasetNotice(data.servers, 'views')}
    ${data.views.length ? `<div class="libraries">${data.views.map(view => `<div class="library-tile"><span class="library-symbol" aria-hidden="true">${view.type === 'tvshows' ? '▤' : '▥'}</span><div><strong>${e(view.name)}</strong><small>${e(view.serverName)}</small></div></div>`).join('')}</div>` : '<div class="empty">暂无可用媒体库</div>'}</section>
    <section class="panel"><div class="section-title"><h2>最近入库</h2><small>按各服入库时间合并 · 最多 24 条</small></div>${datasetNotice(data.servers, 'latest')}${mediaCards(data.latest)}</section>
    <section class="panel"><div class="section-title"><h2>继续观看</h2><small>各服当前账号 · 只展示进度</small></div>${datasetNotice(data.servers, 'resume')}${mediaCards(data.resume, true)}</section>
    <section class="panel history"><div><h2>播放统计与趋势</h2><p>${e(stats.historyReason)}</p></div><strong>播放次数 / 时长 / 排行 / 趋势：不可用</strong></section>`
}

function library(data) {
  return heading(state.duplicates ? '重复与刮削排查' : '我的片库', '跨服务器浏览电影与电视剧，每个来源都清晰可查。', '<button data-action="refresh">↻ 更新概览</button><button data-action="full-refresh">完整校准片库</button>') +
    `<form class="filters" id="search-form"><label>搜索作品<input id="search" name="q" type="search" placeholder="输入电影或电视剧名称" value="${e(state.query)}" maxlength="200"></label>
    <label>服务器<select id="library-server-select" aria-label="片库服务器"><option value="all">全部服务器 · 汇总</option>${state.servers.map(server => `<option value="${e(server.id)}" ${state.server === server.id ? 'selected' : ''}>${e(server.name)}${server.nsfw ? ' · NSFW' : ''}</option>`).join('')}</select></label>
    <label>条目范围<select id="duplicate-select"><option value="all">全部作品</option><option value="duplicates" ${state.duplicates ? 'selected' : ''}>重复与刮削排查</option></select></label>
    ${state.duplicates ? `<label>排查范围<select id="review-select">${[['issues', '需核对'], ['resources', '资源重复线索'], ['metadata', '元数据疑点'], ['unknown', '季范围待确认'], ['all', '全部关联（含不同季）']].map(([value, label]) => `<option value="${value}" ${state.review === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
    <label>媒体类型<select id="type-select"><option value="">全部类型</option><option value="Movie" ${state.type === 'Movie' ? 'selected' : ''}>电影</option><option value="Series" ${state.type === 'Series' ? 'selected' : ''}>电视剧</option></select></label><button type="submit">搜索</button></form>
    ${statusCards(data.servers)}${datasetNotice(data.servers, 'catalog')}
    <section class="panel"><div class="section-title"><h2>${data.total === null ? '作品数量不可用' : `${count(data.total)} 部作品`}</h2><small>${state.duplicates ? "关联线索，未确认重复" : "有效编号去重"} · 已知 ${data.knownServers} / ${data.servers.length} 台 · 每页 ${data.pageSize} 部</small></div>
    ${data.items.length ? mediaCards(data.items) : '<div class="empty">没有匹配的作品。可调整搜索词、类型或服务器筛选。</div>'}
    <div class="pagination"><button data-page="${data.page - 1}" ${data.page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${data.page} / ${data.pages} 页</span><button data-page="${data.page + 1}" ${data.page >= data.pages ? 'disabled' : ''}>下一页</button></div></section>`
}

function settings() {
  return heading('服务器设置', '一个 Emby，一个账号。连接信息仅保存在本地。', '<button class="primary" data-action="add">＋ 添加服务器</button>') +
    `<section class="panel"><div class="section-title"><h2>自动更新设置 · ${state.settings.automaticUpdates ? '已开启' : '已暂停'}</h2><button data-action="toggle-updates">${state.settings.automaticUpdates ? '暂停全部自动更新' : '开启自动更新'}</button></div><p>总开关控制所有连接的轻量更新、完整校准和季集后台补全。默认关闭，重启后保持。暂停时仍可浏览已有缓存，手动更新和点击详情、海报可能按需请求远端。</p><p class="muted">暂停后正在进行的请求可能完成；自动任务会在后续步骤停止。读取会产生网络与服务端计算开销，不能保证零负载；不会调用扫盘、刮削、修改或删除接口。</p></section>` +
    '<p class="notice">填写 Emby 登录账号即可，无需管理员 API Key。账号密码及令牌加密存储；修改地址或账号会清除该连接的旧缓存。</p>' +
    (state.servers.length ? `<div class="settings-grid">${state.servers.map(server => `<article class="panel settings-card"><div class="status-title"><h2>${e(server.name)}${server.nsfw ? ' <span class="nsfw-tag">NSFW</span>' : ''}</h2>${statusLabel(server)}</div><p class="address">${e(server.url)}</p>${server.proxyUrl ? `<p class="address">关联反代：${e(server.proxyUrl)}（同一连接）</p>` : ''}
    ${server.error ? `<div class="warning">${e(server.error)}</div>` : ''}
    <form class="schedule-form" data-id="${e(server.id)}"><h3>此服务器更新周期</h3><label>轻量更新间隔（分钟）<input name="lightMinutes" type="number" min="15" max="1440" value="${server.lightMinutes}" required></label><label>完整片库校准<select name="fullHours">${[[0, '仅手动'], [12, '每 12 小时'], [24, '每天一次'], [48, '每两天'], [168, '每周']].map(([value, label]) => `<option value="${value}" ${server.fullHours === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><small>${state.settings.automaticUpdates ? '按保存的周期自动执行' : '自动更新已暂停，保存周期不会开始读取'}</small><p class="form-error" role="alert"></p><button type="submit">保存更新周期</button></form>
    ${Object.entries(datasetNames).map(([kind, label]) => `<div class="dataset"><span>${label}</span><b>${server.datasets[kind].available ? `${date(server.datasets[kind].updatedAt)}${server.datasets[kind].stale ? ' · 旧缓存' : ''}` : '不可用 / 尚未同步'}${server.datasets[kind].error ? `<br><small>${e(server.datasets[kind].error)}</small>` : ''}</b></div>`).join('')}
    <div class="actions"><button data-edit="${e(server.id)}">编辑</button><button data-refresh="${e(server.id)}" ${server.syncing ? 'disabled' : ''}>同步</button><button class="subtle danger" data-delete="${e(server.id)}">删除</button></div></article>`).join('')}</div>` : emptyConnections())
}

async function loadView({ preserveSearch = false } = {}) {
  const request = ++state.request
  try {
    const [servers, updateSettings] = await Promise.all([api('/api/servers'), api('/api/settings')])
    if (request !== state.request || !state.authenticated) return
    state.servers = servers
    state.settings = updateSettings
    updateServers()
    const page = state.page
    const params = new URLSearchParams({ server: state.server, q: state.query, type: state.type, page: state.libraryPage, duplicates: state.duplicates, review: state.review })
    const data = page === 'settings' ? null : await api(`/api/${page === 'overview' ? 'overview' : 'library'}?${params}`)
    if (request !== state.request || !state.authenticated) return
    const focused = preserveSearch && document.activeElement?.id === 'search'
    const caret = focused ? document.activeElement.selectionStart : null
    const paused = !state.settings.automaticUpdates && page !== 'settings' ? '<p class="notice">自动更新已暂停 · 正在查看缓存 <button data-nav="settings">更新设置</button></p>' : ''
    document.querySelector('#content').innerHTML = paused + (page === 'overview' ? overview(data) : page === 'library' ? library(data) : settings())
    document.querySelector('#breadcrumb').textContent = titles[page]
    document.querySelectorAll('[data-nav]').forEach(button => button.toggleAttribute('aria-current', button.dataset.nav === page))
    document.querySelectorAll('nav [aria-current]').forEach(button => button.setAttribute('aria-current', 'page'))
    updatePosters()
    if (data?.page) state.libraryPage = data.page
    if (focused) {
      const input = document.querySelector('#search')
      input.focus()
      input.setSelectionRange(caret, caret)
    }
  } catch (error) { toast(error.message) }
}

function openDialog(title, body) {
  dialog.innerHTML = `<header class="dialog-header"><h2>${e(title)}</h2><button class="subtle" data-action="close" aria-label="关闭对话框">✕</button></header><div class="dialog-body">${body}</div>`
  dialog.setAttribute('aria-label', title)
  if (!dialog.open) dialog.showModal()
}

function editServer(id) {
  const server = state.servers.find(server => server.id === id)
  openDialog(server ? '编辑服务器' : '添加服务器', `<form id="server-form" data-id="${e(id || '')}" class="form-grid">
    <p class="muted">通过 Emby 正常登录获取用户令牌，只读取当前账号有权访问的数据。</p>
    <label>连接名称<input name="name" value="${e(server?.name || '')}" placeholder="例如：家庭媒体库" maxlength="80" required autofocus></label>
    <label>服务器地址<input name="url" type="url" value="${e(server?.url || '')}" placeholder="https://emby.example.com" required><small>支持端口和反向代理路径；不含用户名、密码或查询参数。</small></label>
    <label>Emby 用户名<input name="username" autocomplete="off" maxlength="256" ${server ? 'placeholder="留空保留原账号"' : 'required'}></label>
    <label>Emby 密码<input name="password" type="password" autocomplete="new-password" maxlength="1024" ${server ? 'placeholder="留空保留原密码"' : ''}><small>${server ? '凭据不回传浏览器。更换账号时请同时填写新密码。' : '支持 Emby 无密码账号；使用 HTTP 时凭据在到 Emby 的网络链路上不加密。'}</small></label>
    <label>关联反代地址（可选）<input name="proxyUrl" type="url" value="${e(server?.proxyUrl || '')}" placeholder="http://代理主机:端口"><small>属于当前连接，不新增片库；仅保存关联地址，不自动接入日志。</small></label>
    <label>轻量更新间隔（分钟）<input name="lightMinutes" type="number" min="15" max="1440" value="${server?.lightMinutes || 60}" required><small>只更新媒体库视图、最近入库和继续观看，不重读片库。</small></label>
    <label>完整片库校准<select name="fullHours">${[[0, '仅手动'], [12, '每 12 小时'], [24, '每天一次（默认）'], [48, '每两天'], [168, '每周']].map(([value, label]) => `<option value="${value}" ${(server?.fullHours ?? 24) === value ? 'selected' : ''}>${label}</option>`).join('')}</select><small>校准新增、删除和元数据变化。季集每 5 分钟最多核对 20 部，新鲜缓存保留至少 7 天。</small></label>
    <label class="checkbox-label"><input name="nsfw" type="checkbox" ${server?.nsfw ? 'checked' : ''}>标记为 NSFW，默认虚化此服务器海报</label><small>仅影响本地显示；可一键显示或点击单张海报解除虚化。刷新页面后恢复虚化。</small>
    <p class="form-error" id="server-error" role="alert"></p><div class="dialog-footer"><button type="button" data-action="close">取消</button><button class="primary" type="submit">保存设置</button></div></form>`)
}

function renderResources(resource) {
  return `${resource.locations.length ? resource.locations.map(location => `<div class="resource-path"><small>${e(location.label)}</small><code>${e(location.path)}</code></div>`).join('') : '<p>当前账号或接口未提供可展示的本地路径。</p>'}
    ${resource.hiddenRemote ? '<p class="notice">远程地址或可能携带凭据的路径已隐藏。</p>' : ''}${resource.error ? `<p class="notice">${e(resource.error)}</p>` : ''}<small>读取时间：${date(resource.updatedAt)}${resource.stale ? ' · 旧缓存' : ''}</small>`
}

function renderSourceComparison(item) {
  const sources = item.duplicateSources
  const isCurrent = source => source.serverId === item.serverId && source.id === item.id
  const ordered = [...sources].sort((a, b) => Number(isCurrent(b)) - Number(isCurrent(a)))
  const serverCount = new Set(sources.map(source => source.serverId)).size
  const multiple = sources.length > 1
  return `<section class="resource-section"><h2>${multiple ? '关联记录与资源排查' : '当前记录与资源位置'}</h2>
    <p>${multiple ? `共 ${sources.length} 条媒体库记录，分布在 ${serverCount} 台服务器。包含当前查看的 1 条，另有 ${sources.length - 1} 条。` : item.duplicateConflict ? '当前记录的外部编号存在冲突，暂不与其他记录归组；不能据此判断有无重复。' : '当前缓存中尚未匹配到其他同作品记录。'}</p>
    ${item.comparison ? `<p class="notice"><strong>${e(item.comparison.label)}</strong><br>${item.comparison.reasons.map(e).join('<br>')}<br>${item.comparison.counts.candidate} 对资源线索 · ${item.comparison.counts.distinct} 对季范围无重叠 · ${item.comparison.counts.unknown} 对待确认</p><details><summary>逐对核对依据</summary>${item.comparison.pairs.map(pair => `<p>${e(sources.find(s => s.key === pair.leftKey)?.title)} ↔ ${e(sources.find(s => s.key === pair.rightKey)?.title)}：${e(pair.reason)}</p>`).join('')}</details>` : ''}
    <p class="muted">对照范围：全部已连接服务器的片库缓存，不受当前片库服务器筛选限制。${item.duplicateConflict ? '' : '按媒体类型与有效外部编号匹配同一作品，未比较文件内容。'}</p>
    <p class="muted">一条记录是服务器片库中的一个条目，可以包含多个资源路径或媒体版本；路径数量不计入上面的记录数。不同清晰度、剪辑版或跨服收藏不一定需要清理。</p>
    ${ordered.map((source, index) => `<div class="duplicate-source"><strong>记录 ${index + 1}${isCurrent(source) ? ' · 当前查看' : ''} · ${e(source.serverName || item.serverName)}</strong><span>${e(source.title)}</span><small>${e(source.scope?.label || "")} · ${e(source.year || "年份未知")}</small><small>服务器内条目 ID：${e(source.id)}</small><small>作品编号：${Object.entries(source.providerIds || {}).map(([key, value]) => `${e(key.toUpperCase())} ${e(value)}`).join(' · ') || '未提供有效编号'}</small>
      <div id="resource-${e(source.serverId)}-${e(source.id)}">${source.resources ? renderResources(source.resources) : isCurrent(source) ? renderResources(item.resources) : '<span class="muted">尚未读取此记录的资源路径</span>'}</div>
      <button data-resource="${e(source.id)}" data-server="${e(source.serverId)}">读取此记录的路径</button>${isCurrent(source) ? '' : `<button data-item="${e(source.id)}" data-server="${e(source.serverId)}">查看此记录详情</button>`}</div>`).join('')}
    <p class="muted">路径由对应服务器报告，可能是容器挂载路径、STRM 文件或虚拟目录，不保证等于 NAS 物理路径；仅凭记录数或路径无法判断文件是否可以删除。</p></section>`
}

async function showDetail(serverId, id, params = new URLSearchParams()) {
  const identity = `${serverId}:${id}`
  state.detail = identity
  openDialog('作品详情', '<div class="empty">正在读取详情…</div>')
  try {
    const item = await api(`${itemPath({ serverId, id })}?${params}`)
    if (state.detail !== identity || !dialog.open) return
    openDialog('作品详情', `<div class="detail-top">${posterButton(item, true)}<div><h1>${e(item.title)}</h1><p class="muted">${item.year ?? '年份未知'} · ${{ Movie: '电影', Series: '电视剧', Episode: '单集', Season: '季' }[item.type] || '媒体'}${item.rating == null ? '' : ` · ★ ${item.rating.toFixed(1)}`}</p>
      <div class="metadata">${item.genres.map(genre => `<span>${e(genre)}</span>`).join('')}</div><small>${item.seriesName ? `${e(item.seriesName)} · ` : ''}${item.season != null ? `第 ${item.season} 季 ` : ''}${item.episode != null ? `第 ${item.episode} ${item.type === 'Season' ? '季' : '集'}` : ''}</small></div></div>
      <p class="detail-overview">${e(item.overview || '当前接口未提供简介。')}</p>
      <div class="detail-source"><strong>当前查看：${e(item.serverName)} 的这条记录</strong><br>本页作品信息属于当前记录，其他记录可在下方对照区查看。<br>当前记录缓存时间：${date(item.cache.updatedAt)}${item.cache.stale ? ' · 旧缓存' : ''}${item.cache.warning ? `<br>${e(item.cache.warning)}` : ''}</div>
      ${renderSourceComparison(item)}
      ${['Series', 'Episode', 'Season'].includes(item.type) ? `<section><div class="section-title"><h2>季集信息</h2><select id="season-select" data-server="${e(serverId)}" data-id="${e(id)}" aria-label="选择季"><option value="">全部季</option>${item.seasons.map(season => `<option value="${season}" ${params.get('season') === String(season) ? 'selected' : ''}>第 ${season} 季</option>`).join('')}</select></div>
        ${item.seasonEpisodeTotal !== null ? `<p class="notice">季接口返回共 ${count(item.seasonEpisodeTotal)} 集；下方列表按单集接口实际读取结果展示。</p>` : ''}<p class="notice">单集明细缓存：${date(item.episodeUpdatedAt)}</p>${item.episodeError ? `<p class="notice">单集明细：${e(item.episodeError)}。暂不能展示完整列表。</p>` : ''}
        ${item.episodes.length ? item.episodes.map(episode => `<div class="episode"><span>${e(episode.title)}<button data-resource="${e(episode.id)}" data-server="${e(serverId)}">资源位置</button><span id="resource-${e(serverId)}-${e(episode.id)}"></span></span><small>${episode.season == null ? '未知季' : `S${episode.season}`} · ${episode.episode == null ? '未知集' : `E${episode.episode}`}</small></div>`).join('') : '<div class="empty">当前账号暂无可展示的季集信息</div>'}
        <div class="pagination"><button data-episode-page="${item.episodePage - 1}" data-server="${e(serverId)}" data-id="${e(id)}" ${item.episodePage === 1 ? 'disabled' : ''}>上一页</button><span>${item.episodePage} / ${item.episodePages} 页</span><button data-episode-page="${item.episodePage + 1}" data-server="${e(serverId)}" data-id="${e(id)}" ${item.episodePage === item.episodePages ? 'disabled' : ''}>下一页</button></div></section>` : ''}`)
  } catch (error) { if (dialog.open) openDialog('详情不可用', `<div class="empty">${e(error.message)}</div>`) }
}

document.addEventListener('error', event => { if (event.target.tagName === 'IMG' && event.target.closest('.poster')) event.target.remove() }, true)
document.addEventListener('click', async event => {
  const button = event.target.closest('button')
  if (!button) return
  try {
    if (button.dataset.action === 'toggle-updates') {
      await api('/api/settings', 'PUT', { automaticUpdates: !state.settings.automaticUpdates })
      await loadView()
    } else if (button.dataset.resource) {
      button.disabled = true
      const identity = state.detail
      try {
        const resource = await api(`${itemPath({ serverId: button.dataset.server, id: button.dataset.resource })}/resources`)
        if (identity === state.detail && dialog.open) {
          const target = document.getElementById(`resource-${button.dataset.server}-${button.dataset.resource}`)
          if (target) target.innerHTML = renderResources(resource)
        }
      } finally { button.disabled = false }
    } else if (button.dataset.action === 'duplicates') {
      state.duplicates = true
      state.query = ''
      state.type = ''
      state.page = 'library'
      state.libraryPage = 1
      await loadView()
    } else if (button.dataset.action === 'toggle-blur') {
      state.blurNsfw = !state.blurNsfw
      state.revealed.clear()
      updatePosters()
    } else if (button.dataset.posterKey && button.classList.contains('blurred')) {
      state.revealed.add(button.dataset.posterKey)
      updatePosters()
    } else if (button.dataset.nav) {
      state.page = button.dataset.nav
      state.libraryPage = 1
      await loadView()
    } else if (button.dataset.page) {
      state.libraryPage = Number(button.dataset.page)
      await loadView()
      document.querySelector('#content').scrollIntoView({ block: 'start' })
    } else if (button.dataset.item) await showDetail(button.dataset.server, button.dataset.item)
    else if (button.dataset.edit) editServer(button.dataset.edit)
    else if (button.dataset.delete) {
      const server = state.servers.find(server => server.id === button.dataset.delete)
      openDialog('删除连接', `<p>删除「${e(server.name)}」及其本地缓存？远端 Emby 数据不受影响。</p><div class="dialog-footer"><button data-action="close">取消</button><button class="danger" data-confirm-delete="${e(server.id)}">删除连接</button></div>`)
    } else if (button.dataset.confirmDelete) {
      await api(`/api/servers/${button.dataset.confirmDelete}`, 'DELETE', {})
      dialog.close()
      toast('连接及本地缓存已删除')
      await loadView()
    } else if (button.dataset.episodePage) {
      const params = new URLSearchParams({ page: button.dataset.episodePage })
      const season = document.querySelector('#season-select').value
      if (season !== '') params.set('season', season)
      await showDetail(button.dataset.server, button.dataset.id, params)
    } else if (['refresh', 'full-refresh'].includes(button.dataset.action) || button.dataset.refresh) {
      await api('/api/refresh', 'POST', { server: button.dataset.refresh || state.server, mode: button.dataset.action === 'full-refresh' ? 'full' : 'light' })
      toast(button.dataset.action === 'full-refresh' ? '已开始完整校准片库，按限速读取' : '已开始轻量更新，片库不会重扫')
      await loadView()
    } else if (button.dataset.action === 'add') editServer()
    else if (button.dataset.action === 'close') dialog.close()
    else if (button.dataset.action === 'logout') {
      await api('/api/auth/logout', 'POST', {})
      state.authenticated = false
      state.blurNsfw = true
      state.revealed.clear()
      state.request++
      await boot()
    }
  } catch (error) { toast(error.message) }
})

document.addEventListener('change', async event => {
  if (['server-select', 'library-server-select'].includes(event.target.id)) {
    state.server = event.target.value
    state.libraryPage = 1
    await loadView()
  } else if (event.target.id === 'review-select') {
    state.review = event.target.value
    state.libraryPage = 1
    await loadView()
  } else if (event.target.id === 'duplicate-select') {
    state.duplicates = event.target.value === 'duplicates'
    state.libraryPage = 1
    await loadView()
  } else if (event.target.id === 'type-select') {
    state.type = event.target.value
    state.libraryPage = 1
    await loadView()
  } else if (event.target.id === 'season-select') {
    const params = new URLSearchParams()
    if (event.target.value !== '') params.set('season', event.target.value)
    await showDetail(event.target.dataset.server, event.target.dataset.id, params)
  }
})

document.addEventListener('input', event => {
  if (event.target.id !== 'search') return
  state.query = event.target.value
  state.libraryPage = 1
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => loadView({ preserveSearch: true }), 400)
})

document.addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.target
  if (form.id === 'search-form') {
    clearTimeout(searchTimer)
    state.query = form.elements.q.value
    state.libraryPage = 1
    return loadView({ preserveSearch: true })
  }
  const button = form.querySelector('button[type=submit]')
  if (!button) return
  button.disabled = true
  try {
    if (form.id === 'auth-form') {
      const password = form.elements.password.value
      if (form.elements.confirm && form.elements.confirm.value !== password) throw new Error('两次密码不一致')
      await api(`/api/auth/${form.dataset.mode}`, 'POST', { password })
      await boot()
    } else if (form.classList.contains('schedule-form')) {
      const server = state.servers.find(server => server.id === form.dataset.id)
      await api(`/api/servers/${server.id}`, 'PUT', { name: server.name, url: server.url, lightMinutes: Number(form.elements.lightMinutes.value), fullHours: Number(form.elements.fullHours.value) })
      toast('更新周期已保存，自动更新总开关保持原状态')
      await loadView()
    } else if (form.id === 'server-form') {
      const data = Object.fromEntries(new FormData(form))
      data.lightMinutes = Number(form.elements.lightMinutes.value)
      data.fullHours = Number(form.elements.fullHours.value)
      data.nsfw = form.elements.nsfw.checked
      const id = form.dataset.id
      await api(`/api/servers${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', data)
      form.reset()
      dialog.close()
      toast('设置已保存；新增或变更账号时自动同步')
      await loadView()
    }
  } catch (error) {
    form.querySelector('.form-error').textContent = error.message
  } finally { button.disabled = false }
})

async function boot() {
  try {
    const status = await api('/api/auth/status')
    state.authenticated = status.authenticated
    if (status.authenticated) {
      shell()
      await loadView()
    } else {
      app.innerHTML = `<main class="auth-page" id="content"><div class="auth-card">${brand()}<h1>${status.initialized ? '欢迎回来' : '开启你的媒体空间'}</h1><p>${status.initialized ? '登录本地管理员，查看你的 Emby 收藏。' : '首次使用，设置一个本地管理员密码。'}</p>
        <form id="auth-form" data-mode="${status.initialized ? 'login' : 'setup'}"><label>管理员密码<input name="password" type="password" minlength="12" maxlength="256" autocomplete="${status.initialized ? 'current-password' : 'new-password'}" required autofocus></label>
        ${status.initialized ? '' : '<label>确认密码<input name="confirm" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><small>至少 12 个字符，与 Emby 密码相互独立。</small>'}
        <p class="form-error" role="alert"></p><button class="primary" type="submit">${status.initialized ? '登录映览' : '设置密码并进入'}</button></form><footer>个人自用 · 本地保存 · 远端数据只读</footer></div></main>`
    }
  } catch (error) { app.innerHTML = `<main class="startup"><h1>暂时无法连接映览</h1><p>${e(error.message)}</p><p>请确认应用服务正常运行，然后刷新页面。</p></main>` }
}

let polling = false
setInterval(async () => {
  if (!state.authenticated || dialog.open || document.hidden || polling) return
  polling = true
  try {
    const before = JSON.stringify(state.servers)
    const servers = await api('/api/servers')
    if (JSON.stringify(servers) !== before && document.activeElement?.id !== 'search') await loadView()
  } catch { /* 页面保留当前缓存，主动操作时显示连接错误。 */ }
  finally { polling = false }
}, 5000)

await boot()

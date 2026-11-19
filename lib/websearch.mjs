/**
 * 联网兜底：搜索 + 抓正文。
 *
 * 干什么：本地词库查不到某个梗时，去网上查一次，把结果交给 LLM 做结构化总结。
 *
 * 为什么自己发请求（而不是用机器人的 web_search 工具）：
 *   那个工具是**给模型调的**，插件调不到。插件只能自己发起 HTTP。
 *
 * 实测过的可达性（2026-11-19，本机直连、未走代理）：
 *   · cn.bing.com        200，能解析出中文梗站结果 ← 主搜索源
 *   · sogou / so.com     200（备用）
 *   · html.duckduckgo    0 字节（不可达）
 *   · www.bing.com       被挡（只回 197 字节）
 *
 * 隐私铁律：**只发梗词本身**，绝不把群聊上下文发出去（用户 2026-11-19 确认的设计）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 梗站白名单：优先抓这些站，命中率高且正文干净 */
const 优先域名 = [
  'cnmeme.wiki', 'geng8.com', 'yanfa.lol', 'yehuowiki.com', 'clover.asia',
  'baike.baidu.com', 'zhihu.com', 'bilibili.com', 'douban.com',
]

/** 明确不值得抓的（视频页/文库页正文抓不到） */
const 跳过域名 = ['bilibili.com/video', 'wenku.baidu.com', 'youtube.com', 'weibo.com']

function 域名匹配(url, list) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '')
    return list.some((d) => h === d || h.endsWith(`.${d}`))
  } catch {
    return false
  }
}

function 解码实体(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
}

/** HTML → 纯文本（够用就行，不追求完美） */
export function html转文本(html) {
  let s = String(html || '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = 解码实体(s)
  return s.replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 搜索梗词，返回候选 URL 列表（已按域名优先级排序、已去重）。
 * @param {string} query 梗词
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{ok:boolean, urls:string[], error?:string}>}
 */
export async function searchMeme(query, opts = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, urls: [], error: '空查询' }
  const timeoutMs = opts.timeoutMs ?? 8000
  const doFetch = opts.fetchImpl ?? fetch

  // ⚠️ 实测（2026-11-19）：**只发梗词本身**，别加「是什么梗 出处 用法」这种后缀。
  //    加了反而害 Bing 分词跑偏：查「我Chovy」+ 后缀 → 结果全是「我（汉字）」「我的世界」；
  //    只发「我Chovy」→ 正确命中百度百科词条 + 知乎 + 梗站。
  //    隐私上这也更好：只发词，不发任何句子。
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`
  let html = ''
  try {
    const r = await doFetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return { ok: false, urls: [], error: `搜索 HTTP ${r.status}` }
    html = await r.text()
  } catch (e) {
    return { ok: false, urls: [], error: `搜索失败：${e?.message ?? e}` }
  }

  // 解析 <h2><a href="...">标题</a>
  const urls = []
  const re = /<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    const u = 解码实体(m[1])
    if (!/^https?:\/\//.test(u)) continue
    if (/bing\.com|microsoft\.com|msn\.com/.test(u)) continue
    // 跳过明显抓不到正文的
    if (跳过域名.some((d) => u.includes(d))) continue
    if (!urls.includes(u)) urls.push(u)
  }

  // ⚠️ 相关性过滤：Bing 会做分词，「绝绝子」能搜出「绝（汉字）_百度百科」这种。
  //    判据：**结果标题里必须出现查询词**（整串，不拆字）。
  const 相关 = []
  re.lastIndex = 0
  let mm
  while ((mm = re.exec(html)) !== null) {
    const u = 解码实体(mm[1])
    const title = 解码实体(html转文本(mm[2]))
    if (!/^https?:\/\//.test(u)) continue
    if (/bing\.com|microsoft\.com|msn\.com/.test(u)) continue
    if (跳过域名.some((d) => u.includes(d))) continue
    // 自定义路径里的词也要看（百科 URL 常是 URL 编码的词）
    let decoded = u
    try { decoded = decodeURIComponent(u) } catch { /* 保持原样 */ }
    // 相关性判据（松散但要能挡住「绝绝子→绝(汉字)」这类分词垃圾）：
    //   ① 标题/URL 里含完整查询词；或
    //   ② 含查询词里**任意连续 2 字**（中文标题常省略虚词，如「蚌埠住了」写成「蚌埠」）
    if (!title.includes(q) && !decoded.includes(q)) {
      const 片段 = []
      for (let i = 0; i + 2 <= q.length; i++) 片段.push(q.slice(i, i + 2))
      const 命中片段 = 片段.filter((s) => title.includes(s) || decoded.includes(s))
      // 至少要命中一个 2 字片段，且标题里带「梗/黑话/什么意思/来源/出处」之类的语义提示
      if (命中片段.length === 0) continue
      if (!/梗|黑话|什么意思|来源|出处|用法|什么话|口头禅|流行语/.test(title)) continue
    }
    if (!相关.some((x) => x.url === u)) 相关.push({ url: u, title })
  }

  // 梗站优先；其次标题里直接带「梗」的
  相关.sort((a, b) => {
    const s = (x) => Number(域名匹配(x.url, 优先域名)) * 2 + Number(/梗|黑话|什么意思/.test(x.title))
    return s(b) - s(a)
  })
  const out = 相关.map((x) => x.url).slice(0, 8)
  return { ok: out.length > 0, urls: out, error: out.length ? undefined : `没搜到和「${q}」相关的页面` }
}

/**
 * 抓一个页面的正文（截断到 maxChars）。
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function fetchPage(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 9000
  const maxChars = opts.maxChars ?? 6000
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const r = await doFetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
    const ct = String(r.headers?.get?.('content-type') ?? '')
    if (!/text|html|json/i.test(ct)) return { ok: false, error: `不支持的类型 ${ct}` }
    const body = await r.text()
    const text = html转文本(body)
    if (text.length < 80) return { ok: false, error: '正文太短（可能是 JS 渲染页）' }
    return { ok: true, text: text.slice(0, maxChars) }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 搜索 + 抓前 N 个页面。任何一步失败都不抛，返回已拿到的部分。
 * @param {string} query
 * @param {object} [opts] { maxPages, timeoutMs, fetchImpl }
 * @returns {Promise<{ok:boolean, pages:Array<{url:string,text:string}>, error?:string}>}
 */
export async function searchAndFetch(query, opts = {}) {
  const maxPages = opts.maxPages ?? 2
  const s = await searchMeme(query, opts)
  if (!s.ok) return { ok: false, pages: [], error: s.error }

  // ⚠️ 并发抓（实测串行 2 页要 20s，用户已同意"等待"但不能等这么久）。
  //    取前 maxPages*2 个候选并发，谁先成功用谁。
  const 候选 = s.urls.slice(0, Math.max(maxPages * 2, 2))
  const results = await Promise.all(
    候选.map(async (u) => {
      const p = await fetchPage(u, { ...opts, timeoutMs: opts.pageTimeoutMs ?? 6000 })
      return p.ok ? { url: u, text: p.text } : null
    }),
  )
  const pages = results.filter(Boolean).slice(0, maxPages)
  if (!pages.length) return { ok: false, pages: [], error: '搜到了但正文都抓不到' }
  return { ok: true, pages }
}


// ---------- 梗站 API（第一来源，比搜索引擎准得多） ----------
//
// 实测（2026-11-19）：
//   · cnmeme.wiki 搜索「绝绝子」→ 直接返回完整词条（含 usage/summary/origin）
//     —— 这正是本地库缺的那条，搜索引擎（Bing）反而只给「绝（汉字）」这种分词垃圾。
//   · cnmeme.wiki 搜「我Chovy」→ 空（站点还没收录）→ 才轮到搜索引擎。
// 所以顺序是：梗站 API → 搜索引擎。

const CNMEME_API = 'https://cnmeme.wiki/api/v1/public/memes'

/**
 * 查梗维基（cnmeme.wiki）公开 API。
 * @param {string} query
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, item?:object, error?:string}>}
 */
export async function queryCnmeme(query, opts = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: '空查询' }
  const timeoutMs = opts.timeoutMs ?? 9000
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const r = await doFetch(`${CNMEME_API}?q=${encodeURIComponent(q)}&limit=5`, {
      headers: { 'user-agent': 'dsh-memewiki-local/0.2' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return { ok: false, error: `梗维基 HTTP ${r.status}` }
    const d = await r.json()
    const items = Array.isArray(d?.items) ? d.items : []
    if (!items.length) return { ok: false, error: '梗维基没收录' }
    // 只要标题真含查询词的（API 的 q 是模糊匹配，会返回不相关条目）
    const hit = items.find((it) => String(it?.title ?? '').includes(q))
      ?? items.find((it) => q.length >= 2 && String(it?.title ?? '').slice(0, 2) === q.slice(0, 2))
    if (!hit) return { ok: false, error: '梗维基返回的结果不相关' }
    return { ok: true, item: hit }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 统一的联网查梗入口：先梗站 API，再搜索引擎抓正文。
 * @param {string} query
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, source:'cnmeme'|'web'|'', item?:object, pages?:Array, error?:string}>}
 */
export async function lookupOnline(query, opts = {}) {
  // ⚠️ 梗站 API 与搜索引擎**并行**发：实测串行 11.8s → 并行 6.2s。
  //    梗站命中就用梗站（权威），否则用搜索抓到的正文。
  //    两个都失败才算失败。
  const [c, w] = await Promise.all([
    queryCnmeme(query, opts),
    searchAndFetch(query, opts),
  ])
  if (c.ok) return { ok: true, source: 'cnmeme', item: c.item, pages: w.ok ? w.pages : [] }
  if (w.ok) return { ok: true, source: 'web', pages: w.pages }
  return { ok: false, source: '', error: `梗站：${c.error}；搜索：${w.error}` }
}

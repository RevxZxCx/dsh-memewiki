/**
 * 联网兜底的编排层：本地查不到时，去网上查一次、抽成词条、入库、返回可注入的包。
 *
 * 用户 2026-11-19 的决定：
 *   「未命中时我觉得可以做等待，期间不进行回复。」
 *   → **同步等待**（不是异步预热），等待期间机器人不吭声；超时则放弃并给"不确定"的约束。
 *
 * 流程（顺序有讲究）：
 *   ① cnmeme.wiki 搜索 API  ── 命中就直接用（它是权威词库的上游，质量最高）
 *   ② 否则 Bing 搜索 + 抓 1~2 篇正文  ── 拿原始材料
 *   ③ LLM 结构化抽取 ── 拆成 meaning / how_to_use / origin
 *   ④ 置信度 + 相关性校验 ── 不合格就放弃（**绝不入库垃圾**）
 *   ⑤ 入库（source=web，记来源 URL 与置信度）
 *   ⑥ 按场景生成注入包，本轮直接用
 *
 * 失败即放弃：宁可让模型说"不确定"，也不编、不塞垃圾。
 */

import { lookupOnline } from './websearch.mjs'
import { 抽取词条 } from './extract.mjs'
import { saveWebEntry, migrateSchema } from './autolearn.mjs'

/** 默认总超时（用户同意"等待"，但不能无限等） */
export const 默认超时 = 12_000

/**
 * 把 cnmeme 的 API 返回项转成我们的 entry 结构。
 * @param {object} item
 * @returns {object}
 */
export function cnmemToEntry(item) {
  const summary = String(item?.summary ?? '')
  // cnmeme 的 summary 里常带「来源 」前缀，剥掉
  const meaning = summary.replace(/^来源\s*/, '').slice(0, 200)
  return {
    title: String(item?.title ?? '').slice(0, 60),
    aliases: '',
    meaning,
    how_to_use: '',      // API 列表项没有 usage，只有详情才有
    origin: '',
    examples: [],
    confidence: 'high',  // 权威来源
  }
}

/**
 * 联网查梗（同步，带总超时）。
 *
 * @param {object} opts
 * @param {string} opts.query       要查的词
 * @param {object} opts.db          可写 DatabaseSync（入库用；为 null 则不入库）
 * @param {Function} opts.callLLM   LLM 调用函数
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]  测试注入
 * @param {boolean} [opts.persist]  是否入库（默认 true）
 * @returns {Promise<{
 *   ok:boolean,
 *   entry?:object,
 *   source?:'cnmeme'|'web',
 *   saved?:{action:string,title?:string},
 *   error?:string,
 *   tookMs?:number
 * }>}
 */
export async function learnMemeFromWeb(opts) {
  const started = Date.now()
  const q = String(opts?.query ?? '').trim()
  if (!q) return { ok: false, error: '空查询' }

  const timeoutMs = opts.timeoutMs ?? 默认超时
  const persist = opts.persist !== false

  // 总超时：用 Promise.race 兜住（各步内部也有自己的超时）
  const work = (async () => {
    const online = await lookupOnline(q, { fetchImpl: opts.fetchImpl })

    if (!online.ok) return { ok: false, error: online.error }

    let entry = null
    let sources = []

    if (online.source === 'cnmeme') {
      entry = cnmemToEntry(online.item)
      sources = ['https://cnmeme.wiki/meme/' + encodeURIComponent(String(online.item?.slug ?? q))]
      // API 列表项没有用法，用 LLM 从 summary 里提炼「怎么接」
      // （不额外抓页面，节省时间；summary 通常够用）
      if (entry.meaning && typeof opts.callLLM === 'function') {
        const 抽 = await 抽取词条({
          query: q,
          text: `【${entry.title}】${entry.meaning}`,
          callLLM: opts.callLLM,
          model: opts.model,
        })
        if (抽.ok) entry = { ...entry, how_to_use: 抽.entry.how_to_use, examples: 抽.entry.examples }
      }
    } else {
      const text = (online.pages || []).map((p) => p.text).join('\n\n---\n\n')
      sources = (online.pages || []).map((p) => p.url)
      const 抽 = await 抽取词条({ query: q, text, callLLM: opts.callLLM, model: opts.model })
      if (!抽.ok) return { ok: false, error: `抽取失败：${抽.reason}` }
      entry = 抽.entry
    }

    if (!entry?.title) return { ok: false, error: '没抽到有效词条' }

    // 入库（打 web 标记）。
    // ⚠️ 入库前必须确保 schema v2 —— 否则 INSERT 会因缺 source 列直接失败，
    //    而失败只体现在 saved.ok=false 里，词条照样能用于本轮注入，
    //    于是"看起来能用但其实没入库"（实测踩到：no such column: source）。
    let saved = null
    if (persist && opts.db) {
      const mig = migrateSchema(opts.db)
      if (!mig.ok) saved = { ok: false, action: 'skipped', reason: `schema 迁移失败：${mig.error}` }
      else saved = saveWebEntry(opts.db, entry, { sources })
    }
    return { ok: true, entry, source: online.source, saved }
  })()

  const timer = new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, error: `联网查梗超时（${timeoutMs}ms）` }), timeoutMs),
  )

  const r = await Promise.race([work, timer])
  return { ...r, tookMs: Date.now() - started }
}

/**
 * 把联网查到的词条转成词库行（结构与 memes.db 一致），供注入包直接复用。
 * @param {object} entry
 * @returns {object}
 */
export function entryToRow(entry) {
  const usage = [
    entry.how_to_use,
    ...(Array.isArray(entry.examples) && entry.examples.length
      ? [entry.examples.map((e) => `* 例子：${e}`).join('\n')]
      : []),
  ].filter(Boolean).join('\n')
  return {
    title: entry.title,
    usage,
    summary: entry.meaning,
    origin: entry.origin,
    tags: '',
    aliases: entry.aliases,
    source: 'web',
  }
}

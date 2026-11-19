/**
 * 结构化抽取：把网上抓到的乱糟糟正文，压成一条能入库的词条。
 *
 * 为什么要 LLM 抽而不是直接存原文：
 *   抓来的正文里有导航、广告、推荐位，直接存进去既臃肿又不可靠。
 *   而且我们需要**拆开放**：meaning（含义）/ how_to_use（怎么接）/ origin（出处），
 *   这样「玩梗场景」只取 how_to_use、解释场景才带 origin —— 这是方案 1+2 的地基。
 *
 * 硬约束（防污染）：
 *   · 只接受严格 JSON；解析失败就记失败，**绝不把原始文本当词条塞进库**
 *   · confidence 必须是 high/medium/low；low 视为不可用
 *   · 各字段限长，防止把整篇文章塞进 usage
 */

export const 字段上限 = Object.freeze({
  title: 60,
  meaning: 200,
  how_to_use: 200,
  origin: 300,
  examples: 3,
  exampleLen: 40,
  aliases: 5,
})

const 系统提示 = [
  '你是网络梗词典编辑。读正文，判断它是否在讲指定网络梗，并抽成词条。',
  '只输出一个 JSON 对象（不要 markdown 代码块、不要解释）：',
  '{"is_meme":bool,"title":str,"aliases":[str],"meaning":str,"how_to_use":str,"origin":str,"examples":[str],"confidence":"high|medium|low"}',
  '规则：正文没讲这个梗就 {"is_meme":false}；出处正文没写就留空，不许用自己的知识补；how_to_use 里不许出现出自/来源。',
  '各字段中文，meaning/how_to_use 各≤200字，origin≤300字，examples 最多3条各≤40字。',
].join('\n')

/** 从可能带 markdown 围栏的文本里抠出第一个 JSON 对象 */
export function 抠JSON(text) {
  let s = String(text ?? '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = s.indexOf('{')
  if (start < 0) return null
  // 从第一个 { 开始做括号配对，避免正文里的 } 干扰
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

const 截 = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) : t
}

/**
 * 校验并归一化 LLM 返回的词条。不合格就返回 null（**绝不入库**）。
 * @param {object} raw LLM 的 JSON
 * @param {string} query 原始查询词（用于相关性兜底校验）
 * @returns {{ok:boolean, entry?:object, reason?:string}}
 */
export function 归一化词条(raw, query) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '不是对象' }
  if (raw.is_meme === false) return { ok: false, reason: '判定为非梗' }
  const conf = String(raw.confidence ?? '').toLowerCase()
  if (!['high', 'medium', 'low'].includes(conf)) return { ok: false, reason: `置信度非法：${raw.confidence}` }
  if (conf === 'low') return { ok: false, reason: '置信度过低' }

  const title = 截(raw.title, 字段上限.title)
  if (!title) return { ok: false, reason: '缺标题' }

  // ⚠️ 标题必须与查询词有交集，否则就是 LLM 抽到了别的东西
  //    （实测风险：搜「我Chovy」抓到知乎长文，里面还讲了别的好几个梗）
  const q = String(query ?? '').trim()
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
    .map((a) => 截(a, 字段上限.title))
    .filter(Boolean)
    .slice(0, 字段上限.aliases)
  if (q) {
    const 相关 = title.includes(q) || q.includes(title) || aliases.some((a) => a.includes(q) || q.includes(a))
    if (!相关) return { ok: false, reason: `标题「${title}」与查询词「${q}」无关` }
  }

  const meaning = 截(raw.meaning, 字段上限.meaning)
  const how = 截(raw.how_to_use, 字段上限.how_to_use)
  if (!meaning && !how) return { ok: false, reason: '含义与用法都为空' }

  const examples = (Array.isArray(raw.examples) ? raw.examples : [])
    .map((e) => 截(e, 字段上限.exampleLen))
    .filter(Boolean)
    .slice(0, 字段上限.examples)

  return {
    ok: true,
    entry: {
      title,
      aliases: aliases.join(','),
      meaning,
      how_to_use: how,
      origin: 截(raw.origin, 字段上限.origin),
      examples,
      confidence: conf,
    },
  }
}

/**
 * 调 LLM 抽取词条。
 * @param {object} opts
 * @param {string} opts.query  查询词
 * @param {string} opts.text   正文（多页拼一起也行）
 * @param {(o: {messages: Array, maxTokens: number, temperature: number, model?: string}) => Promise<string>} opts.callLLM
 * @param {string} [opts.model]
 * @returns {Promise<{ok:boolean, entry?:object, reason?:string, raw?:string}>}
 */
export async function 抽取词条({ query, text, callLLM, model }) {
  const q = String(query ?? '').trim()
  const body = String(text ?? '').slice(0, 8000)
  if (!q || !body) return { ok: false, reason: '输入为空' }
  // ⚠️ 重试两轮：推理模型有时把 max_tokens 全烧在 reasoning 上返回空 content
  //    （qq-memory B-025 记过）。第二轮加大预算并强调"先输出 JSON"。
  const 尝试 = [
    { maxTokens: 600, extra: '' },
    { maxTokens: 1500, extra: '\n\n注意：先直接输出 JSON 对象本身，不要写任何思考过程。' },
  ]
  let raw = ''
  let lastErr = ''
  for (const a of 尝试) {
    try {
      raw = await callLLM({
        messages: [
          { role: 'system', content: 系统提示 },
          { role: 'user', content: `要查的梗：${q}\n\n网页正文：\n${body}${a.extra}` },
        ],
        maxTokens: a.maxTokens,
        temperature: 0,
        ...(model ? { model } : {}),
        // ⚠️ 关键：关掉推理链。deepseek-v4.1-flash 默认会把 max_tokens 全烧在 reasoning 上，
        //    返回空 content（qq-memory B-025 记过同一现象）。
        //    实测（2026-11-19 经本机 8788 中转）：
        //      reasoning_effort: 'off' / 'disabled' → 上游 400 拒绝
        //      reasoning_effort: 'none'             → ✓ 正常返回，且快（约 3s）
        reasoningEffort: 'none',
      })
      if (String(raw ?? '').trim()) break
    } catch (e) {
      lastErr = String(e?.message ?? e)
    }
  }
  if (!String(raw ?? '').trim()) {
    return { ok: false, reason: `LLM 调用失败：${lastErr || '两次都返回空'}` }
  }
  const json = 抠JSON(raw)
  if (!json) return { ok: false, reason: 'LLM 没返回合法 JSON', raw: String(raw).slice(0, 300) }
  const norm = 归一化词条(json, q)
  return { ...norm, raw: String(raw).slice(0, 300) }
}

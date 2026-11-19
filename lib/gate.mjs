/**
 * 场景分流（解释梗 / 玩梗）—— 2026-11-19 用户方案 1+2
 *
 * 问题：原插件只有一套规则、一份原料（usage 平均 264 字百科体 + summary 112 字出处），
 *   无差别塞给模型 → 模型被考据材料带成「解释梗」，而群里多数时候只是「在玩梗」。
 *
 * 设计：
 *   同一条消息，先判「用户到底要什么」：
 *     解释场景：明确在问这个梗是什么（问梗句式 / 「XX 是啥」）
 *     玩梗场景：句子冒出了库里的梗词，但不是问句 → 用户在用/接梗，机器人该跟着玩
 *     不触发：  闲聊、停用词、没有梗词
 *   再按场景给**不同的注入包**：
 *     解释包：含义 + 出处，上限宽（≤300 + ≤200）
 *     玩法包：只给「怎么接」，**物理剔除出处**，上限窄（≤200），并禁止解释
 *
 * 铁律：
 *   - 判定是**纯正则，零 token**。不要为此引入模型调用 —— 群里每轮多一次往返没法接受。
 *   - 玩法包里绝不能出现「出处/来源/最早出自」这类段落，否则又带成解释。
 */

/** 解释场景的强信号：明确在问「这个梗是什么」 */
const 解释强信号 = /(?:是什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么来的|为什么叫|怎么火的|哪来的|是啥梗)/

/** 解释场景的弱信号：「XX 是啥 / XX 是什么 / XX 咋念」——需要 XX 在库中才成立 */
const 解释弱信号 = /^(.{2,12}?)(?:是啥|是什么|咋念|怎么念)$/

/** 这些词出现在问句主语位时没有信息量（「这是什么梗」不该去查「这」） */
const 无语义主语 = new Set([
  '这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面', '楼上',
])

/** 去掉标点与语气尾巴，便于判句尾 */
function 去尾(t) {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[？?。！!~～…\s]+$/g, '')
    .trim()
}

/**
 * 判定场景。
 * @param {string} text 已清洗过的用户消息（不含发送者前缀）
 * @param {(q: string) => object | null} lookup 查词库函数（用于弱信号与玩梗判定）
 * @returns {{scene: '解释'|'玩梗'|null, query: string, reason: string}}
 */
export function 判定场景(text, lookup, isExact) {
  const t = 去尾(text)
  if (!t) return { scene: null, query: '', reason: '空文本' }

  // ① 强解释信号：句子里出现「什么意思/是什么梗」等，且前面有个像样的词
  if (解释强信号.test(t)) {
    const q = 提取主语(t)
    if (q && !无语义主语.has(q) && lookup(q)) {
      return { scene: '解释', query: q, reason: '强问梗句式' }
    }
    // 强信号但查不到主语 → 仍算「想解释」，交给上层去查不到分支（可联网兜底）
    if (q && !无语义主语.has(q) && q.length >= 2) {
      return { scene: '解释', query: q, reason: '强问梗句式（库中未命中）' }
    }
  }

  // ② 弱解释信号：「绝绝子是啥」——主语必须在库里，否则是普通疑问
  const weak = 解释弱信号.exec(t)
  if (weak) {
    const q = weak[1].trim()
    if (q && !无语义主语.has(q) && lookup(q)) {
      return { scene: '解释', query: q, reason: '「XX是啥」且库中有' }
    }
  }

  // ③ 玩梗：整句里冒出了库里的梗词（不论是否问句形态）
  //    这一步是新增能力：原实现只在「整句就是个裸词」时才查，
  //    导致「这梗百科都不如百度百科吧」这类带梗词的句子完全不触发。
  const hit = 找句中梗词(t, lookup, isExact)
  if (hit) return { scene: '玩梗', query: hit, reason: '句中含库内梗词' }

  return { scene: null, query: '', reason: '未命中' }
}

/** 从问句里取主语：「绝绝子是什么意思」→「绝绝子」 */
function 提取主语(t) {
  const m = 解释强信号.exec(t)
  if (!m) return ''
  let head = t.slice(0, m.index)
  head = head
    .replace(/^[，,。.！!？?\s]+|[，,。.！!？?\s]+$/g, '')
    .replace(/^(这个梗|那个梗|这梗|那梗)/, '')
    .replace(/^(到底|究竟|所以|那|这)+/, '')
    .replace(/(这个梗|那个梗|这梗|那梗|这个词|那个词)$/, '')
    // 只剥纯虚词尾巴：「绝绝子是」→「绝绝子」、「我Chovy到底」→「我Chovy」。
    // ⚠️ 但「蚌埠住了」的「了」是词的一部分，不能剥（实测：剥掉后变成「蚌埠住」，查不到库）。
    //    所以只剥**多字虚词**（到底/究竟/究竟）和单个「是」，不剥单字「了/的/地」。
    .replace(/(到底|究竟|到底儿)$/, '')
    .replace(/是$/, '')
    .trim()
    .trim()
  return head
}

/**
 * 在整句里找库内梗词。
 * 策略：按可能的分隔切出候选片段（中英混排、标点、空格），2~12 字，
 *   从长到短试，命中即返回（长词优先，避免「码头」抢在「去码头整点薯条」前面）。
 * @param {string} t 已清洗文本
 * @param {(q: string) => object | null} lookup
 * @returns {string} 命中的词；没有则空串
 */
/**
 * 通用成分词黑名单：它们是句子骨架，不是梗。
 * 实测踩到：「今天天气怎么样」被切出「怎么样」而在库中命中（库里真有一个叫"怎么样"的条目），
 * 于是闲聊被误判成玩梗。这类词一律不参与句中匹配。
 */
export const 通用词 = new Set([
  '怎么样', '怎么', '什么', '为什么', '多少', '可以', '是不是', '能不能', '有没有',
  '知道', '觉得', '时候', '现在', '今天', '明天', '昨天', '这个', '那个', '他们', '我们',
  '你们', '一个', '没有', '就是', '还是', '但是', '因为', '所以', '如果', '虽然',
  '一下', '一些', '有点', '真的', '不是', '这样', '那样', '怎么弄', '好不好',
])

export function 找句中梗词(t, lookup, isExact) {
  // 先剥掉标点，避免把「是什么意思」当词去查
  const body = t
    .replace(/[？?！!。，,、；;：:「」“”"'（）()【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!body) return ''

  // ⚠️ 这里必须用**严格命中**（标题==候选 或 别名==候选），不能用查词库那套
  //    「前缀/包含」匹配 —— 否则「太绝绝子了」整段会被前缀匹配成「绝绝子」，
  //    等于把整句话当梗词，注入时标题就变成了一整句（实测踩到）。
  const 命中 = (cand) => {
    if (!cand || 通用词.has(cand)) return false
    return isExact ? Boolean(isExact(cand)) : Boolean(lookup(cand))
  }

  const 片段 = body.split(' ').filter((s) => s.length >= 2)
  const 排好 = 片段.sort((a, b) => b.length - a.length)

  for (const seg of 排好) {
    if (seg.length <= 12 && 命中(seg)) return seg
    // 滑窗：从长到短
    const maxLen = Math.min(12, seg.length)
    for (let len = maxLen; len >= 3; len--) {
      for (let i = 0; i + len <= seg.length; i++) {
        const cand = seg.slice(i, i + len)
        if (命中(cand)) return cand
      }
    }
    // 纯数字/字母的 2 字放宽（「48」「kfc」），但仍要求严格命中
    for (let i = 0; i + 2 <= seg.length; i++) {
      const cand = seg.slice(i, i + 2)
      if (/^[0-9a-z]+$/i.test(cand) && 命中(cand)) return cand
    }
  }
  return ''
}

/** 从 usage 里剥掉「出处/来源/最早出自」这类段落 —— 玩法包绝不能带出处 */
export function 剥出处(s) {
  return String(s || '')
    .split(/\n+/)
    .filter((line) => !/^(来源|出处|最早出自|起源于|诞生的?背景)/.test(line.trim()))
    .join('\n')
    .trim()
}

/** 紧凑截断：压空白、去空行 */
function 紧(s, n) {
  const t = String(s == null ? '' : s).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 解释包：含义 + 出处，宽一点，允许科普。
 * @param {object} row 词条
 * @returns {string}
 */
export function 解释包(row) {
  if (!row) return ''
  const 标题 = String(row.title || '')
  const 含义 = 紧(row.summary, 200)
  const 用法 = 紧(剥出处(row.usage), 300)
  const 出处 = 紧(row.origin, 300)
  const lines = [`[梗百科·解释模式]「${标题}」`]
  if (含义) lines.push(`含义：${含义}`)
  if (用法) lines.push(`用法：${用法}`)
  if (出处) lines.push(`出处：${出处}`)
  return lines.join('\n')
}

/**
 * 玩法包：只给「怎么接」，禁止出处。
 * @param {object} row 词条
 * @returns {string}
 */
export function 玩法包(row) {
  if (!row) return ''
  const 标题 = String(row.title || '')
  const 接法 = 提炼接法(row)
  const lines = [`[梗百科·玩梗模式]「${标题}」`]
  if (接法) lines.push(`怎么接：${接法}`)
  return lines.join('\n')
}

/**
 * 从百科体 usage 里提炼「怎么用」——这是玩法包能不能真的帮上忙的关键。
 *
 * 为什么不能直接截断：实测 usage 是百科体（「xx子是一种…格式」「YYDS 现已成为
 * 网络流行语，主要用于…」），整段塞进去模型只会复述它 = 又变成解释。
 *
 * 提炼优先级：
 *   ① 例句（带「例子：」「例如」「如：」「可以用」的短句）—— 直接照抄最像人话
 *   ② 首个分点里的短句（去掉「是一种…的格式」这类定义句）
 *   ③ 都提不出就退回截断 120 字
 */
export function 提炼接法(row) {
  const raw = 剥出处(row.usage)
  if (!raw) return ''

  const 例子 = []
  const 分点 = []
  for (const line of raw.split(/\n+/)) {
    const s = line.trim().replace(/^[*\-\d.、)）\s]+/, '').trim()
    if (!s) continue
    // 例句：带引号或「例子/例如/如：/可以用」标记
    if (/^(例子|例如|如|可以用|比如)|[「“"][^」”"]{6,}[」”"]/.test(s)) {
      const quoted = s.match(/[「“"]([^」”"]{4,40})[」”"]/g)
      if (quoted) 例子.push(...quoted.map((q) => q.replace(/[「」“”"]/g, '')))
      continue
    }
    // 定义句（「是一种…」「现已成为…」）跳过 —— 它是解释不是用法
    if (/^(是?一种|指的是|现已成为|最初|来源于|出自)/.test(s)) continue
    if (s.length >= 6) 分点.push(s)
  }

  if (例子.length) {
    // 过滤掉「你人生的意义是什么？」这类**提问句**——它是被接的那句，不是接法本身
    const 可用 = 例子.filter((e) => !/[？?]$/.test(e) && e.length <= 30)
    if (可用.length) return `直接用在句子里，如 ${可用.slice(0, 2).map((e) => `「${e}」`).join(' / ')}`
  }
  if (分点.length) return 紧(分点[0], 120)
  return 紧(raw, 120)
}

/** 解释场景的规则（允许科普，但仍别念词条） */
export const 解释规则 = [
  '对方在问这个梗是什么意思，可以回答，但控制在 2~3 句。',
  '说清「什么意思」+「怎么用」，出处最多一句，别整段照搬。',
  '不要念标签、不要念「来源」小节标题。',
].join('\n')

/** 玩梗场景的规则（禁止解释 —— 这是方案 1 的核心） */
export const 玩梗规则 = [
  '**这一轮不许解释这个梗**，对方的重点不是问它什么意思。',
  '直接把它当成你自己会用的词，用在一句短话里接上去。',
  '不要说出处、不要科普、不要加「这个词意思是…」这种句式。',
  '拿不准怎么用就别硬用，正常接话即可。',
].join('\n')

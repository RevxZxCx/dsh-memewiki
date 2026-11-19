/**
 * 场景分流测试 —— 方案 1+2（解释 vs 玩梗）。
 *
 * 为什么要测：分流一旦判错，注入的原料就是错的 ——
 *   解释场景该给含义+出处，玩梗场景该给短接法且**绝不能带出处**。
 *   判错的表现很隐蔽：机器人照样能回话，只是"又变成解释了"。
 *
 * 反向变异（每条都实测过，见各测试注释）：
 *   M1 找句中梗词 改用 查词库（前缀匹配）→ 「太绝绝子了」整句被当梗词，T-PLAY-02 红
 *   M2 去掉通用词黑名单               → 「今天天气怎么样」命中「怎么样」，T-SKIP-01 红
 *   M3 玩法包 不剥出处                → T-PKT-02 红
 *   M4 主语提取 不剥尾部「是」          → 「绝绝子是」查不到，T-EXPL-01 红
 *   M5 场景判定 不再要求主语在库中       → 「这专业咋样」被当玩梗，T-SKIP-03 红
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { 判定场景, 找句中梗词, 解释包, 玩法包, 剥出处, 提炼接法, 通用词 } from '../lib/gate.mjs'

// 造一个假词库（不依赖真实 memes.db，测试可离线跑）
const DB = {
  绝绝子: { title: '绝绝子', usage: '“xx子”是一种网络用语格式，用于增强语气。\n例子：“这首歌真是绝绝子！”\n出处：来自贴吧', summary: '表示太绝了', origin: '源自网络' },
  yyds: { title: 'YYDS', usage: '赞美人物：如“梅西，YYDS！”\n出处：山泥若直播', summary: '永远的神', origin: '2019 全球总决赛' },
  典: { title: '典', usage: '例子：“你也太典了”', summary: '典型', origin: '贴吧' },
  怎么样: { title: '怎么样', usage: '假装库里有的通用词', summary: 'x', origin: '' },  // 故意放进来测黑名单
}
const lookup = (q) => DB[String(q || '').trim()] || null
const isExact = (q) => lookup(q)

/**
 * 「危险版」lookup：**复刻真实 查词库() 的前缀/包含语义**。
 * 为什么必须有它：上面那个 lookup 是精确的，测不出「整句被前缀匹配成梗词」这个真实风险。
 * 真实库里有「绝绝子」，而 查词库('太绝绝子了') 会因为前缀/包含规则返回「绝绝子」那条，
 * 于是候选串就被当成词名了 —— 必须用这个危险版才能验证 strict 隔离是否生效。
 */
const 危险lookup = (q) => {
  const s = String(q || '').trim()
  if (!s) return null
  if (DB[s]) return DB[s]
  // 复刻查词库的第 2/3/4 级：前缀、包含标题、标题包含查询
  for (const k of Object.keys(DB)) {
    if (k.toLowerCase().startsWith(s.toLowerCase())) return DB[k]
  }
  for (const k of Object.keys(DB)) {
    if (s.includes(k)) return DB[k]
  }
  for (const k of Object.keys(DB)) {
    if (k.includes(s)) return DB[k]
  }
  return null
}

// ───────────────────────── 解释场景 ─────────────────────────
test('T-EXPL-01 「X是什么意思」判解释；主语尾巴的「是」要剥掉（变异 M4）', () => {
  const r = 判定场景('绝绝子是什么意思', lookup, isExact)
  assert.equal(r.scene, '解释')
  assert.equal(r.query, '绝绝子', '主语不能带尾巴「是」，否则查不到库')
})

test('T-EXPL-02 「X啥意思」「X是啥」都判解释', () => {
  assert.equal(判定场景('yyds啥意思', lookup, isExact).scene, '解释')
  const r = 判定场景('绝绝子是啥', lookup, isExact)
  assert.equal(r.scene, '解释')
  assert.equal(r.query, '绝绝子')
})

test('T-EXPL-03 强问句但库里没有 → 仍判解释（交给上层走联网兜底）', () => {
  const r = 判定场景('蚌埠住了是什么意思', lookup, isExact)
  assert.equal(r.scene, '解释')
  assert.equal(r.query, '蚌埠住了')
})

test('T-EXPL-04 无语义主语（这/那/它）不比解释', () => {
  assert.equal(判定场景('这是什么意思', lookup, isExact).scene, null)
  assert.equal(判定场景('那是什么梗', lookup, isExact).scene, null)
})

// ───────────────────────── 玩梗场景 ─────────────────────────
test('T-PLAY-01 句中冒出梗词 → 判玩梗', () => {
  const r = 判定场景('这波操作绝绝子', lookup, isExact)
  assert.equal(r.scene, '玩梗')
  assert.equal(r.query, '绝绝子')
})

test('T-PLAY-02 整句不能被当成梗词（变异 M1：用前缀匹配就会中招）', () => {
  const r = 判定场景('太绝绝子了', lookup, isExact)
  assert.equal(r.scene, '玩梗')
  assert.equal(r.query, '绝绝子', '必须识别出真正的词，不能把整句「太绝绝子了」当词名')
  assert.notEqual(r.query, '太绝绝子了')
})

test('T-PLAY-03 前缀命中不算（严格匹配才认）', () => {
  // 「绝」是「绝绝子」的前缀，但严格匹配不该命中
  assert.equal(找句中梗词('绝了', lookup, isExact), '')
})

// ───────────────────────── 不该触发 ─────────────────────────
test('T-SKIP-01 通用词不进匹配（变异 M2：库里真有「怎么样」也不能命中）', () => {
  assert.ok(通用词.has('怎么样'), '通用词表必须包含「怎么样」')
  const r = 判定场景('今天天气怎么样', lookup, isExact)
  assert.equal(r.scene, null, '闲聊不能被库里同名的通用词带成玩梗')
})

test('T-SKIP-02 停用词/短句不触发', () => {
  assert.equal(判定场景('在吗', lookup, isExact).scene, null)
  assert.equal(判定场景('', lookup, isExact).scene, null)
})

test('T-SKIP-03 库里没有的普通句子不触发（变异 M5）', () => {
  assert.equal(判定场景('这专业咋样', lookup, isExact).scene, null)
  assert.equal(判定场景('我刚刚说了什么', lookup, isExact).scene, null)
})

// ───────────────────────── 两种包 ─────────────────────────
test('T-PKT-01 解释包含含义与出处', () => {
  const p = 解释包(DB.绝绝子)
  assert.match(p, /解释模式/)
  assert.match(p, /含义：/)
  assert.match(p, /出处：/)
})

test('T-PKT-02 玩法包**绝不能**带出处（变异 M3）', () => {
  const p = 玩法包(DB.绝绝子)
  assert.match(p, /玩梗模式/)
  assert.doesNotMatch(p, /出处|来源|最早出自|起源于/, '玩法包一旦带出处，模型又会去解释')
})

test('T-PKT-03 玩法包比解释包短（短接法，不是百科）', () => {
  const a = 解释包(DB.yyds).length
  const b = 玩法包(DB.yyds).length
  assert.ok(b < a, `玩法包(${b}) 应短于解释包(${a})`)
  assert.ok(b < 200, `玩法包应控制在 200 字符内，实际 ${b}`)
})

test('T-PKT-04 剥出处能剥掉「来源/出处」开头的行', () => {
  const raw = '怎么用：直接说\n来源：某处\n出处：某处\n最早出自：某年'
  const out = 剥出处(raw)
  assert.match(out, /直接说/)
  assert.doesNotMatch(out, /来源：|出处：|最早出自：/)
})

test('T-PKT-05 提炼接法优先给例句，不把定义句当用法', () => {
  const s = 提炼接法(DB.绝绝子)
  assert.match(s, /绝绝子/, '应包含例句')
  assert.doesNotMatch(s, /^是一种/, '不能把定义句当用法')
})

test('T-PKT-06 空词条不崩', () => {
  assert.equal(解释包(null), '')
  assert.equal(玩法包(null), '')
  assert.equal(提炼接法({}), '')
})

test('T-PLAY-04 句中检测必须与查词库的前缀语义**隔离**（变异 M1 的靶子）', () => {
  // 危险lookup 会把「太绝绝子了」前缀成「绝绝子」；如果 找句中梗词 用了它，
  // 返回的 query 就会是整句「太绝绝子了」。
  const viaDanger = 找句中梗词('太绝绝子了', 危险lookup, isExact)
  assert.equal(viaDanger, '绝绝子', '候选串应被识别成库里的真词，而不是整句')

  const r = 判定场景('太绝绝子了', 危险lookup, isExact)
  assert.equal(r.scene, '玩梗')
  assert.equal(r.query, '绝绝子')
  assert.notEqual(r.query, '太绝绝子了', '整句绝不能作为 query（否则注入标题变成一整句话）')
})

test('T-PLAY-05 传入的 lookup 再宽松，isExact 仍必须把关', () => {
  // 模拟变异体：忽略 isExact、直接信 lookup → 会返回整句
  const 只信lookup = (t, lk) => {
    const body = String(t).replace(/[？?！!。，,]/g, ' ')
    for (const seg of body.split(/\s+/)) if (seg && lk(seg)) return seg
    return ''
  }
  assert.equal(只信lookup('太绝绝子了', 危险lookup), '太绝绝子了',
    '这条断言证明：不隔离就会把整句当词名（正是我们要防的）')
})

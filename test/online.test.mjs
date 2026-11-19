/**
 * 方案 3（联网兜底）测试 —— 重点是**防污染闸**：宁可查不到，也不许入库垃圾。
 *
 * 反向变异（实测，见各条注释）：
 *   M1 去掉 is_meme 判定        → T-EXT-02 红
 *   M2 去掉置信度 low 拒绝      → T-EXT-03 红
 *   M3 去掉标题相关性校验       → T-EXT-04 红
 *   M4 入库时不查重直接 INSERT  → T-SAVE-02 红
 *   M5 入库时覆盖已有内容       → T-SAVE-02 红（同条）
 *   M6 去掉「只发词本身」改用带后缀 → T-WEB-01 红
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { 抠JSON, 归一化词条, 抽取词条 } from '../lib/extract.mjs'
import { migrateSchema, saveWebEntry, countBySource } from '../lib/autolearn.mjs'
import { searchMeme, html转文本 } from '../lib/websearch.mjs'

/** 造一个符合 fetch 契约的假响应（需要 headers.get 与 text()） */
function 假响应(text) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html' : null) },
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

function assertUnderTmp(p) {
  assert.ok(resolve(p).startsWith(resolve(tmpdir())), `写目标必须在 tmpdir 下：${p}`)
}

/** 造一个只有 memes/meta 的最小库 */
async function makeDb(preload = []) {
  const dir = mkdtempSync(join(tmpdir(), 'memewiki-online-'))
  assertUnderTmp(dir)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(dir, 'memes.db'))
  db.exec('CREATE TABLE memes (title TEXT PRIMARY KEY, slug TEXT, tags TEXT, usage TEXT, origin TEXT, other TEXT, summary TEXT, aliases TEXT)')
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  for (const r of preload) {
    db.prepare('INSERT INTO memes (title, usage, summary, origin, aliases) VALUES (?,?,?,?,?)')
      .run(r.title, r.usage ?? '', r.summary ?? '', r.origin ?? '', r.aliases ?? '')
  }
  return { db, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ───────────────── JSON 抽取 ─────────────────
test('T-JSON-01 抠 JSON：能容忍 markdown 围栏与前后废话', () => {
  assert.deepEqual(抠JSON('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(抠JSON('好的，结果如下：{"a":2} 希望有帮助'), { a: 2 })
  assert.equal(抠JSON('没有 JSON'), null)
  assert.equal(抠JSON('{坏'), null)
})

test('T-JSON-02 嵌套花括号与字符串里的 } 不干扰配对', () => {
  const s = '{"a":{"b":"含}字符"},"c":1}'
  assert.deepEqual(抠JSON(s), { a: { b: '含}字符' }, c: 1 })
})

// ───────────────── 归一化闸门 ─────────────────
test('T-EXT-01 正常词条通过归一化，字段被截断', () => {
  const r = 归一化词条({
    is_meme: true, title: '我Chovy', meaning: 'x'.repeat(300), how_to_use: 'y'.repeat(300),
    origin: 'z'.repeat(500), examples: ['a', 'b', 'c', 'd'], confidence: 'high',
  }, '我Chovy')
  assert.equal(r.ok, true)
  assert.ok(r.entry.meaning.length <= 200)
  assert.ok(r.entry.how_to_use.length <= 200)
  assert.ok(r.entry.origin.length <= 300)
  assert.equal(r.entry.examples.length, 3, '例句最多 3 条')
})

test('T-EXT-02 is_meme=false 必须拒绝（变异 M1）', () => {
  assert.equal(归一化词条({ is_meme: false, title: 'x' }, 'x').ok, false)
})

test('T-EXT-03 置信度 low 必须拒绝（变异 M2）', () => {
  const r = 归一化词条({ is_meme: true, title: 'x', meaning: 'm', confidence: 'low' }, 'x')
  assert.equal(r.ok, false)
  assert.match(r.reason, /置信度/)
})

test('T-EXT-04 标题与查询词无关必须拒绝（变异 M3）', () => {
  const r = 归一化词条({ is_meme: true, title: '我的世界', meaning: 'm', confidence: 'high' }, '我Chovy')
  assert.equal(r.ok, false)
  assert.match(r.reason, /无关/)
})

test('T-EXT-05 别名命中查询词也算相关', () => {
  const r = 归一化词条(
    { is_meme: true, title: '超威', aliases: ['我Chovy'], meaning: 'm', confidence: 'high' },
    '我Chovy',
  )
  assert.equal(r.ok, true)
})

test('T-EXT-06 含义与用法都空 → 拒绝', () => {
  assert.equal(归一化词条({ is_meme: true, title: 'x', meaning: '', how_to_use: '', confidence: 'high' }, 'x').ok, false)
})

test('T-EXT-07 抽取：LLM 返回坏 JSON 时报失败，不抛', async () => {
  const r = await 抽取词条({ query: 'x', text: '正文', callLLM: async () => '我不会 JSON' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /JSON/)
})

test('T-EXT-08 抽取：LLM 抛错时报失败，不抛', async () => {
  const r = await 抽取词条({ query: 'x', text: '正文', callLLM: async () => { throw new Error('网络挂了') } })
  assert.equal(r.ok, false)
  assert.match(r.reason, /LLM 调用失败/)
})

// ───────────────── 入库 ─────────────────
test('T-SAVE-01 迁移幂等，老词条标 sync', async () => {
  const { db, cleanup } = await makeDb([{ title: '老词条' }])
  try {
    const a = migrateSchema(db)
    assert.equal(a.ok, true)
    assert.equal(a.migrated, true)
    const b = migrateSchema(db)
    assert.equal(b.migrated, false, '第二次不该再迁移')
    assert.deepEqual(countBySource(db), { sync: 1, web: 0, manual: 0, total: 1 })
  } finally { cleanup() }
})

test('T-SAVE-02 已有同名词条时绝不覆盖内容（变异 M4/M5）', async () => {
  const { db, cleanup } = await makeDb([{ title: '绝绝子', usage: '权威用法', summary: '权威含义' }])
  try {
    migrateSchema(db)
    const r = saveWebEntry(db, { title: '绝绝子', meaning: '野说法', how_to_use: '野用法', confidence: 'high' }, { sources: ['u'] })
    assert.equal(r.action, 'skipped', '字段都有时应当跳过')
    const row = db.prepare('SELECT usage, summary, source FROM memes WHERE title=?').get('绝绝子')
    assert.equal(row.summary, '权威含义', '权威内容不能被 web 结果冲掉')
    assert.equal(row.usage, '权威用法')
    assert.equal(row.source, 'sync', '原条目来源不能被改成 web')
  } finally { cleanup() }
})

test('T-SAVE-03 已存在但字段为空 → 只补空字段', async () => {
  const { db, cleanup } = await makeDb([{ title: '某梗', usage: '', summary: '' }])
  try {
    migrateSchema(db)
    const r = saveWebEntry(db, { title: '某梗', meaning: '新含义', how_to_use: '新用法', confidence: 'high' })
    assert.equal(r.action, 'merged')
    assert.equal(db.prepare('SELECT summary FROM memes WHERE title=?').get('某梗').summary, '新含义')
  } finally { cleanup() }
})

test('T-SAVE-04 新词条入库带 web 标记与来源 URL', async () => {
  const { db, cleanup } = await makeDb()
  try {
    migrateSchema(db)
    const r = saveWebEntry(db, {
      title: '我Chovy', meaning: '空耳梗', how_to_use: '当感叹词', origin: '嘎子直播',
      examples: ['我Chovy 又翻车了'], confidence: 'high', aliases: '我超威',
    }, { sources: ['https://a.example/x'] })
    assert.equal(r.action, 'inserted')
    const row = db.prepare('SELECT source, confidence, sources_json, usage FROM memes WHERE title=?').get('我Chovy')
    assert.equal(row.source, 'web')
    assert.equal(row.confidence, 'high')
    assert.match(row.sources_json, /a\.example/)
    assert.match(row.usage, /我Chovy 又翻车了/, '例句要拼进 usage')
    assert.deepEqual(countBySource(db), { sync: 0, web: 1, manual: 0, total: 1 })
  } finally { cleanup() }
})

// ───────────────── 搜索 ─────────────────
test('T-WEB-01 搜索只发梗词本身（变异 M6：加后缀会把结果带偏）', async () => {
  let seenUrl = ''
  const fakeFetch = async (u) => { seenUrl = u; return 假响应('<h2><a href="https://a.example/1">我Chovy是什么梗</a></h2>') }
  await searchMeme('我Chovy', { fetchImpl: fakeFetch })
  const q = decodeURIComponent(seenUrl)
  assert.match(q, /q=我Chovy/)
  assert.doesNotMatch(q, /是什么梗 出处 用法/, '实测：加后缀会让 Bing 分词跑偏（查「我Chovy」变成「我的世界」）')
})

test('T-WEB-02 搜索结果按梗站优先排序', async () => {
  const html = `
    <h2><a href="https://random.example/a">某梗是什么梗</a></h2>
    <h2><a href="https://www.geng8.com/word/x">某梗 梗百科</a></h2>`
  const r = await searchMeme('某梗', { fetchImpl: async () => 假响应(html) })
  assert.equal(r.urls[0], 'https://www.geng8.com/word/x', '梗站应排在前面')
})

test('T-WEB-03 不相关结果被过滤（分词垃圾）', async () => {
  const html = '<h2><a href="https://baike.baidu.com/item/绝/22366">绝（汉语文字）_百度百科</a></h2>'
  const r = await searchMeme('绝绝子', { fetchImpl: async () => 假响应(html) })
  assert.equal(r.ok, false, '「绝（汉语文字）」不能当成「绝绝子」的结果')
})

test('T-WEB-04 搜索失败返回 ok=false 而不是抛', async () => {
  const r = await searchMeme('x', { fetchImpl: async () => { throw new Error('超时') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /失败/)
})

test('T-WEB-05 html转文本去掉脚本样式', () => {
  const t = html转文本('<html><script>var x=1</script><style>a{}</style><p>正文在这</p></html>')
  assert.match(t, /正文在这/)
  assert.doesNotMatch(t, /var x=1|\{\}/)
})

test('T-EXT-09 is_meme=false 但字段齐全时也必须拒绝（变异 M1 的靶子）', () => {
  // 陷阱：M1 只删 is_meme 判断时，若测试给的字段都是空的，
  // 「含义与用法都空」那道闸也会拦住 → 测不出 M1。
  // 所以这里**故意给足字段**，让 is_meme 成为唯一的拦截理由。
  const r = 归一化词条({
    is_meme: false,          // ← 明确判定不是梗
    title: '我Chovy',
    meaning: '字段齐全的含义',
    how_to_use: '字段齐全的用法',
    origin: '出处',
    confidence: 'high',
  }, '我Chovy')
  assert.equal(r.ok, false, 'is_meme=false 必须拒绝，不能因为字段齐全就放行')
  assert.match(r.reason, /非梗/)
})

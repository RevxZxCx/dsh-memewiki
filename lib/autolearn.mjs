/**
 * 自动入库：把 LLM 抽出的词条写进本地库，**打 web 标记**。
 *
 * 用户 2026-11-19 定案：
 *   「自动入库我认为可以直接加入我们的本地库，因为只是本地环境。
 *     不过，如果词条可以设置来源的话，我们应该标为 web 总结，
 *     用户也可以实际查看到 web fetch 引入的词条，也可以对这些词条进行二次审查，
 *     发现不对也能及时移除。」
 *   删除：硬删除 + 二次确认（在面板做）。
 *
 * 表结构（schema v2，插件启动时自动迁移）：
 *   memes 新增  source      'sync' | 'web' | 'manual'
 *               added_at    ISO 时间
 *               sources_json 来源 URL 数组
 *               confidence  high | medium | low
 *   meta 记 schema_version = '2'
 */

export const SCHEMA_VERSION = '2'

/** 新增列（幂等：已存在就跳过） */
const 新列 = [
  ['source', "TEXT NOT NULL DEFAULT 'sync'"],
  ['added_at', 'TEXT'],
  ['sources_json', 'TEXT'],
  ['confidence', 'TEXT'],
]

/**
 * 迁移到 schema v2。幂等，可在每次启动时调用。
 * @param {object} db DatabaseSync 实例（可写）
 * @returns {{ok:boolean, migrated:boolean, error?:string}}
 */
export function migrateSchema(db) {
  try {
    const cur = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()
    if (String(cur?.value ?? '') === SCHEMA_VERSION) return { ok: true, migrated: false }

    const cols = db.prepare('PRAGMA table_info(memes)').all().map((r) => r.name)
    for (const [name, def] of 新列) {
      if (!cols.includes(name)) db.exec(`ALTER TABLE memes ADD COLUMN ${name} ${def}`)
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_memes_source ON memes(source)')
    // 老词条都是 cnmeme 同步来的
    db.prepare("UPDATE memes SET source='sync' WHERE source IS NULL OR source=''").run()
    db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(SCHEMA_VERSION)
    return { ok: true, migrated: true }
  } catch (e) {
    return { ok: false, migrated: false, error: String(e?.message ?? e) }
  }
}

/** 把 entry 拼成库里 usage 字段的格式（保持与 cnmeme 同步的条目结构一致） */
function 拼usage(entry) {
  const parts = []
  if (entry.how_to_use) parts.push(entry.how_to_use)
  if (Array.isArray(entry.examples) && entry.examples.length) {
    parts.push(entry.examples.map((e) => `* 例子：${e}`).join('\n'))
  }
  return parts.join('\n')
}

/**
 * 写入一条 web 来源词条。
 *
 * 三道闸（防污染）：
 *   ① 已存在同名/同别名 → **不覆盖**，只补空字段（不冲掉 cnmeme 的权威内容）
 *   ② 字段限长（抽取层已截，这里再兜一次）
 *   ③ 记录来源 URL 与置信度，便于面板审查
 *
 * @param {object} db DatabaseSync（可写）
 * @param {object} entry 归一化后的词条
 * @param {object} [opts] { sources: string[], now?: number }
 * @returns {{ok:boolean, action:'inserted'|'skipped'|'merged', title?:string, reason?:string}}
 */
export function saveWebEntry(db, entry, opts = {}) {
  if (!entry?.title) return { ok: false, action: 'skipped', reason: '缺标题' }
  const sources = Array.isArray(opts.sources) ? opts.sources.slice(0, 5) : []
  const at = new Date(opts.now ?? Date.now()).toISOString()

  try {
    // 查重：标题或别名命中已有条目
    const rows = db.prepare('SELECT title, aliases, usage, origin, summary, source FROM memes').all()
    const 目标 = String(entry.title).toLowerCase()
    const 候选别名 = String(entry.aliases || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

    const 已有 = rows.find((r) => {
      const t = String(r.title || '').toLowerCase()
      if (t === 目标) return true
      if (候选别名.includes(t)) return true
      const al = String(r.aliases || '').split(',').map((s) => s.trim().toLowerCase())
      return al.includes(目标) || 候选别名.some((a) => al.includes(a))
    })

    if (已有) {
      // 不覆盖已有内容：只补空字段（这是保护 cnmeme 权威数据的关键）
      const 补 = []
      const 参 = []
      if (!String(已有.summary || '').trim() && entry.meaning) { 补.push('summary = ?'); 参.push(entry.meaning) }
      if (!String(已有.origin || '').trim() && entry.origin) { 补.push('origin = ?'); 参.push(entry.origin) }
      if (补.length) {
        db.prepare(`UPDATE memes SET ${补.join(', ')} WHERE title = ?`).run(...参, 已有.title)
        return { ok: true, action: 'merged', title: 已有.title, reason: '已存在，仅补空字段' }
      }
      return { ok: true, action: 'skipped', title: 已有.title, reason: '已存在且字段完整，不覆盖' }
    }

    db.prepare(
      `INSERT INTO memes (title, slug, tags, usage, origin, other, summary, aliases, source, added_at, sources_json, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?)`,
    ).run(
      String(entry.title).slice(0, 60),
      '',
      '',
      拼usage(entry).slice(0, 2000),
      String(entry.origin || '').slice(0, 500),
      '',
      String(entry.meaning || '').slice(0, 400),
      String(entry.aliases || ''),
      at,
      JSON.stringify(sources),
      String(entry.confidence || 'medium'),
    )
    return { ok: true, action: 'inserted', title: entry.title }
  } catch (e) {
    return { ok: false, action: 'skipped', reason: String(e?.message ?? e) }
  }
}

/**
 * 统计各来源条数（给面板用）。
 * @param {object} db
 * @returns {{sync:number, web:number, manual:number, total:number}}
 */
export function countBySource(db) {
  const out = { sync: 0, web: 0, manual: 0, total: 0 }
  try {
    for (const r of db.prepare('SELECT source, COUNT(*) n FROM memes GROUP BY source').all()) {
      const k = String(r.source || 'sync')
      if (k in out) out[k] = Number(r.n)
      out.total += Number(r.n)
    }
  } catch { /* 表还没迁移 */ }
  return out
}

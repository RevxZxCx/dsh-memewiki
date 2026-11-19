/**
 * 「这一轮用户到底说了什么」—— 读桥接写下的 pending 快照。
 *
 * 为什么要这个模块（2026-11-19 真机实测踩到）：
 *   插件的 最后用户消息(session) 依赖 `session.snapshotEvents()`，
 *   但 system-prompt 组装**早于**当前消息落盘（qq-memory 文档记过约 30ms），
 *   于是预查读到的是**上一条**消息 → 场景判定和查词全错。
 *   真机证据：发「这波操作绝绝子」，插件日志却记「预查命中：绝绝子（解释·强问梗句式）」；
 *   而生产库 `meta['pending:sid:58b01b50…'] = {"text":"这波操作绝绝子"}` —— 桥接写对了。
 *
 * 做法：直接复用 qq-memory 已经踩平坑的那套读法（同源真值，不另造口径）。
 *   桥接 memory-bridge.js 每条群消息都会写：
 *     · `pending:<scope>`              —— 按群，会被最后一条覆盖（多说话会串）
 *     · `pending:sid:<确定性 sessionId>` —— 按会话，更准
 *   读取顺序：真实 sessionId → 确定性 sid → 按群，带 120s 新鲜度闸与时钟回拨防护。
 *
 * ⚠️ 口径坑（照抄 qq-memory 的教训，别改）：
 *   桥接写键用的 kind 是 QQBot 的 `'group' | 'c2c'`，**不是** scope 前缀里的 `'person'`。
 *   实测 `sessionIdFor(app,'c2c',p) ≠ sessionIdFor(app,'person',p)`（哈希不同），
 *   照搬 `person` 会让私聊的按会话 pending 变成永远不命中的死代码。
 */

import { existsSync } from 'node:fs'

/** pending 快照的有效期：超过这个时间当作没有（避免拿上一轮残留） */
export const PENDING_TTL_MS = 120_000

/**
 * scope（`group:<openid>` / `person:<openid>`）→ 桥接公式算出的确定性 sessionId。
 * @param {(appId: string, kind: string, peerId: string) => string} sessionIdFor
 * @param {string} appId
 * @param {string} scope
 * @returns {string|null}
 */
export function deterministicSidFor(sessionIdFor, appId, scope) {
  try {
    const m = /^(group|person):(.+)$/.exec(String(scope ?? ''))
    if (!m || !appId || typeof sessionIdFor !== 'function') return null
    const kind = m[1] === 'group' ? 'group' : 'c2c'   // ⚠️ person → c2c，见文件头
    return sessionIdFor(appId, kind, m[2])
  } catch {
    return null
  }
}

/**
 * 从 store 读「这一轮真正说了什么」。
 * @param {object} store 需要 `db`（node:sqlite DatabaseSync 风格，支持 prepare().get()）
 * @param {object} opts
 * @param {string} opts.scope   `group:<openid>` / `person:<openid>`
 * @param {number} opts.now     判断新鲜度用的时间戳（显式传入便于测试）
 * @param {string} [opts.sessionId] 当前的（可能是轮换后的随机）sessionId
 * @param {string} [opts.appId]
 * @param {Function} [opts.sessionIdFor]
 * @param {number} [opts.ttlMs]
 * @returns {{text: string, ageMs: number, key: string} | null}
 */
export function readPendingMessage(store, opts) {
  const { scope, now, sessionId = null, appId = null, sessionIdFor = null, ttlMs = PENDING_TTL_MS } = opts || {}
  // fail-closed：now 坏掉会让 ageMs 变 NaN，而 `NaN > ttl` 恒为 false → 过期内容被静默放行
  if (!Number.isFinite(now)) return null
  if (!scope) return null

  const keys = []
  const real = sessionId ? String(sessionId) : null
  if (real && real.length > 20) keys.push(`pending:sid:${real}`)
  const derived = deterministicSidFor(sessionIdFor, appId, scope)
  if (derived && derived !== real) keys.push(`pending:sid:${derived}`)
  keys.push(`pending:${scope}`)

  let row = null
  try {
    for (const k of keys) {
      const r = store?.db?.prepare('SELECT v FROM meta WHERE k = ?').get(k)
      if (r?.v) { row = { v: r.v, k }; break }
    }
  } catch {
    return null
  }
  if (!row?.v) return null

  let parsed = null
  try { parsed = JSON.parse(row.v) } catch { return null }
  const at = Number(parsed?.at ?? 0)
  if (!parsed?.text || !Number.isFinite(at)) return null
  const ageMs = now - at
  // 负 ageMs = 时钟回拨/时间在未来：宁可当没有，也不要用错乱的话去判定
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) return null
  return { text: String(parsed.text), ageMs, key: row.k }
}

/**
 * 打开 mem.db 的只读连接（读 pending 用）。打不开返回 null —— 调用方退回 session 方案。
 * @param {string} dbPath
 * @returns {{db: object, close: Function} | null}
 */
export async function openPendingStore(dbPath) {
  try {
    if (!dbPath || !existsSync(dbPath)) return null
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    return { db, close: () => { try { db.close() } catch { /* ignore */ } } }
  } catch {
    return null
  }
}

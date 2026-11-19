/**
 * pending 快照读取测试。
 *
 * 为什么要它：system-prompt 组装早于消息落盘（约 30ms），
 * 直接用 session 会读到**上一条**消息 → 场景判定/查词全错。
 * 真机证据：发「这波操作绝绝子」，插件却按前一句判成「解释」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readPendingMessage, deterministicSidFor, PENDING_TTL_MS } from '../lib/pending.mjs'

/** 假 store：内存里放几条 meta */
function fakeStore(map) {
  return {
    db: {
      prepare: () => ({
        get: (k) => (map[k] ? { v: map[k] } : undefined),
      }),
    },
  }
}
const 快照 = (text, at) => JSON.stringify({ text, at })

test('T-PEND-01 读得到当前会话的 pending', () => {
  const sid = 'a'.repeat(36)
  const now = 1_000_000
  const store = fakeStore({ [`pending:sid:${sid}`]: 快照('这波操作绝绝子', now - 50) })
  const r = readPendingMessage(store, { scope: `sid:${sid}`, now, sessionId: sid })
  assert.equal(r.text, '这波操作绝绝子')
  assert.equal(r.ageMs, 50)
})

test('T-PEND-02 过期（>120s）不返回', () => {
  const sid = 'b'.repeat(36)
  const now = 1_000_000
  const store = fakeStore({ [`pending:sid:${sid}`]: 快照('旧的', now - PENDING_TTL_MS - 1) })
  assert.equal(readPendingMessage(store, { scope: `sid:${sid}`, now, sessionId: sid }), null)
})

test('T-PEND-03 时间在未来（时钟回拨）也当没有', () => {
  const sid = 'c'.repeat(36)
  const now = 1_000_000
  const store = fakeStore({ [`pending:sid:${sid}`]: 快照('未来', now + 5000) })
  assert.equal(readPendingMessage(store, { scope: `sid:${sid}`, now, sessionId: sid }), null,
    '负 ageMs 必须 fail-closed，否则会拿错乱的话去判定')
})

test('T-PEND-04 now 非法时 fail-closed（NaN > ttl 恒 false 是个经典坑）', () => {
  const sid = 'd'.repeat(36)
  const store = fakeStore({ [`pending:sid:${sid}`]: 快照('x', 1) })
  assert.equal(readPendingMessage(store, { scope: `sid:${sid}`, now: NaN, sessionId: sid }), null)
  assert.equal(readPendingMessage(store, { scope: `sid:${sid}`, now: undefined, sessionId: sid }), null)
})

test('T-PEND-05 坏 JSON / 缺 text / 缺 at 都不崩', () => {
  const sid = 'e'.repeat(36)
  for (const bad of ['{坏', '{}', JSON.stringify({ text: '' , at: 1 }), JSON.stringify({ at: 1 })]) {
    const store = fakeStore({ [`pending:sid:${sid}`]: bad })
    assert.equal(readPendingMessage(store, { scope: `sid:${sid}`, now: 1_000_000, sessionId: sid }), null)
  }
})

test('T-PEND-06 store 抛错也返回 null（绝不阻塞预查）', () => {
  const store = { db: { prepare: () => { throw new Error('db closed') } } }
  assert.equal(readPendingMessage(store, { scope: 'sid:x', now: 1 }), null)
})

test('T-PEND-07 确定性 sid 口径：person 必须映射成 c2c（不是 person）', () => {
  const calls = []
  const sidFor = (app, kind, peer) => { calls.push([app, kind, peer]); return `sid-${kind}-${peer}` }
  assert.equal(deterministicSidFor(sidFor, 'app1', 'group:g123'), 'sid-group-g123')
  assert.equal(deterministicSidFor(sidFor, 'app1', 'person:p123'), 'sid-c2c-p123',
    '实测 sessionIdFor(app,"c2c",p) ≠ sessionIdFor(app,"person",p)，照搬 person 会让私聊永远读不到')
  assert.equal(deterministicSidFor(sidFor, 'app1', '不合法'), null)
  assert.equal(deterministicSidFor(sidFor, '', 'group:g'), null, '缺 appId 时返回 null 而不是瞎算')
})

test('T-PEND-08 now 为 NaN 时 fail-closed（双保险，实测两层都能挡住）', () => {
  // ⚠️ 如实记录：实现里有**两层** NaN 防护 ——
  //   ① 开头 `if (!Number.isFinite(now)) return null`
  //   ② 后面 `if (!Number.isFinite(ageMs) ...) return null`
  // 反向变异实测：只删掉 ①，这条仍然绿（因为 ② 接住了，ageMs = NaN - 0 = NaN）。
  // 所以这条测的是「NaN 最终不会放行」这个**行为**，不是「① 存在」这个实现细节。
  // 保留两层是有意的：任何一层被后人删掉，另一层仍守得住。
  const sid = 'f'.repeat(36)
  const store = fakeStore({ [`pending:sid:${sid}`]: 快照('x', 0) })
  for (const badNow of [Number.NaN, undefined, null, Infinity]) {
    const r = readPendingMessage(store, { scope: `sid:${sid}`, now: badNow, sessionId: sid })
    assert.equal(r, null, `now=${String(badNow)} 必须 fail-closed（NaN > ttl 恒 false 是个经典假绿）`)
  }
})

test('T-PEND-09 轮换后的真实 sid 对不上派生 sid 时，必须靠回退命中（真机踩过的死代码坑）', () => {
  // 真实场景：session.id = 99796c1e…（轮换产生的随机 UUID），
  //          桥接写的键 = 58b01b50…（sessionIdFor(appId,'group',本群)）
  // 只按真实 id 查是**永远不命中**的死代码。
  const 真实sid = '99796c1e-8844-42ce-ba49-3341b5a1837f'
  const 派生sid = '58b01b50-8eae-1c29-daef-c2e1c599fe83'
  const now = 1_000_000
  const store = fakeStore({ [`pending:sid:${派生sid}`]: 快照('yyds到底是什么意思', now - 100) })

  // ① 只按真实 sid 查 → 读不到（证明这是死代码）
  assert.equal(readPendingMessage(store, { scope: `sid:${真实sid}`, now, sessionId: 真实sid }), null)

  // ② 按派生 sid 查 → 命中
  const hit = readPendingMessage(store, { scope: `sid:${派生sid}`, now, sessionId: 派生sid })
  assert.equal(hit?.text, 'yyds到底是什么意思')
})

test('T-PEND-10 三重回退顺序：真实 sid 优先于派生 sid', () => {
  const 真实sid = '99796c1e-8844-42ce-ba49-3341b5a1837f'
  const 派生sid = '58b01b50-8eae-1c29-daef-c2e1c599fe83'
  const now = 1_000_000
  // 两个键同时存在时，取真实 sid 那条（更新更准）
  const store = fakeStore({
    [`pending:sid:${真实sid}`]: 快照('最新的', now - 10),
    [`pending:sid:${派生sid}`]: 快照('旧的', now - 500),
  })
  assert.equal(readPendingMessage(store, { scope: `sid:${真实sid}`, now, sessionId: 真实sid })?.text, '最新的')
})

test('T-PEND-11 取不到 scope 时兜底扫描最新 freshest（真机实测 session 上没有 group_openid）', async () => {
  const { readLatestFreshPending } = await import('../lib/pending.mjs')
  const now = 1_000_000
  const store = {
    db: {
      prepare: () => ({
        all: () => [
          { k: 'pending:group:AAAA', v: 快照('旧的群消息', now - 60_000) },
          { k: 'pending:group:BBBB', v: 快照('最新的', now - 100) },
          { k: 'pending:group:CCCC', v: 快照('过期的', now - 200_000) },
          { k: 'pending:group:DDDD', v: '{坏JSON' },
        ],
      }),
    },
  }
  const hit = readLatestFreshPending(store, { now })
  assert.equal(hit.text, '最新的', '应取 120s 内 at 最大的那条')
  assert.equal(hit.key, 'pending:group:BBBB')
})

test('T-PEND-12 兜底扫描：全部过期时返回 null（绝不拿旧消息冒充本轮）', async () => {
  const { readLatestFreshPending } = await import('../lib/pending.mjs')
  const now = 1_000_000
  const store = {
    db: { prepare: () => ({ all: () => [{ k: 'pending:group:X', v: 快照('很久以前', now - 999_999) }] }) },
  }
  assert.equal(readLatestFreshPending(store, { now }), null)
})

test('T-PEND-13 兜底扫描：now 非法 fail-closed', async () => {
  const { readLatestFreshPending } = await import('../lib/pending.mjs')
  const store = { db: { prepare: () => ({ all: () => [{ k: 'pending:group:X', v: 快照('x', 1) }] }) } }
  assert.equal(readLatestFreshPending(store, { now: NaN }), null)
})

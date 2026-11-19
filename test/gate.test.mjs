/**
 * 预查闸门回归测试 —— 专治「群消息前缀没剥干净 → 预查永远不触发」。
 *
 * 背景（2026-11-19 生产实测）：
 *   桥接给群消息加的形状是三段叠加的
 *     `[昵称 (32位openid)] <@机器人id> 正文 (@you)`
 *   而旧版 清文本() 只剥 `@xxx`，前缀整串留着
 *   → 问梗模式（要求句尾是"什么意思"等）匹配失败
 *   → 预查返回 ''，**词库永远没被用上**，而插件日志一切正常、doctor 全绿。
 *
 * 这个坑的隐蔽性：单看日志「预查注入已注册」是绿的，只有真机发一条才知道没生效。
 * 所以必须用**真实 envelope 形状**做断言，且做反向变异（改回旧实现必须红）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { __test } from '../lib/index.js'

const { 清文本, 提取查询 } = __test
const ID = '62843A73EBF08AC8C3EB0A418ABDE915'
const BOT = '3F705855501DEB243631E3E5313CF934'

/** 桥接真实 envelope：`[昵称 (openid)] <@bot> 正文 (@you)` */
const envelope = (text, { mentioned = true } = {}) =>
  `[神经病收留所 李主任 (${ID})] <@${BOT}> ${text}${mentioned ? ' (@you)' : ''}`

test('T-CLEAN-01 真实 @ 消息：三段前缀全部剥掉', () => {
  assert.equal(清文本(envelope('绝绝子是什么意思')), '绝绝子是什么意思')
})

test('T-CLEAN-02 真实 @ 消息：能提取出查询词（这是真机 bug 的核心断言）', () => {
  // 变异：把清文本退回「只剥 @xxx」的旧实现 → 这条必红（返回 null）
  assert.equal(提取查询(envelope('绝绝子是什么意思')), '绝绝子')
})

test('T-CLEAN-03 裸词 @ 也能命中', () => {
  assert.equal(提取查询(envelope('yyds')), 'yyds')
})

test('T-CLEAN-04 未 @ 消息（无 <@> 与 (@you)）同样能剥', () => {
  assert.equal(清文本(envelope('绝绝子是什么意思', { mentioned: false })), '绝绝子是什么意思')
})

test('T-CLEAN-05 长昵称 + 长 openid 不能漏剥（坑：限死长度会漏）', () => {
  // 昵称长到 40 字、openid 32 位，整段超 80 字符
  const longName = '这是一个特别特别长的群昵称用来测试前缀剥离是否稳健不要限死长度'
  const raw = `[${longName} (${ID})] <@${BOT}> yyds (@you)`
  assert.equal(清文本(raw), 'yyds')
})

test('T-CLEAN-06 闲聊不误触发', () => {
  assert.equal(提取查询(envelope('今天天气怎么样')), null)
  assert.equal(提取查询(envelope('在吗')), null)   // 停用词
})

test('T-CLEAN-07 干净文本（无任何前缀）行为不变', () => {
  assert.equal(提取查询('绝绝子是什么意思'), '绝绝子')
  assert.equal(清文本('yyds'), 'yyds')
})

test('T-CLEAN-08 空输入 / 纯前缀不崩、返回空', () => {
  assert.equal(清文本(''), '')
  assert.equal(清文本(`[昵称 (${ID})] <@${BOT}> (@you)`), '')
  assert.equal(提取查询(''), null)
})

test('T-CLEAN-09 普通方括号不当成发送者标签（但无语义词仍过滤）', () => {
  // `[重要]` 会被剥（与桥接口径一致），剩下的「这是什么梗」因「这」属无语义词而返回 null
  assert.equal(清文本('[重要] 这是什么梗'), '这是什么梗')
  assert.equal(提取查询('[重要] 这是什么梗'), null)
})

test('T-CLEAN-10 唤醒词仍能剥（回归保护）', () => {
  assert.equal(清文本('小鲸鱼 绝绝子是什么意思'), '绝绝子是什么意思')
})

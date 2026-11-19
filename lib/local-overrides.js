/**
 * 本机定制层（fork of thawline/dsh-memewiki）
 *
 * 为什么要有这个文件：
 *   上游代码（lib/index.js 等）尽量保持原样，所有本机改动集中在这里，
 *   这样 `git merge upstream/main` 时冲突面最小 —— 上游改了 index.js，我们几乎不用管。
 *
 * 本文件导出三样东西：
 *   LOCAL_CONFIG_DEFAULTS  默认配置覆盖（叠在上游默认值之上）
 *   INJECT_SERVICES        必需依赖服务名（上游多声明了 webServer，会让机器人侧整条不激活）
 *   applyLocalCustomizations(ctx, api)  需要在上游 apply() 里做的最小挂钩
 *
 * 铁律：这里**不要**复制上游的业务逻辑。能覆盖就覆盖，能包装就包装。
 */

/** 必须在机器人侧保持可用的服务。webServer 走可选子上下文（见 optionalWebServer）。 */
export const INJECT_SERVICES = ['tools', 'systemPrompt']

/**
 * 默认配置覆盖。上游默认 { 自动思考梗:true, 串子开关:false, 串子程度:50, ... }。
 * 2026-11-19 用户要求：串子开关开、程度 >70（群里人设已无红线条款，由模型侧把关）。
 */
export const LOCAL_CONFIG_DEFAULTS = Object.freeze({
  串子开关: true,
  串子程度: 80,
  // 方案 3（2026-11-19 用户定案）：本地查不到时联网查，**同步等待**，期间不回复。
  联网兜底: true,
  兜底超时ms: 12000,
  兜底模型: '',          // 空 = 用 qq-memory 的 default（deepseek-v4.1-flash），并强制 reasoningEffort=none
})

/** 反馈功能：用户明确要求「不要开放给机器人」。置 true 即不注册 feedback_meme_wiki。 */
export const FEEDBACK_DISABLED = true

/**
 * 把 webServer 相关注册包进可选子上下文，拿不到服务就跳过（不报错、不影响工具与注入）。
 * @param {object} ctx cordis 插件上下文
 * @param {(child: object) => void} register 拿到带 webServer 的子上下文后要做的事
 * @param {(msg: string) => void} [log]
 */
export function optionalWebServer(ctx, register, log) {
  try {
    ctx.inject(['webServer'], (child) => {
      child.effect(() => {
        register(child)
      }, 'memewiki: settings api')
    })
  } catch (e) {
    log?.('设置页 API 跳过（没有 webServer）：' + (e && e.message))
  }
}

/** 合并默认配置：上游默认 + 本机覆盖 + 用户文件（用户文件优先级最高，由调用方叠加） */
export function mergeDefaults(upstreamDefaults) {
  return { ...upstreamDefaults, ...LOCAL_CONFIG_DEFAULTS }
}

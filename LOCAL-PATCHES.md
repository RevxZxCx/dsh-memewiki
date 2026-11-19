# 本机定制说明（LOCAL-PATCHES）

> ⚠️ **这个目录是 vendored 的上游代码**（[thawline/dsh-memewiki](https://github.com/thawline/dsh-memewiki)，MIT）。
> 我们**改了三处**，都写在代码注释里。**同步上游时必须把这些补丁重新打上**，否则：
> ① 反馈功能会复活（违背用户 2026-11-19 明确要求）；② 串子档位会掉回 50（玩梗尺度变保守）。

## 上游信息

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/thawline/dsh-memewiki |
| 同步时的版本 | **v0.1.20**（词库 2026-11-05 构建，6792 条） |
| 许可 | MIT（见 `LICENSE`）；词库数据版权归 cnmeme.wiki / 原项目，见 `NOTICE` |
| 依赖 | 零外部依赖，只用 `node:sqlite`（需 Node ≥ 22.13；本机 v22.23.3 ✓） |

## 补丁 ①：反馈功能永久禁用

**用户原话（2026-11-19）**：「实际的反馈我认为不要开放给机器人，也不要追问要不要反馈。」

改了三处（都在 `lib/index.js`）：

| 位置 | 改法 |
|---|---|
| `apply()` 里 feedback 工具注册 | 加 `const 反馈工具已禁用 = true`，为真时**不注册** `feedback_meme_wiki` |
| `接梗规则` 第 5→6 条 | 原「先接住…然后问一句『要不要把这个纠正反馈给梗维基』」→ 改为「照他给的说法用一句就行」+ 新增第 6 条「**绝不提反馈/提交/投稿**，也不要说要不要补进梗维基」 |
| `教梗提示()` | 原 3 条（含「主动问要不要补进梗维基」）→ 2 条，第 2 条改为「绝不提反馈，直接当没这回事」 |

**守卫**：`console.pkg.yml` 的 `memewiki.feedback-off` 探针 grep `const 反馈工具已禁用 = true`。
**这条探针做过反向变异**：把常量改成 `false` → 探针必须变红（否则等于没守）。

> 另：设置页的 `/api/memewiki/feedback/*` 路由仍在（源码保留，便于回溯）。
> 但**没有工具、没有 prompt 引导、也没领过凭证**，三重都不会触发，等于天然关闭。

## 补丁 ②：串子默认开且 80

**用户原话（2026-11-19）**：「我们的红线已经被删除掉了……我认为可以开这个开关，并且放在 70 以上。」

```js
// 上游：{ 串子开关: false, 串子程度: 50 }
// 本机：
const 默认配置 = { 自动思考梗: true, 串子开关: true, 串子程度: 80, ... }
```

**核实依据**：群聊人设 `groupPrompt` 里**已经没有红线段落**（只有 `directPrompt` 还留着「红线（比人设重要）」那段），
所以调高串子不会和我们自己写的人设自相矛盾。

**改法**：面板「梗百科」卡的滑杆随时可调回（改的是 `<QQ_DSH_HOME_BOT>/memewiki.json`，不碰代码）。

## 补丁 ③：webServer 改成可选依赖（否则机器人侧整条插件不生效）

**症状（本轮实测踩到）**：装好后 `systemctl status dsh-qqbot` 是 `active`，但 journal 里一行

```
dsh: warning: 1 entry did not activate
memewiki (dsh-memewiki): pending (waiting for service: webServer)
```

**根因**：上游 `inject = ['tools', 'systemPrompt', 'webServer']` 把 `webServer` 声明成**必需**。
而 `dsh-qqbot` 用 `dsh --profile qqbot` 跑，是纯机器人进程，**根本没有 Web 服务**
（Web 服务只在 `dsh web`／gateway 里）。cordis 因此把整条 entry 按在 pending 态，
**连着 `tools` 和 `systemPrompt` 一起不生效** —— 查词工具和预查注入全部哑掉。

**修法**：

```js
// 改前
export const inject = ['tools', 'systemPrompt', 'webServer']
// 改后：只声明真正必需的
export const inject = ['tools', 'systemPrompt']

// 设置页 API 改为可选子上下文（与 @deepseek-ai/dsh-session-query 同一用法）
ctx.inject(['webServer'], (孩子) => {
  孩子.effect(() => 注册设置页API(孩子), 'memewiki: settings api')
})
```

⚠️ **别写成** `inject = { required: [...], optional: [...] }` —— cordis 的 `Inject` 类型是
「服务名 → 拦截配置」的映射，**没有 required/optional 字段**，那样写会被当成两个不存在的服务名。

**判活方法**（只看 journal 那一行不够）：`grep . <QQ_DSH_HOME_BOT>/memewiki.log`，
正常应有 `apply 开始` / `工具 search_meme_wiki 已注册` / `预查注入已注册`。

## 同步上游的步骤

```bash
cd "${QQ_ROOT}/dsh-qq-bot/third_party"   # QQ_ROOT 见 deploy/env
rm -rf dsh-memewiki.new && git clone --depth 1 https://github.com/thawline/dsh-memewiki.git dsh-memewiki.new
rm -rf dsh-memewiki.new/.git
# ① 手工重打上面两个补丁（或在 old/new 之间 diff lib/index.js 逐处套用）
diff -u dsh-memewiki/lib/index.js dsh-memewiki.new/lib/index.js | head -80
# ② 词库：新版的 data/memes.db 更新，但**会冲掉面板里手改过的词条** —— 先导出再决定
# ③ 换目录，跑测试与 doctor
node --test "${QQ_ROOT}/dsh-qq-bot/plugins/qqbot-console/test/memewiki.test.mjs"
node "${QQ_ROOT}/dsh-qq-bot/scripts/doctor.mjs" --only qqbot-console
```

## 为什么不用 `pnpm add github:...`

那样装的话改动会在 `node_modules` 里（被 `.gitignore` 忽略、重装即丢），且换机要联网。
M12 的教训（三个巧合各掩盖一个 P0，其中一个就是"文件在 .gitignore 里"）明确反对这种形态。

## 词库更新

```bash
# 只补新词条（推荐，面板「更新词库」跑的就是这个）
cd "${QQ_ROOT}/dsh-qq-bot/third_party/dsh-memewiki"
node scripts/sync-cnmeme.mjs --no-existing

# 先看看会改什么
node scripts/sync-cnmeme.mjs --dry-run
```

⚠️ **不带 `--no-existing` 会覆盖已有词条的正文**（你在面板里手改过的也会被冲回站点版本）。
脚本自己会写 `data/memes.db.bak-<时间戳>`，统筹修复动作另外再备份一层。

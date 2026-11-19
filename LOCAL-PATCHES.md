# 本仓库 = thawline/dsh-memewiki 的本机 fork

> **这是 fork，不是补丁。** 2026-11-19 起，本仓库（[RevxZxCx/dsh-memewiki](https://github.com/RevxZxCx/dsh-memewiki)）
> 就是本机定制的**唯一真源**，只自用，不同步回上游。
>
> 生产环境不直接改插件代码，而是**从本 fork 拉取**到 `third_party/dsh-memewiki/`。

## 上游

| 项 | 值 |
|---|---|
| 上游 | https://github.com/thawline/dsh-memewiki（MIT） |
| 分叉点 | `588ec31`（v0.1.20，词库 6792 条 / 2026-11-05 构建） |
| 许可 | MIT（见 `LICENSE`）；词库数据版权归 cnmeme.wiki / 原项目，见 `NOTICE` |
| 依赖 | 零外部依赖，只用 `node:sqlite`（需 Node ≥ 22.13；本机 v22.23.3 ✓） |

## 设计原则：改动集中，别散进上游代码

所有本机定制放在 **`lib/local-overrides.js`**，`lib/index.js` 里只留最小挂钩
（import + 几处「改为引用本地层」）。这样 `git merge upstream/main` 时冲突面最小 ——
上游改了 index.js 的业务逻辑，我们几乎不用管。

当前 `index.js` 相对上游的差异：**约 40 行**，全部是「改为引用本地层」。

## 三处定制（都通过 lib/local-overrides.js 生效）

### ① `webServer` 不再必需（否则机器人侧整条插件不生效）

**症状（实测踩到）**：装好后 `systemctl status dsh-qqbot` 是 `active`，但 journal 里只有一行

```
dsh: warning: 1 entry did not activate
memewiki (dsh-memewiki): pending (waiting for service: webServer)
```

**根因**：上游 `inject = ['tools','systemPrompt','webServer']` 把 `webServer` 声明成**必需**。
而 `dsh-qqbot` 用 `dsh --profile qqbot` 跑，是纯机器人进程，**没有 Web 服务**
（Web 服务只在 `dsh web`/gateway 里）。cordis 因此把整条 entry 按在 pending 态，
**连着 `tools` 和 `systemPrompt` 一起不生效** —— 查词工具和预查注入全部哑掉。

**改法**：

```js
// lib/local-overrides.js
export const INJECT_SERVICES = ['tools', 'systemPrompt']

export function optionalWebServer(ctx, register, log) {
  ctx.inject(['webServer'], (child) => { child.effect(() => register(child), 'memewiki: settings api') })
}
```

⚠️ **别写成** `inject = { required: [...], optional: [...] }` —— cordis 的 `Inject` 类型是
「服务名 → 拦截配置」的映射，**没有 required/optional 字段**，那样写会被当成两个不存在的服务名。

**判活方法**（只看 journal 那行不够）：`grep . <QQ_DSH_HOME_BOT>/memewiki.log`，
正常应有 `apply 开始` / `工具 search_meme_wiki 已注册` / `预查注入已注册`。

### ② 反馈功能永久禁用

**用户原话（2026-11-19）**：「实际的反馈我认为不要开放给机器人，也不要追问要不要反馈。」

| 位置 | 改法 |
|---|---|
| `apply()` 里 feedback 工具注册 | `if (FEEDBACK_DISABLED) ... else try { ... }` —— 为真时不注册 |
| `接梗规则` 第 5→6 条 | 删掉「然后问一句要不要反馈给梗维基」，新增第 6 条「**绝不提反馈**」 |
| `教梗提示()` | 3 条 → 2 条，第 2 条改为「绝不提反馈，直接当没这回事」 |

**守卫**：统筹面板 `memewiki.feedback-off` 探针 grep `FEEDBACK_DISABLED = true`。
做过反向变异：把常量改成 `false` 必须变红。

> 设置页的 `/api/memewiki/feedback/*` 路由仍在（源码保留便于回溯），
> 但没有工具、没有 prompt 引导、也没领过凭证 —— 三重都不会触发，等于天然关闭。

### ③ 串子默认开且 80

**用户原话（2026-11-19）**：「我们的红线已经被删除掉了……我认为可以开这个开关，并且放在 70 以上。」

```js
// lib/local-overrides.js
export const LOCAL_CONFIG_DEFAULTS = { 串子开关: true, 串子程度: 80 }
```

**核实依据**：群聊人设 `groupPrompt` 里**已经没有红线段落**（只有 `directPrompt` 还留着），
调高串子不会与我们自己的人设自相矛盾。面板「梗百科」卡的滑杆随时可调回（改的是
`<QQ_DSH_HOME_BOT>/memewiki.json`，不碰代码）。

## 生产环境如何取用本 fork

```bash
# 生产机：把本 fork 的最新代码同步进 third_party
cd "${QQ_ROOT}/dsh-qq-bot/third_party"
rm -rf dsh-memewiki.new && git clone --depth 1 git@github.com:RevxZxCx/dsh-memewiki.git dsh-memewiki.new
rm -rf dsh-memewiki.new/.git
rsync -a --delete dsh-memewiki.new/ dsh-memewiki/ --exclude '.git'
rm -rf dsh-memewiki.new
# 然后跑测试与体检
node --test "${QQ_ROOT}/dsh-qq-bot/plugins/qqbot-console/test/memewiki.test.mjs"
node "${QQ_ROOT}/dsh-qq-bot/scripts/doctor.mjs" --only qqbot-console
```

⚠️ **别用 `git pull` 直接拉进 `third_party`** —— 那里不是 git 仓（否则会嵌套一个 .git，
污染主仓的 `git status`）。用上面的 clone + rsync，或者用 `git subtree`。

## 同步上游

```bash
git fetch upstream
git merge upstream/main     # 冲突应该很少见，因为本机改动都在 lib/local-overrides.js
node --check lib/index.js
```

## 词库更新

```bash
# 只补新词条（推荐；统筹面板「更新词库」按钮跑的就是这个）
node scripts/sync-cnmeme.mjs --no-existing

# 先看看会改什么
node scripts/sync-cnmeme.mjs --dry-run
```

⚠️ **不带 `--no-existing` 会覆盖已有词条的正文**（面板里手改过的也会被冲回站点版本）。
脚本自己会写 `data/memes.db.bak-<时间戳>`；统筹修复动作另外再备份一层。

## 词库必须入库（别被主仓 .gitignore 吃掉）

主仓 `.gitignore` 有一条 `**/data/*.db`（挡运行期数据库），会把生产侧 `third_party` 里的
`data/memes.db` 一起挡掉。主仓已加例外 `!third_party/dsh-memewiki/data/memes.db`，
并有 `memewiki.db-tracked` 探针（`git ls-files --error-unmatch`）守着。
**本 fork 仓里的词库本身是要提交的**，别加进 .gitignore。

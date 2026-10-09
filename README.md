# cc-token-optimizer

**English quick start** · [中文说明见下](#中文说明)

A Claude Code plugin that cuts what a session actually costs — read de-duplication, output trimming, cache-stall nudges, plus a live cost / cache-hit bar above the prompt. One command to install: no `settings.json` edits, no Node.

### Modules

| Module | Hook | What it does |
|---|---|---|
| **readDedup** | `PreToolUse` Read | Denies a re-read when the file is unchanged (mtime + size) and the requested range is already fully in context; partial overlap still passes. Three denials in a row → always passes. |
| **outputTrim** | `PostToolUse` Bash/PowerShell | Folds runs of ≥3 identical lines; output over 5000 chars is archived to disk first, then head/tail sampled into context (1500+1500, or 800+800 when the command failed). |
| **coldStartGuard** | `SessionStart` | A resumed session whose prompt cache expired gets one line: context size, estimated re-cache cost, and "consider `/clear`". |
| **modelDirector** | `SessionStart` · `UserPromptSubmit` · model switches · code edits | Tier discipline driven by `config.json`: cheap by default; mechanical detection suggests upgrading for coding turns (keyword hits or a recent edit — never on prompt length alone); the **first code edit of a turn is denied once** (code files by extension — editing docs is ignored; at most once per turn) so the model activates the upgrade skill and retries (one extra round trip; **off unless you set the `upgrade_skill` plugin option — it shows up in `/config`** — or `config.json`'s `upgrade.skillName`); the cache-dropping cost is shown before you switch models. |
| **status bar** · `/token-status` | above the prompt · command | rounds, context %, input + cache read/write, output, cache hit rate, cost (peak / off-peak). |
| **`tools/stats.mjs`** | manual | Sums denials, trims, folded lines and archive size across sessions, and estimates tokens saved. |

### Install

```
/plugin install cc-token-optimizer --marketplace Zoria-Lind/cc-token-optimizer
```

Claude Code 2.1.275+. It asks whether to add the marketplace (`y`), then for a scope — `user` applies it to every session. Modules load from inside the plugin, and state lives in the host's plugin KV (`<config dir>/plugins/store/cc-token-optimizer*.json`), so counters survive across sessions and hot reloads.

### Why it is cache-safe

- It acts only at the **birth point** of content — before it enters context. Stored history is never rewritten: changing past bytes invalidates the prompt cache and costs more than it saves.
- Everything is **fail-open**: on any error the plugin steps aside.
- Trimmed output is **archived, not summarized** — the full original goes to disk and the model only sees the path.

### Honest edges

- **Pricing, model names and the currency symbol default to DeepSeek** (dual peak / off-peak tiers, `currency: "¥"`). For another provider, edit `config.json` — pricing, model mapping, currency and the upgrade heuristic all live there, with no code changes.
- **modelDirector's upgrade nudge names a skill** (`coding-pro`, the author's own) — a skill's `model:` header is the only way a plugin can switch tiers without you typing `/model`. Blank `upgrade.skillName` in `config.json` and the advice degrades to a plain "switch with `/model`".
- **readDedup** compares mtime + size rather than content hashes (a same-second, same-size rewrite is missed), and recent Claude Code builds already answer whole-file re-reads natively — the remaining value is partial-overlap merging and long-span re-reads.
- A denied read costs one failed round while the model retries; hence the 3-strike escape hatch.
- Status-bar figures are aggregated from `turn.complete`, and `/compact` does not reset the running totals.

### Links

- [Claude Market](https://www.claudemarket.ai/plugins) — plugin directory

MIT licensed · Chinese documentation below.

---

## 中文说明

给 Claude Code 的 token 优化器。两层结构:

## hooks/(settings-hook 层,管内容)

`hooks/token-hook.mjs` —— 零依赖单文件,由 settings.json 的 hooks 驱动(stdin JSON → stdout JSON):

| 模块 | 事件 | 作用 |
|---|---|---|
| readDedup | PreToolUse Read | 文件未变(mtime+size)且请求区间已在上下文中 → deny,防重复读出生(缓存安全,不动历史) |
| recordRead | PostToolUse Read | 记录 mtime/size + 已读区间(合并区间;单会话 ≤200 文件;状态只留最近 5 会话) |
| outputTrim | PostToolUse Bash/PowerShell | ≥5000 字符输出头尾采样(成功 1500+1500,错误 800+800,先重复行折叠再按折叠后长度判断),裁剪前原输出存档(不注入) |
| coldStartGuard | SessionStart resume | 缓存已过期 → 注入一行提醒(上下文量 + 重缓存预估成本,建议 /clear) |
| modelDirector | SessionStart / UserPromptSubmit / PreModelSwitch / PostModelSwitch | **档位"导演"**(口径由 config.json 的 `defaultTier` 决定,见下) |

**modelDirector(混合双保险:模型自评纪律 + 启发式兜底 + 切换成本透明)**:

主力常驻档由 `plugin/config.json` 的 `defaultTier` 决定,纪律文本随之整体换向:

- **`cheap`(当前默认)**:启动恒 Flash,需要时由**用户本人** `/model` 升 Pro、下次启动自动回 Flash。**升级触发器必须在人** —— 若交给模型自评(让便宜档自己判断该不该升 Pro),它不知道自己便宜在哪,拿不准时不升级、埋头硬做,做砸了还没能力报告"我变差了"(2026-10-07 实测踩坑)。
- **`pro`**:主力常驻 Pro、跑腿活派 subagent(少一次升降档操作,贵)。

四个事件:

- SessionStart:记录当前模型 + 注入档位纪律(主力档=cheap 时:基础档 → "拿不准就建议升 Pro",Pro → "任务完成后切回基础档";主力档=pro 时反之)
- UserPromptSubmit 机械检测(coding 关键词/文件后缀 43 个,见 config.json;**长文本不再单独触发** —— 粘网页/日志不会误报升档):命中 → ① 向模型注入**条件式**指令"若你不在 Pro 档,动手前先调用 Skill(coding-pro)"(每轮都给、不按记录档位拦截——回合级升档自动回落,state 档位可能滞后一拍);② 向用户显示 systemMessage(10 分钟冷却,记录档位已是 Pro 时不发)。**升档由机械检测驱动,不依赖模型自评** —— 自指坑的解法
- **硬升档闸(`tool.call` Edit/Write/NotebookEdit)**:本回合**首次改动代码文件**(按扩展名判;改 `.md` 等文档不拦)时,若会话基础档还是便宜档、且配了 `upgrade_skill` 插件选项 → **拦一次**,要求模型先调用该技能再**重试**刚才那次调用(该回合余下推理走强档;代价=一次往返;**每回合最多强制一次**,靠回合序号去重)。**判据是模型自己的动作**(它决定改代码 = 这轮是 coding),不靠猜用户文本 —— "用户没说、自己也拿不准"的情况只有这条路能自动升档。`skillName` 留空则只提醒不拦
- 配套技能:`<配置目录>/skills/coding-pro/SKILL.md`(frontmatter `model:` 指向强档模型)—— 激活期间本回合跑 Pro、下一轮自动回落、不落盘。技能的 `model:` 头是 CC 里唯一"非用户触发"的模型切换机制(hook 切不了模型,官方文档确认;2026-10-07 实测跑通)
- PreModelSwitch 切换成本透明:"切换将丢弃提示缓存,上下文约 80k,重缓存约 ¥0.36",提示任务边界再切
- PostModelSwitch 记录新档位 + 注入对应提醒(切到 Pro:用完记得切回;切到基础档:拿不准就升)

- 逃生:同文件连续 3 次拦截自动放行(防 deny 死锁,DSH 教训)
- 铁律 fail-open:任何异常静默放行
- 状态文件:`<CLAUDE_CONFIG_DIR>/token-optimizer/state.json`(跟随配置目录,未设时回退 `~/.claude`;2026-10-07 起不再固定写 C 盘 home)

## plugin/(mods 层,管监视)

AbovePrompt 悬浮条:轮次 / 上下文大小 / 输入+缓存读写 / 输出 / 缓存命中率 / **成本 ¥(按当前档位计价,空闲/高峰 + Pro 标记)**;`/token-status` 命令看明细(当前模型档位、输入未命中/命中/输出三段成本拆分)。

**配置(`plugin/config.json`,可分发形式)**:价目双档(cheap/pro,元/百万 token)、节假日表、模型名映射、升级启发式参数(关键词/粘性窗口/冷却)——换供应商(如 GLM)、换模型名只改 json 不动代码,缺失/坏 json 时内置 DeepSeek 默认兜底。DeepSeek 口径:高峰=北京时间周一至周五(非法定节假日)9:00-12:00、14:00-18:00,**周末(含调休周末)与节假日全天空闲**。

**usage 折算(两种端点语义自动兼容)**:实测 DeepSeek Anthropic 兼容层的 `input_tokens` **不含缓存读**(cacheRead > input);Anthropic 官方的 `input_tokens` 含缓存读。按 miss 价部分 = `cacheRead > input ? input + cacheCreation : input - cacheRead`,命中部分 = cacheRead,输出含思考 token。

**非 DeepSeek 供应商怎么配**(内置默认是 DeepSeek,其他供应商照此改 config.json):

```json
{
  "pricing": {
    "cheap": { "idle": { "hit": 0, "miss": 0, "out": 0 }, "peak": { "hit": 0, "miss": 0, "out": 0 } },
    "pro":   { "idle": { "hit": 0, "miss": 0, "out": 0 }, "peak": { "hit": 0, "miss": 0, "out": 0 } }
  },
  "models": { "cheap": "你的便宜模型名", "pro": "你的强模型名" },
  "currency": "$",
  "upgrade": { "keywords": ["你的业务词…"], "cooldownMin": 10, "stickyMin": 30, "skillName": "" }
}
```

- **没有高峰/空闲之分的供应商**(如多数国内模型):peak 填成与 idle 相同即可
- **无缓存折扣或折扣口径不同的供应商**(如 Anthropic 官方是 cache-read 折扣、cache-write 溢价):hit 填 0 或按你的实际折扣填,成本行会退化为"未命中+输出"估算,量级仍近似
- **模型名判定**:插件按 `models.pro` 精确匹配判定 Pro 档(通用);`includes('pro')` 只是 DeepSeek 命名的兜底启发式,填了 models 映射后任何供应商都正确
- **货币符号**:`currency` 是金额前缀(默认 `¥`),悬浮条、`/token-status`、切换成本估算都用它 —— 用美元就填 `"$"`
- **升档建议里的技能名**:**硬升档闸需要一个"强档技能"**(该技能 SKILL.md 的 `model:` 头负责切档;这是 CC 里唯一非用户触发的切换通路)。**插件自带的默认是空** —— 没有这类技能的人开箱不会被拦。要用请填**插件选项** `upgrade_skill`(在 `/config` 里就有这一行;值存在你自己的 `settings.json`,插件升级不会覆盖),它优先于 `config.json` 的 `upgrade.skillName`;留空则升档只走"提醒用户 /model"
- **hooks 安装路径**:settings.json 里 `args` 的绝对路径按你的安装位置改(README 示例用占位符)
- 卖/分发时:用户只改这一个 json + settings.json 路径,代码零改动

## tools/(手动工具)

| 文件 | 作用 |
|---|---|
| `tool-gate.mjs` | 两档工具裁剪:改 `tiers.json` 名单后 `node tool-gate.mjs apply` 写入生效配置(均先自动备份,留 3 份),重启会话生效;`list` 只读对照,`enable <tool>` 召回 |
| `stats.mjs` | 汇总各会话拦截/裁剪/折叠计数与存档体积,估算累计省 token(`--json` 供脚本消费)。数据源:v0.2.0+ 读宿主插件 KV `<配置目录>/plugins/store/cc-token-optimizer*.json` 的 `guard-state`,并合并 Node 版时代的 `<配置目录>/token-optimizer/state.json`;存档体积把插件目录内的 `.archive/` 与旧位置一并计入 |

> `tool-gate` 的落点(2026-10 实测定型,CC 2.1.292):`<配置目录>/agents/tool-gate.md` 的 `disallowedTools`(主线程工具真实移除)+ settings.json 的 `"agent": "tool-gate"` 键(裸启动/任意目录自动生效,无需改启动方式)。**该 agent 文件 body 必须保持为空**:非空 prompt 会整个替换默认系统提示。CC 升级后建议复验(新会话问"列出你此刻的工具名",对照名单是否消失)。

## 安装

**一条命令**(Claude Code 2.1.275+,在终端会话里输入):

```
/plugin install cc-token-optimizer --marketplace Zoria-Lind/cc-token-optimizer
```

会先问是否添加该 marketplace(`y`),再选作用域(推荐 `user`,对所有会话生效)。**装完即用,不需要动 `settings.json`,也不需要 `node`**:

- 六个模块(readDedup / outputTrim / coldStartGuard / modelDirector 等)注册在插件内部的 `hooks/tokenGuard.ts`,随插件一起加载
- 状态存在宿主管理的 `$.store` 里(跨会话与热重载都在;落在 `<配置目录>/plugins/store/cc-token-optimizer*.json`)。**不是 `$.state`** —— 那是"held by the host for the session"的会话级内存,会话一结束统计就蒸发(v0.2.0 踩过这个坑,0.2.1 修)
- 配置读插件自带的 `config.json`,缺失或损坏时回退内置默认,不会报错

更新:

```
/plugin marketplace update zoria-plugins
/plugin update cc-token-optimizer@zoria-plugins
```

想改价目/模型名/升级规则,只改插件目录下的 `config.json`(格式见上),代码零改动。

<details>
<summary>旧方式:手动配 settings.json(依赖 Node,已不推荐)</summary>

仓库里的 `hooks/token-hook.mjs` 是同一套逻辑的 **Node 版**(stdin JSON → stdout JSON)。它不随插件走,需要手工往 `~/.claude/settings.json` 里挂,并且依赖系统装了 `node`:

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "…\\cc-token-optimizer\\plugin" },
  "hooks": {
    "PreToolUse":      [{ "matcher": "Read",              "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }],
    "PostToolUse":     [{ "matcher": "Read|Bash|PowerShell", "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }],
    "SessionStart":    [{ "matcher": "*",                "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }],
    "UserPromptSubmit":[{ "matcher": "*",                "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }],
    "PreModelSwitch":  [{ "matcher": "*",                "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }],
    "PostModelSwitch": [{ "matcher": "*",                "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }]
  },
  "bashOutputMaxChars": 12000,
  "promptCacheTtl": "1h",
  "subagentPromptCacheTtl": "1h"
}
```

**不要两条路一起走**:插件版和 Node 版处理同一批事件,同时挂着会让同一个工具调用被处理两次(拦截计数翻倍、输出被重复裁剪)。用了插件就别留 `hooks` 段。

## 设计红线

只许在**出生点**处理(内容进入上下文之前),从不改写已存储的历史——改写历史 = 前缀字节变化 = 下次请求全价重读,必亏。harness 自身在压缩前会清旧工具输出,不与它抢活。当前构建 harness 已原生挡整文件重读(返回 "Wasted call — file unchanged"),readDedup 的增量只剩部分重叠区间与长跨度重读。

## 验证

```sh
# hooks 层:管道测试(模拟三种事件载荷)
node -e '…' | node hooks/token-hook.mjs
# mods 层:静态校验
claude plugin validate plugin
```

## 诚实边界

- readDedup 按 mtime+size 判"未变"(不哈希内容;同秒改写同尺寸的极端情况会漏判为未变)
- deny 拦截的代价是模型多一轮失败重试;靠 3 次逃生兜底
- 悬浮条数值来自 turn.complete 聚合,压缩(/compact)后累计口径不重置

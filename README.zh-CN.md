# cc-token-optimizer

[English](README.md) · **中文**

给 Claude Code 的 token 优化器 —— 降低一次会话的真实花费:读去重、输出裁剪、缓存过期提醒,外加提示符上方的成本 / 命中率悬浮条。**一条命令装完即用**:不改 `settings.json`,不需要 `node`。

## 安装

```
/plugin install cc-token-optimizer --marketplace Zoria-Lind/cc-token-optimizer
```

Claude Code 2.1.275+。会先问是否添加该 marketplace(`y`),再选作用域(推荐 `user`,对所有会话生效)。装完即用:

- 模块(readDedup / recordRead / outputTrim / coldStartGuard / modelDirector / tierFact / compactReset 等)注册在插件内部的 `hooks/tokenGuard.ts`,随插件一起加载
- 状态有**两处**,寿命不同:
  - hooks 层的 `guard-state`(读记录 / 裁剪计数 / 档位事实)落在宿主的插件 KV —— `<配置目录>/plugins/store/cc-token-optimizer*.json` —— 跨会话与热重载都在。**不是 `$.state`**(v0.2.0 踩过这个坑,0.2.1 修)
  - 悬浮条与 `/token-status` 背后的**成本账本**(轮次 / token / 档位分账)存在 `$.state`,**这是会话级设计**:热重载能续,但新会话或 `/clear` 从零开始。「¥0.40」是**本会话**的数,不是累计数
- 配置读插件自带的 `config.json`,缺失或损坏时回退内置默认,不会报错

更新:

```
/plugin marketplace update zoria-plugins
/plugin update cc-token-optimizer@zoria-plugins
```

## 模块一览

| 模块 | 挂点 | 作用 |
|---|---|---|
| **readDedup** | `tool.call` Read | 文件未变(mtime+size)且请求区间**已完全**落在上下文中 → deny;部分重叠**放行**并把区间合并进去。同一文件连续 3 次被拦自动放行(逃生)。**故意不去重的两种情况**:PDF 分页读(`pages` 与行区间没有可比性)与**压缩之后**的记录(见 compactReset) |
| **recordRead** | 同一次 Read 之后 | 记录 mtime/size + 已读区间(v2 格式,按会话 / 子 agent 分桶,LRU 修剪);记录键用文件的**解析后路径**(`D:\a\b.ts` 与 `D:/a/b.ts` 算同一条),区间记的是工具**实际返回**的那段(被 token 上限截断的读,记的是模型真看到的那一页,不是它请求的区间) |
| **outputTrim** | PostToolUse Bash/PowerShell | ≥3 行连续相同 → 折叠;折叠后仍 ≥5000 字符 → 头尾采样注入(成功 1500+1500,失败 800+800)。**只要发生折叠或裁剪任一,原输出就先存档落盘**,并把存档路径附给模型。存档走宿主的 `fs.write`,**超过 4 MiB 会被拒** —— 那种超大输出只裁剪、不给存档路径 |
| **coldStartGuard** | SessionStart | resume 的会话若提示缓存已过期 → 注入一行:上下文量 + 重缓存预估成本 + 建议 `/clear` |
| **modelDirector** | SessionStart · UserPromptSubmit · `tool.call` Edit/Write/NotebookEdit · PreModelSwitch · PostModelSwitch | 档位"导演":机械检测升档建议 + **可选的硬升档闸** + 切换成本透明(详见下节) |
| **tierFact** | PostToolUse Skill | 从 Skill 工具自己的结果里读引擎解析出的模型(直连 DeepSeek 时唯一可信的升档信号);是 Pro 档就把事实记进 `_proAt`/`_proEpoch`,并**当场**弹提醒。成本分账与硬升档闸都读这个事实 |
| **compactReset** | `session.compact` | 压缩点把本会话的读记录作废:harness 压缩时会把旧工具输出清出上下文,此后"你已经读过这个文件"的记录全是过时的。`trigger: "precompute"` 跳过 —— 它是唯一不落地的那种派发 |
| **悬浮条** · `/token-status` | AbovePrompt · 斜杠命令 | 轮次 / 上下文大小 / 输入+缓存读写 / 输出 / 缓存命中率 / **成本(按各轮真实档位分账 · 峰谷价;混合档会标出 Pro 那部分)**;命令看三段成本拆分 + 档位构成 |
| **`tools/stats.mjs`** | 手动 | 跨会话汇总拦截/裁剪/折叠计数与存档体积,估算累计省下的 token |

## modelDirector:档位导演

主力常驻档由 `plugin/config.json` 的 `defaultTier` 决定,纪律文本随之整体换向:

- **`cheap`(自带默认)**:启动恒 Flash,需要时升级、下次启动自动回落。**升级触发器默认在人** —— 若交给模型自评(让便宜档自己判断该不该升 Pro),它不知道自己便宜在哪,拿不准时不升级、埋头硬做,做砸了还没能力报告"我变差了"(2026-10-07 实测踩坑)。
- **`pro`**:主力常驻 Pro、跑腿活派 subagent(少一次升降档操作,贵)。

事件与行为:

- **SessionStart**:记录当前模型 + 注入档位纪律(主力档=cheap 时:基础档 → "拿不准就建议升 Pro",Pro → "任务完成后切回基础档";主力档=pro 时反之)
- **UserPromptSubmit 机械检测**(coding 关键词 / 文件后缀 **19 个**,见 `config.json`;2026-10-10 由 43 项收紧 —— 只留「几乎只出现在 coding 语境」的词 + 源码后缀,日常词如「方案」「接口」「设计」已删;**长文本不再单独触发** —— 粘网页/日志不会误报升档;另有一条**粘性窗口**:近期改过代码,30 分钟内的续接轮不看文本也提醒):命中 → ① 向模型注入**条件式**指令"若你不在 Pro 档,动手前先调用 Skill 工具(你在 `/config` 里配的那个强档技能)"(每轮都给、不按记录档位拦截——回合级升档会自动回落,记录的档位可能滞后一拍);② 就这些 —— **不再给你发预测式提示**(2026-10-10 删除:旧提示会被「方案」「接口」这类日常词命中,而且会断言「本回合按 Pro 档执行」—— 那一刻其实什么都没切,用户反馈"心里很紧张")。**升档由机械检测驱动,不依赖模型自评** —— 自指坑的解法
- **升档提醒:升档当场弹(2026-10-10)**:判据来自 **Skill 工具自己的结果** —— 技能的 frontmatter `model:` 头生效时,引擎会把解析到的模型回填进结果(`tool_response.model`,类型原话 *"Resolved model the skill turn runs on when a frontmatter model override took effect; omitted otherwise"*)。解析模型是 Pro 档 ⇒ 本回合确实在走强档,当场提醒一次(冷却 `cooldownMin`,同一会话内不重复;会话本来就常驻 Pro 时不提醒;子代理轮次与 `status:"forked"` 的技能运行跳过)。**用户侧只在这一刻出声**,不再有基于文本预测的提前警报。⚠ 为什么不用 `turn.complete` 的 `usage.model`:直连 DeepSeek 端点时引擎在那里报的是**会话基础档**(2026-10-10 实测:一轮确实跑在 `deepseek-v4-pro[1m]` 上,日志却记成 flash,当天 548 条响应无一例外)⇒ 那个判据在本机恒为假。`usage.model` 仍作 OR 兜底,留给如实上报的宿主。
- **硬升档闸(`tool.call` Edit/Write/NotebookEdit,可选)**:模型调改动类工具之前必然已经推理过一轮,它**决定改代码 = 事实上的 coding 判定**,是"用户没说、自己也拿不准"时唯一可靠的自动升档信号。于是本回合**首次改动代码文件**时**拦一次**(要求模型先调用强档技能再重试;retry 后该回合余下推理走强档,代价=一次往返)。判据与会踩的边界:
  - **只拦代码文件,按扩展名判**:源码之外,`.json/.yaml/.toml/.ini/.ps1` 这类配置与脚本**也算**;**`.md/.txt` 一类纯文档放行**(否则改 README、改记忆会白丢一轮)
  - **Write 新建代码文件同样会拦**(不判文件是否存在 —— 建 `.ts` 也算"改动代码")
  - **会话基础档(`$.session.model()`)看不见技能的回合级切档** —— 所以闸门同时接受上面 Skill 分支落的升档事实(`_proEpoch`,技能运行那一刻的 `_epoch` 值):**已经升过档的回合不再被拦**(2026-10-10 修;回合归属 2026-10-11 又修了一次 —— 见下一条)
  - **每回合最多一次**:按回合边界 `_epoch` 去重(只由 `turn.complete` 自增,闸记录 `_forcedEpoch`)—— 不用时间冷却(长回合里时间冷却会反复拦同一件事)。⚠ 明确**不用** `UserPromptSubmit` 上的计数:该事件**在同一回合内会再次触发**(子 agent 的 hand-back 以 user 角色消息注入),会悄悄破坏去重 —— 2026-10-11 实测,闸把刚升过档的回合里的改动白拦了一次
  - **子 agent 的改动一律不拦**:委派出去的改动带 `agentId` 进来,闸只认主线程自己的改动。子 agent 已经跑在(通常更便宜的)子代理模型上,而技能的 `model:` 头切的是**会话那一轮** —— 已经在跑的它切不动,所以那条建议(先调技能)它执行不了;更实质的是这一次白拦会把本回合唯一的名额占掉,主线程自己第一次改代码反倒不拦了。子 agent 的改动照旧落粘性窗口的 `_codingAt`
  - **没配技能名就完全不拦**(没技能可调,拦下来只会让模型卡住);配了但没这个技能同理无效
- **配套技能**:`<配置目录>/skills/<你的强档技能>/SKILL.md`,frontmatter `model:` 指向强档模型 —— 激活期间本回合跑 Pro、下一轮自动回落、不落盘。**技能的 `model:` 头是 CC 里唯一"非用户触发"的模型切换机制**(hook 切不了模型,官方文档确认;2026-10-07 实测跑通),所以硬升档闸只能"请模型去调技能",插件自己无法切档
- **PreModelSwitch 切换成本透明**:"切换将丢弃提示缓存,上下文约 80k,重缓存约 ¥0.36",提示在任务边界再切
- **PostModelSwitch** 记录新档位 + 注入对应提醒(切到 Pro:用完记得切回;切到基础档:拿不准就升)

## 配置

`plugin/config.json` 是唯一的配置真源(可分发形式,改它不动代码):价目双档(cheap/pro,元/百万 token)、节假日表、模型名映射、金额前缀、升级启发式参数(关键词 / 粘性窗口 / 冷却)。DeepSeek 口径:高峰=北京时间周一至周五(非法定节假日)9:00-12:00、14:00-18:00,**周末(含调休周末)与节假日全天空闲**。

**技能名走"插件选项",不走 config.json**(优先级:插件选项 > `config.json` 的 `upgrade.skillName`):在 `/config` 里填 `upgrade_skill`,值存进**你自己的** `settings.json`,插件升级不会覆盖。插件自带的 `config.json` 里该项**默认留空** ⇒ 陌生人装上不会被拦、也不会去调用一个他根本没有的技能。

**非 DeepSeek 供应商怎么配**(内置默认是 DeepSeek,照此改 `config.json`):

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
- **升档建议里的技能名**:**硬升档闸需要一个"强档技能"**(该技能 SKILL.md 的 `model:` 头负责切档,这是 CC 里唯一非用户触发的切换通路)。**插件自带的默认是空** —— 没有这类技能的人开箱不会被拦。要用请填**插件选项** `upgrade_skill`(在 `/config` 里就有这一行),它优先于 `config.json` 的 `upgrade.skillName`;留空则升档只走"提醒用户 /model"

## usage 折算(两种端点语义自动兼容)

实测 DeepSeek Anthropic 兼容层的 `input_tokens` **不含缓存读**(cacheRead > input);Anthropic 官方的 `input_tokens` 含缓存读。按 miss 价部分 = `cacheRead > input ? input + cacheCreation : input - cacheRead`,命中部分 = cacheRead,输出含思考 token。

## tools/(手动工具)

| 文件 | 作用 |
|---|---|
| `tool-gate.mjs` | 两档工具裁剪:改 `tiers.json` 名单后 `node tool-gate.mjs apply` 写入生效配置(均先自动备份,留 3 份),重启会话生效;`list` 只读对照,`enable <tool>` 召回 |
| `stats.mjs` | 汇总各会话拦截/裁剪/折叠计数与存档体积,估算累计省 token(`--json` 供脚本消费)。数据源:v0.2.0+ 读宿主插件 KV `<配置目录>/plugins/store/cc-token-optimizer*.json` 的 `guard-state`,并合并 Node 版时代的 `<配置目录>/token-optimizer/state.json`;存档体积把插件目录内的 `.archive/` 与旧位置一并计入 |

> `tool-gate` 的落点(2026-10 实测定型,CC 2.1.292):`<配置目录>/agents/tool-gate.md` 的 `disallowedTools`(主线程工具真实移除)+ settings.json 的 `"agent": "tool-gate"` 键(裸启动/任意目录自动生效,无需改启动方式)。**该 agent 文件 body 必须保持为空**:非空 prompt 会整个替换默认系统提示。CC 升级后建议复验(新会话问"列出你此刻的工具名",对照名单是否消失)。

## 设计红线

只许在**出生点**处理(内容进入上下文之前),从不改写已存储的历史——改写历史 = 前缀字节变化 = 下次请求全价重读,必亏。harness 自身在压缩前会清旧工具输出,不与它抢活。当前构建 harness 已原生挡整文件重读(返回 "Wasted call — file unchanged"),readDedup 的增量只剩部分重叠区间与长跨度重读。

## 诚实边界

- **价目、模型名、货币符号默认都是 DeepSeek 的**(双档峰谷,`currency: "¥"`)。换供应商只改 `config.json`,代码零改动。高峰/空闲**固定按北京时间(UTC+8)**判定,与本机时区无关;`holidays` 是中国国务院的节假日表 —— 不在中国就把 `peak` 填成与 `idle` 相同(或自己维护日期表)
- **硬升档闸的代价**:判据是会话基础档,但同时接受本回合的升档事实 ⇒ **已升过档的回合不再白拦**;每回合最多拦一次;没配技能名则完全不拦
- readDedup 按 mtime+size 判"未变"(不哈希内容;同秒改写同尺寸的极端情况会漏判为未变);recent 版本 harness 已原生挡整文件重读,增量只剩部分重叠与长跨度重读
- deny 拦截的代价是模型多一轮失败重试;靠 3 次逃生兜底
- 存档目录**删不掉东西**(宿主的 `fs` 没有删除 API):淘汰是往最旧的格子写一个空文件 ⇒ 内容体积有界(约 20 份),但文件**个数**每裁剪一次涨一个,留下零字节空壳
- 读记录的键是**解析后路径** ⇒ 同一个文件若经 junction / 硬链接抵达、解析到了别处,就会与先前那种拼写被当成**两个**文件(那一次去重机会就丢了)
- 悬浮条数值来自 turn.complete 聚合,压缩(`/compact`)后累计口径不重置
- **成本按每轮「真实档位」分账计价** —— 判据同上(引擎报的解析模型,`usage.model` 作兜底):Pro 档作答的部分走 Pro 价目、其余走基础价,混合档单独标出 Pro 那部分。归属是**回合级**:升档回合里"技能调用之前"的请求也会计入 Pro ⇒ 略偏高(有意保守)。**v0.2.5 之前的账本没有分账字段**(历史按基础档计价);**v0.2.5 及更早**用 `usage.model` 判档 ⇒ 在直连 DeepSeek 上恒记为基础档 —— 跨这两条线比较成本都无意义
- `config.json` 的 `_comment` 里写了每个键的口径,发行文件里也如实标注了上述边界

## 验证

```sh
claude plugin test plugin      # 58 项:hook 行为(拦截/逃生/裁剪/折叠/硬闸/状态隔离/分账计价/压缩)
claude plugin validate plugin --strict
```

## 许可

MIT © Zoria Lind。

<details>
<summary>旧方式:settings-hook 层(Node 版,已不推荐)</summary>

仓库里的 `hooks/token-hook.mjs` 是同一套逻辑的 **Node 版**(stdin JSON → stdout JSON,由 settings.json 的 hooks 驱动)。它不随插件走,需要手工往 `~/.claude/settings.json` 里挂,并且依赖系统装了 `node`。v0.2.0 起全部模块已移植进插件(`plugin/hooks/tokenGuard.ts`),**除非你在用 Node 版,否则不需要这一节**。

| 模块 | 事件 | 作用 |
|---|---|---|
| readDedup | PreToolUse Read | 文件未变(mtime+size)且请求区间已在上下文中 → deny,防重复读出生(缓存安全,不动历史) |
| recordRead | PostToolUse Read | 记录 mtime/size + 已读区间(合并区间;单会话 ≤200 文件;状态只留最近 5 会话) |
| outputTrim | PostToolUse Bash/PowerShell | ≥5000 字符输出头尾采样(成功 1500+1500,错误 800+800,先重复行折叠再按折叠后长度判断),裁剪前原输出存档(不注入) |
| coldStartGuard | SessionStart resume | 缓存已过期 → 注入一行提醒(上下文量 + 重缓存预估成本,建议 /clear) |
| modelDirector | SessionStart / UserPromptSubmit / PreModelSwitch / PostModelSwitch | 档位"导演"(口径由 config.json 的 `defaultTier` 决定) |

- 状态文件:`<CLAUDE_CONFIG_DIR>/token-optimizer/state.json`(跟随配置目录,未设时回退 `~/.claude`;2026-10-07 起不再固定写 C 盘 home)
- 逃生:同文件连续 3 次拦截自动放行(防 deny 死锁,DSH 教训);铁律 fail-open:任何异常静默放行

```json
{
  "env": { "CLAUDE_CODE_PLUGIN_DIRS": "…\\cc-token-optimizer\\plugin" },
  "hooks": {
    "PreToolUse":      [{ "matcher": "Read",              "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] },
                       { "matcher": "Edit|Write|NotebookEdit", "hooks": [{ "type": "command", "command": "node", "args": ["<安装目录>/hooks/token-hook.mjs"], "timeout": 10 }] }],
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

</details>

// cc-token-optimizer — mods 层:AbovePrompt 悬浮条(含 compactionDriver ⚠ 提示)+ /token-status 统计。
// 数据源:turn.complete 的 usage 聚合(仅主会话,排除 subagent)+ $.session.usage() 的上下文快照。
// ⚠ 本层**只报 token,不折算金额**(2026-10-12 定):各厂商计费口径不同,而 token 是厂商无关的硬事实。
//   实测教训:同一批 token,平台按"网关自己路由的模型"计费、插件按"引擎报的档位"计价,两者曾差 2.5~4 倍
//   (平台给的是一段 15 次调用里 9 Flash + 6 Pro,而那一段插件侧一次升档都没有),且**会话日志不记录
//   实际服务的模型**(124 条响应全写 flash,平台却记了 6 次 Pro)⇒ 金额这一层原则上算不准,索性不报。
// 铁律:任何异常静默放行。
// 累计口径(B 修正 2026-10-08):计数持久在 $.state(宿主保存、热重载不清零),按会话 startedAt 分账 ——
//   热重载不再丢已计轮次;新会话 / `/clear`(startedAt 变)自然开新账;多窗口并发各记各的,互不覆盖。
// 诊断刻度:每次 register() 往账本记一行 loads{时刻, 当时轮数, 当时无 usage 轮数} ——
//   事后可判定缺数是"热重载丢的"还是"事件本身没收到"(口径行见 /token-status)。
import type { Register } from 'claude-code'
import { register as registerGuard } from './tokenGuard'

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000 ? `${Math.round(n / 1000)}k`
      : `${n}`

// ---- 档位判定(2026-10-12 回归)----
// 档位**分账(token)**回来了,所以需要"强档叫什么名字"。这里保留一个**最小**的配置读取:只读 models。
// ⚠ 其余配置(价目/节假日/货币)依然不存在 —— 别再顺手加回来(金额已整条移除,见文件头)。
const DEFAULT_MODELS = { cheap: 'deepseek-v4-flash', pro: 'deepseek-v4-pro[1m]' }
let modelsCache: typeof DEFAULT_MODELS | null = null
const loadModels = async ($: { fs: { read: (p: string) => Promise<string> }; plugin: { root: string } }): Promise<typeof DEFAULT_MODELS> => {
  if (modelsCache) return modelsCache
  try {
    const cfg = JSON.parse(await $.fs.read(`${$.plugin.root}/config.json`))
    modelsCache = { ...DEFAULT_MODELS, ...cfg?.models }
  } catch { modelsCache = DEFAULT_MODELS } // 缺失/坏 json → 内置默认,且缓存住不再每轮重试
  return modelsCache ?? DEFAULT_MODELS
}
// 强档判定:先按 config 的 models.pro 精确匹配(换供应商也对),再退回 DeepSeek 那套命名启发式
const isProModel = (models: typeof DEFAULT_MODELS, m: string | null | undefined): boolean =>
  !!m && (m === models.pro || (String(m).includes('pro') && !String(m).includes('flash')))

// usage 两种语义兼容(实测两种端点都存在):
//   DeepSeek 兼容层: input_tokens 不含缓存读(cacheRead > input 时)→ 总输入 = input + read + creation
//   Anthropic 官方:  input 含缓存读 → 总输入 = input
// 本层只用到"总输入"(算命中率),不涉及金额,故两种语义下同一式即可(本文件不再有任何计价函数)。
const totalInputTokens = (inputT: number, read: number, creation: number): number =>
  read > inputT ? inputT + read + creation : inputT

// 本回合是否走了强档 —— 供**档位分账(token 计)**用(0.2.x 用它算钱,现在只用来分 token 数)。
// 判据与硬升档闸同源:hooks 层的 `markSkillUpgrade` 在技能 `model:` 头生效那一刻把 `_proAt` 写进
// guard-state ⇒ 本回合的墙钟窗口内出现 `_proAt` 即"本回合有**插件驱动**的升档"。
// ⚠ 已知边界(2026-10-12 实测结论):**网关可能自己按调用路由到强档**(平台给的 15 次调用里 6 次是 Pro,
//   而那一段插件侧一次升档都没有)⇒ 那种情况这里看不到,**分账是下限,不是全貌**。文案里已如实标注。
async function guardProHit($: any, durationMs: number): Promise<boolean> {
  try {
    const st = ((await $.store.get(GUARD_STATE_KEY)) ?? {}) as any
    let sid = ''
    try { sid = String((await $.session.id()) ?? '') } catch { /* fail-open */ }
    if (sid === '') return false
    const at = st?.[sid]?._proAt
    if (typeof at !== 'number') return false
    // 时间窗:turn.complete 的 durationMs 是该回合的**墙钟长度** ⇒ 回合起点 = now - durationMs;
    // 技能调用必然落在本回合内 ⇒ at >= 起点(SLACK 只抵消计时抖动)。
    // ⚠ 已知边界:若下一回合恰在 at 之后 1 秒内开始(人肉操作基本不可能),该回合会被误记成强档。
    return at >= Date.now() - Math.max(0, durationMs) - 1_000
  } catch { return false }
}
// 与 tokenGuard.ts 同一个 key(裸字符串键;$.store.get/set 的签名就是 (key: string),
// 而 {plugin,key} 那种 ref 是 **$.state**(会话级内存)的 API,读写的是另一份东西)
const GUARD_STATE_KEY = 'guard-state'
// 回合边界(2026-10-11):`_epoch` **只在这里**自增 —— 引擎的 turn.complete 才是回合的定义,
// 而 UserPromptSubmit 会在**同一回合内再触发**(实测:子 agent 的 hand-back 以 user 角色消息注入),
// 拿它计数会让"本回合已升过档"的判据失效,硬升档闸于是白拦一次(2026-10-11 现场复现)。
// 写在 mods 层有两个原因:①turn.complete 已被本文件注册,tokenGuard 里同事件不能再注册一次;
// ②插件验证器禁止把 $ 跨 import 传(`$ is followed only into a function declared in this same file`)。
// 所以这里直接读写 hooks 层那个 store 键(同一个裸字符串键、同一份数据)。
async function noteTurnEnd($: any, e: any): Promise<void> {
  if ((e?.agentId ?? e?.agent_id) !== undefined) return // 子 agent 的回合结束不推进主循环的边界
  try {
    let sid = ''
    try { sid = String((await $.session.id()) ?? '') } catch { /* fail-open */ }
    if (sid === '') return
    const st = ((await $.store.get(GUARD_STATE_KEY)) ?? {}) as any
    const sess = st[sid] ?? {}
    sess._epoch = (sess._epoch ?? 0) + 1 // ⚠ 计数不能用时间戳代替:turn.complete 与 deny 同毫秒是常态
    sess._at = Date.now()
    st[sid] = sess
    await $.store.set(GUARD_STATE_KEY, st)
  } catch { /* fail-open:边界记不上只是闸退化,不该影响任何工具 */ }
}

// 时间刻度(HH:MM / M-D HH:MM):不走 Intl(沙箱里未必有),手拼
const hm = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const stamp = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}-${d.getDate()} ${hm(ms)}`
}

// ---- 会话账本(跨热重载持久:B 修正)----
type LoadMark = { at: number; turns: number; noUsage: number }
type UsageTotals = {
  startedAt: number | null // 会话标识($.session.usage().startedAt):变了就是新会话
  loadAt: number // 写入者加载时刻 —— 更晚的实例接管账本,旧实例不得覆盖新实例
  turns: number
  turnsNoUsage: number // 主会话里 usage 缺失的轮次(中断/API 错误):CC 不给 usage,单独计数(诊断用)
  subagentTurns: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** 按**档位**分账的 token(2026-10-12 回归):本会话里由强档作答的那部分 token。
   *  ⚠ 与 0.2.x 的区别:**只数 token,不乘价目** —— 金额已整条移除(各家计费口径不同,而 token 是硬事实)。
   *  基础档部分 = 总量 − pro 部分;旧账本没有这些字段 ⇒ 视为 0(显示成整段基础档)。 */
  proInput: number
  proOutput: number
  proCacheRead: number
  proCacheCreation: number
  proTurns: number // 由强档作答的主会话轮次
  /** 上一轮(最近一个已结束的回合)新增的 token 合计 = input + read + creation + output ——
   *  条上那格「上轮 +Δ」就是它:这一轮往上下文里塞了多少,**之后每一轮都要连带重读一遍**。
   *  旧账本没有该字段 ⇒ 视为 0(条上不显示那一格)。 */
  lastTurnTokens: number
  firstAt: number | null // 本会话首轮计数时刻
  lastAt: number | null
  loads: LoadMark[] // 诊断刻度:每次 register() 一行
}
type UsageBook = Record<string, UsageTotals> // key = String(startedAt):多窗口并发各记各的
// $.state 引用:验证器要求 plugin/key 是字面量(与 behavior-enhancer 的 REGISTRY 同款形状)
const USAGE_REF = { plugin: 'cc-token-optimizer', key: 'usage-totals' } as const
const BOOK_KEEP = 3
const newTotals = (startedAt: number | null, loadAt: number): UsageTotals => ({
  startedAt, loadAt, turns: 0, turnsNoUsage: 0, subagentTurns: 0,
  input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
  proInput: 0, proOutput: 0, proCacheRead: 0, proCacheCreation: 0, proTurns: 0,
  lastTurnTokens: 0,
  firstAt: null, lastAt: null, loads: [],
})
// 读账本:同会话(startedAt 相同)则接续并把本次加载记成一行刻度;否则开新账
const readTotals = async ($: any, loadAt: number): Promise<UsageTotals> => {
  let startedAt: number | null = null
  try {
    const u = await $.session.usage()
    if (typeof u?.startedAt === 'number') startedAt = u.startedAt
  } catch { /* fail-open:拿不到会话标识 → 记到 "null" 格 */ }
  try {
    const book = ((await $.state.get(USAGE_REF))?.value ?? {}) as UsageBook
    const prev = book[String(startedAt)]
    if (prev && typeof prev.turns === 'number') {
      return {
        ...newTotals(startedAt, loadAt),
        ...prev,
        loadAt,
        loads: [...(prev.loads ?? []), { at: loadAt, turns: prev.turns, noUsage: prev.turnsNoUsage ?? 0 }].slice(-20),
      }
    }
  } catch { /* fail-open */ }
  return { ...newTotals(startedAt, loadAt), loads: [{ at: loadAt, turns: 0, noUsage: 0 }] }
}
// 写账本:只覆盖自己这格,顺手裁掉最旧的会话(最多留 BOOK_KEEP 格)
const saveTotals = async ($: any, T: UsageTotals): Promise<void> => {
  try {
    const book = ((await $.state.get(USAGE_REF))?.value ?? {}) as UsageBook
    const key = String(T.startedAt)
    const prev = book[key]
    if (prev && typeof prev.loadAt === 'number' && prev.loadAt > T.loadAt) return // 更新的实例已接管
    const next: UsageBook = { ...book, [key]: T }
    const keys = Object.keys(next)
    if (keys.length > BOOK_KEEP) {
      keys.sort((a, b) => (next[b]?.lastAt ?? next[b]?.loadAt ?? 0) - (next[a]?.lastAt ?? next[a]?.loadAt ?? 0))
      for (const k of keys.slice(BOOK_KEEP)) delete next[k]
    }
    await $.state.set(USAGE_REF, next)
  } catch { /* fail-open */ }
}

export const register: Register = (on, options) => {
  modelsCache = null // 每次加载重读 config.json 的 models(档位判定要用强档模型名),热重载后改配置即生效
  // settings-hook 层六模块(readDedup/outputTrim/coldStartGuard/modelDirector 等)
  // 由 tokenGuard.ts 注册 —— 随插件分发,不再依赖用户手工往 settings.json 里配。
  registerGuard(on, options)
  const loadAt = Date.now()
  let T = newTotals(null, loadAt)
  let ready: Promise<void> | null = null
  // 惰性水合:首次用到账本时从 $.state 接续(热重载后的新实例由此寻回已计轮次)。
  // ⚠ 水合必须内联在各 hook 体内 —— 插件验证器只允许 $ 传给文件顶层的函数(readTotals 即顶层)。

  // compactionDriver:上下文过半时提醒 /compact(每会话 ≤3 次,相邻提醒 ≥6 轮;DSH 版同款设计)
  const COMPACT_WARN_PCT = 50
  const COMPACT_MAX_REMIND = 3
  const COMPACT_TURN_GAP = 6
  let compactReminded = 0
  let lastCompactRemindTurn = -10

  const totals = () => {
    const totalIn = totalInputTokens(T.input, T.cacheRead, T.cacheCreation)
    const hit = totalIn > 0 ? (100 * T.cacheRead) / totalIn : null
    return { totalIn, hit }
  }

  on('session.start', async ($, _e, next) => {
    if (!ready) ready = readTotals($, loadAt).then((t) => { T = t })
    await ready.catch(() => { /* fail-open */ })
    try {
      await $.command.register({
        name: 'token-status',
        description: 'cc-token-optimizer:上下文压力/累计 token/缓存命中率',
      })
      // /tier-auto:自动升档开关(2026-10-12 / 0.3.0),默认开
      await $.command.register({
        name: 'tier-auto',
        description: 'cc-token-optimizer:自动升档开关(on / off;off = 不拦也不提醒,只在动手改代码时提示一次)',
      })
    } catch { /* fail-open */ }
    return next(_e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('turn.complete', async ($, e, next) => {
    try {
      if (!ready) ready = readTotals($, loadAt).then((t) => { T = t })
      await ready
      // 回合边界:hooks 层的硬升档闸与"本回合已升档"判据都按它比时间戳(见 tokenGuard.ts 的 noteTurnEnd)。
      // 由 mods 层代记,是因为 turn.complete 已被本文件注册,tokenGuard 里同事件不能再注册一次。
      await noteTurnEnd($, e)
      if (e.agentId) {
        T.subagentTurns += 1
      } else if (e.usage) {
        T.turns += 1
        const tIn = e.usage.input_tokens ?? 0
        const tOut = e.usage.output_tokens ?? 0
        const tRead = e.usage.cache_read_input_tokens ?? 0
        const tCreation = e.usage.cache_creation_input_tokens ?? 0
        T.input += tIn
        T.output += tOut
        T.cacheRead += tRead
        T.cacheCreation += tCreation
        // 「上轮 +Δ」:这一轮总共用掉多少 token(上一轮塞进上下文的部分,之后每一轮都要重读)
        T.lastTurnTokens = tIn + tOut + tRead + tCreation
        // 档位分账(**只数 token,不乘价目** —— 金额已整条移除):判据 = ①引擎报的作答模型是强档
        // (官方 Anthropic 等会如实报;直连 DeepSeek 时它报的是**会话档位**,判成基础档 —— 不错,但不全)
        // 或 ②本回合有**插件驱动**的升档(guardProHit,与硬升档闸同源)。
        // ⚠ 结果口径 = **下限**:网关自己路由到强档的调用这里看不到(见文件头与 guardProHit 注释)。
        let served = typeof e.usage.model === 'string' ? e.usage.model : ''
        if (served === '') {
          try { served = (await $.session.model()) ?? '' } catch { /* 取不到 ⇒ 当基础档 */ }
        }
        if (isProModel(await loadModels($), served) || (await guardProHit($, e.durationMs ?? 0))) {
          T.proInput += tIn
          T.proOutput += tOut
          T.proCacheRead += tRead
          T.proCacheCreation += tCreation
          T.proTurns += 1
        }
        const now = Date.now()
        if (T.firstAt === null) T.firstAt = now
        T.lastAt = now
        await saveTotals($, T) // 写穿:热重载/崩溃都不丢
      } else {
        T.turnsNoUsage += 1 // 中断/API 错误:CC 不给 usage,单独记(诊断口径用)
        await saveTotals($, T)
      }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ready) ready = readTotals($, loadAt).then((t) => { T = t })
    await ready.catch(() => { /* fail-open */ })
    if (T.turns === 0) return next(e)
    let ctxText = ''
    let ctxPct: number | null = null
    try {
      const u = await $.session.usage()
      const c = u?.context
      if (c && typeof c.tokens === 'number') {
        ctxPct = typeof c.percent === 'number' ? Math.round(c.percent) : null
        ctxText = Math.round(c.tokens / 1000) + 'k'
        if (ctxPct !== null) ctxText += ' (' + ctxPct + '%)'
      }
    } catch { /* fail-open */ }
    let compactWarn = ''
    if (ctxPct !== null && ctxPct >= COMPACT_WARN_PCT && compactReminded < COMPACT_MAX_REMIND && T.turns - lastCompactRemindTurn >= COMPACT_TURN_GAP) {
      compactReminded += 1
      lastCompactRemindTurn = T.turns
      compactWarn = ' ⚠ ctx ' + ctxPct + '% · 建议 /compact'
    }
    const { hit } = totals()
    const { Box, Text } = $.ui.resolve(e)
    // 档位分账(**token 计**,2026-10-12 回归):两边都有 token 即混合档 —— 只显示 token 数,不乘价目。
    // ⚠ 它是**下限**(判据只有"插件驱动的升档"与"会话基础档本身是强档"两条,网关自己路由的看不见)。
    const proTok = (T.proInput ?? 0) + (T.proOutput ?? 0) + (T.proCacheRead ?? 0) + (T.proCacheCreation ?? 0)
    const allTok = T.input + T.output + T.cacheRead + T.cacheCreation
    const cheapTok = Math.max(0, allTok - proTok)
    const tierMark = proTok > 0 && cheapTok > 0 ? ` · 混合(Pro ${fmt(proTok)})` : proTok > 0 ? ' · Pro' : ' · 基础档'
    // 「上轮 +Δ」:条上唯一能指导行为的数 —— 上轮往上下文里塞了多少,之后每一轮都要连带重读一遍。
    // 旧账本没有该字段 ⇒ 那一格不显示。
    const deltaMark = T.lastTurnTokens > 0 ? ` · 上轮 +${fmt(T.lastTurnTokens)}` : ''
    // 自动升档开关的状态也标在条上(2026-10-12):关掉之后不主动敲 /token-status 就看不见,容易忘
    let tierAuto = true
    try { tierAuto = (((await $.store.get(GUARD_STATE_KEY)) as any)?._tierAuto) !== false } catch { /* fail-open:按默认(开) */ }
    const autoMark = tierAuto ? '' : ' · 升档关'
    // A:口径标记 —— 热重载续计过的会话在条上明示(没发生过就不占位置)
    const reloadMark = T.loads.length > 1 ? ` · 续计${T.loads.length - 1}载` : ''
    return (
      <Box>
        <Text dimColor>
          [opt] {T.turns}轮 · ctx {ctxText || '?'} · 输入 {fmt(T.input)} + 缓存读 {fmt(T.cacheRead)} / 写 {fmt(T.cacheCreation)} · 输出 {fmt(T.output)}
          {hit !== null ? ` · 命中 ${hit.toFixed(1)}%` : ''}{tierMark}{deltaMark}{autoMark}{reloadMark}
        </Text>
        {compactWarn !== '' && <Text>{compactWarn}</Text>}
      </Box>
    )
  }).catch(($, e, next) => (next.called ? next(e) : undefined)) // ⚠ 本 hook 每轮都跑且 $.ui.resolve 不在 try 里:失败就当没这条

  // ⚠ 本 handler 不挂 .catch:它每个可失败的调用都已单独 try 包住($.session.model / $.session.usage /
  // loadConfig 自带兜底),其余只是纯字符串拼接与算术 ⇒ 没有可抛点。将来若往这里加 I/O,记得补兜底。
  on('command.run', { command: 'token-status' }, async ($) => {
    if (!ready) ready = readTotals($, loadAt).then((t) => { T = t })
    await ready.catch(() => { /* fail-open */ })
    const { totalIn, hit } = totals()
    let model: string | null = null
    try { model = (await $.session.model()) ?? null } catch { /* fail-open */ }
    const outShare = totalIn > 0 ? Math.round((100 * T.output) / (totalIn + T.output)) : null
    // 发现性(设计稿要求):开关状态顺带打在这里 —— 否则用户永远不知道有 /tier-auto 这个东西
    let tierAuto = true
    try { tierAuto = (((await $.store.get(GUARD_STATE_KEY)) as any)?._tierAuto) !== false } catch { /* fail-open:按默认(开)报 */ }
    // 档位分账(**token 计**,与条上同源;不乘价目)
    const proTok = (T.proInput ?? 0) + (T.proOutput ?? 0) + (T.proCacheRead ?? 0) + (T.proCacheCreation ?? 0)
    const cheapTok = Math.max(0, (T.input + T.output + T.cacheRead + T.cacheCreation) - proTok)
    let compactLine = ''
    let compactNote = ''
    try {
      const c = (await $.session.usage())?.context
      const pct = c && typeof c.percent === 'number' ? Math.round(c.percent) : null
      if (pct !== null && pct >= COMPACT_WARN_PCT) {
        compactLine = `- ⚠ 上下文已 ${pct}%,建议 /compact(历史越短,每轮缓存读越少)`
        compactNote = `cc-token-optimizer:上下文已 ${pct}%,若本会话任务已过半,建议向用户提议 /compact 以缩小后续每轮输入。`
      }
    } catch { /* fail-open */ }
    return {
      text: [
        'cc-token-optimizer 统计(本会话累计,存 $.state 跨热重载续计;新会话 / `/clear` 归零):',
        `- 当前模型: ${model ?? '未知'}(会话档位)`,
        `- 轮次: ${T.turns}${T.turnsNoUsage > 0 || T.subagentTurns > 0 ? `(另有 usage 缺失 ${T.turnsNoUsage} 轮、子代理 ${T.subagentTurns} 轮,未计入)` : ''}`,
        `- 输入 ${fmt(T.input)} / 缓存读 ${fmt(T.cacheRead)} / 缓存写 ${fmt(T.cacheCreation)} / 输出 ${fmt(T.output)}${T.lastTurnTokens > 0 ? `(上轮 +${fmt(T.lastTurnTokens)})` : ''}`,
        `- 缓存命中率: ${hit !== null ? `${hit.toFixed(1)}%` : '暂无数据'}`,
        `- 档位构成(token): Pro ${fmt(proTok)}(${T.proTurns ?? 0} 轮)/ 基础档 ${fmt(cheapTok)}(${Math.max(0, T.turns - (T.proTurns ?? 0))} 轮)`,
        '- ⚠ 档位判据只有两个插件看得见的事实:①本回合有**插件驱动**的升档(技能 model: 头生效,与硬升档闸同源);②会话基础档本身就是强档。**网关自己按调用路由到强档的请求这里看不到** ⇒ 这个划分是**下限**,不是全貌(0.3.0 实测:平台记了 6 次 Pro,而同段插件侧一次升档都没有)。',
        outShare !== null ? `- 输出占比 ${outShare}%(输出含思考 token)` : '- 输出占比: 暂无数据',
        `- 自动升档: ${tierAuto ? '开(改代码文件的首次调用会先拦一次)' : '**关**(不拦也不给模型发提醒;要恢复:/tier-auto on)'}`,
        `- 统计窗口: 会话始于 ${stamp(T.startedAt)} · 首轮于 ${hm(T.firstAt)} · 本实例 register 加载 ${T.loads.length} 次${T.loads.length > 1 ? '(热重载过 → 已续计,未丢轮次)' : '(未重载)'}${T.loads.length >= 20 ? ' ⚠ 加载次数触顶,可能频繁重载' : ''}`,
        '- 口径: 来自 turn.complete usage 聚合(仅主会话);**只报 token,不折算金额** —— 各厂商计费口径不同,而 token 是厂商无关的硬事实。实测同一批 token,平台按"网关自己路由的模型"计费、本插件按"引擎报的档位"计价,两者曾差 2.5~4 倍,且会话日志**不记录实际服务的模型** ⇒ 0.3.0 起彻底移除金额显示,钱一律以你的账单为准。计数持久在 $.state,热重载不清零。',
        '- 档位/升级规则在 plugin/config.json(价目表已随 0.3.0 移除)。',
        '- hooks 层(readDedup/outputTrim/coldStartGuard/modelDirector)计数在 <CLAUDE_CONFIG_DIR>/plugins/store/cc-token-optimizer*.json 的 guard-state(v0.2.1 起跨会话);工具结果里的裁剪/存档标注同源。',
        compactLine,
      ].filter(Boolean).join('\n'),
      context: compactNote ? [compactNote] : undefined,
    }
  })

  // /tier-auto —— 自动升档开关(2026-10-12 / 0.3.0)。默认开;关掉后闸不拦、模型侧不注入提醒,
  // 只在"本回合首次改代码文件"那一刻提示一次(手动挡)。状态落 guard-state 的顶层键 `_tierAuto`。
  // ⚠ 开关归用户、不归模型:关掉只是"插件不再推",模型自行判断要强档时仍可调技能,用户也随时可 /model。
  on('command.run', { command: 'tier-auto' }, async ($, e) => {
    const raw = (e as any)?.args
    const arg = (Array.isArray(raw) ? raw.join(' ') : String(raw ?? '')).trim().toLowerCase()
    let enabled = true // ⚠ 不能叫 `on`:`on` 是 register 的形参(注册函数),同名会被插件验证器判为遮蔽
    try {
      const st = ((await $.store.get(GUARD_STATE_KEY)) ?? {}) as any
      if (arg === 'on' || arg === 'off') {
        st._tierAuto = arg === 'on'
        await $.store.set(GUARD_STATE_KEY, st)
      }
      enabled = st._tierAuto !== false
    } catch { /* fail-open:读不到就按默认(开)报状态 */ }
    return {
      text: [
        `cc-token-optimizer 自动升档:${enabled ? '开' : '关'}`,
        enabled
          ? '- 当前:本回合首次改动代码文件时会先拦一次、要模型先调用强档技能再重试(硬升档闸);命中 coding 关键词或粘性窗口时也会给模型发一条静默提醒。'
          : '- 当前:**不拦、也不给模型发提醒**;只在你真的动手改代码文件那一刻提示一次「自动升档已关 · 插件本轮不推升档」。要强档请自己 /model。',
        '- 用法:`/tier-auto off` 关,`/tier-auto on` 开,不带参数看状态。开关持久、跨会话有效。',
      ].join('\n'),
    }
  })
}

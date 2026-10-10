// cc-token-optimizer — mods 层:AbovePrompt 悬浮条(含 compactionDriver ⚠ 提示)+ /token-status 统计。
// 数据源:turn.complete 的 usage 聚合(仅主会话,排除 subagent)+ $.session.usage() 的上下文快照。
// 档位归属另有机械事实源:guard-state 的 `_proAt`(hooks 层从 Skill 工具结果读到引擎解析出的模型时落,
// 见 tokenGuard.ts 的 markSkillUpgrade)—— 直连 DeepSeek 时 usage.model 报的是会话档位,只能靠它。
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

// ---- C6 成本口径(module 顶层:验证器要求 $ 只传给文件顶层的函数)----
// 价目/节假日/模型档位/升级启发式全在 plugin/config.json(可分发:换供应商只改 json);
// 缺失/坏 json → 内置 DeepSeek 默认(元/百万 token,cheap=flash 档,pro=v4-pro 档)。
// 折算口径: usage.input_tokens 含缓存读写;未命中输入 = input - cacheRead;
//   cacheCreation(首写)按未命中价计;输出官方表未单列思考,含在 output_tokens 内。
type Tier = { hit: number; miss: number; out: number }
type PriceTier = { idle: Tier; peak: Tier }
const DEFAULT_CONFIG: {
  pricing: { cheap: PriceTier; pro: PriceTier }
  holidays: string[]
  models: { cheap: string; pro: string }
  /** 金额前缀(¥ / $ / 元 等),与 tokenGuard 层同名同义(两处各自读同一个 config.json)。 */
  currency: string
  upgrade: { keywords: string[]; cooldownMin: number }
} = {
  pricing: {
    cheap: { idle: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } },
    pro: { idle: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } },
  },
  holidays: ['2026-01-01', '2026-05-01', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
  models: { cheap: 'deepseek-v4-flash', pro: 'deepseek-v4-pro[1m]' },
  currency: '¥',
  upgrade: { keywords: ['重构', '编译', '报错', '调试', 'refactor', 'debug', 'bug', '.py', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.ps1', '.sh', '.go', '.rs', '.java', '.cpp'], cooldownMin: 10 },
}
// 读取一次后缓存(含失败回退,避免每轮渲染都读盘);mods 层禁 node 内置模块,走官方 $.fs.read
let configCache: typeof DEFAULT_CONFIG | null = null
const loadConfig = async ($: { fs: { read: (p: string) => Promise<string> }; plugin: { root: string } }): Promise<typeof DEFAULT_CONFIG> => {
  if (configCache) return configCache
  try {
    const text = await $.fs.read(`${$.plugin.root}/config.json`)
    const cfg = JSON.parse(text)
    configCache = {
      ...DEFAULT_CONFIG,
      ...cfg,
      pricing: { ...DEFAULT_CONFIG.pricing, ...cfg?.pricing },
      models: { ...DEFAULT_CONFIG.models, ...cfg?.models },
      upgrade: { ...DEFAULT_CONFIG.upgrade, ...cfg?.upgrade },
    }
  } catch { configCache = DEFAULT_CONFIG } // 读失败/坏 json → 内置默认,且缓存住不再每轮重试
  return configCache ?? DEFAULT_CONFIG
}
// 档位判定:模型名命中 models.pro → Pro 档,否则按 cheap 档计价
const isProModel = (cfg: typeof DEFAULT_CONFIG, model: string | null | undefined): boolean =>
  !!model && (model === cfg.models.pro || (model.includes('pro') && !model.includes('flash')))
// 高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00 且非节假日;
// 周末(含调休周末)与节假日全天按空闲价(官方口径)——调休周末是周六/周日,天然空闲,无需建模。
// ⚠ 2026-10-11 修:旧实现用 getHours()/getDay() = **本机本地时区**,而价目表与 holidays 都是
// **北京口径**(README 与 config.json 都这么写)⇒ 非中国时区的机器会静默错价(把高峰当空闲、反之亦然)。
// 改成固定按 UTC+8 折算:先把时间戳平移 8 小时,再一律读 getUTC* —— 北京无夏令时,偏移恒定,
// 结果与本机时区无关。now 可注入,供测试用固定时刻打靶。
const pad2 = (n: number): string => String(n).padStart(2, '0')
export const isPeakAt = (holidays: string[], now: number = Date.now()): boolean => {
  const d = new Date(now + 8 * 3_600_000)
  const h = d.getUTCHours()
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const key = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  if (holidays.includes(key)) return false
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}
const costYuan = (pricing: PriceTier, uncachedIn: number, cachedIn: number, out: number, peak: boolean): number => {
  const p = peak ? pricing.peak : pricing.idle
  return (uncachedIn * p.miss + cachedIn * p.hit + out * p.out) / 1_000_000
}
// 分段计价(2026-10-10):把「Pro 档作答的那部分」与「基础档那部分」分别按其价目算,再相加 ——
// 修掉此前"整段会话按当前档位计价"的偏差(升过档的日子成本显示偏低)。
type TokenSplit = { input: number; output: number; read: number; creation: number }
const costOfTokens = (pricing: PriceTier, t: TokenSplit, peak: boolean): number =>
  costYuan(pricing, missPart(t.input, t.read, t.creation), t.read, t.output, peak)
const splitByTier = (T: UsageTotals): { pro: TokenSplit; cheap: TokenSplit } => {
  const pro: TokenSplit = {
    input: T.proInput ?? 0, output: T.proOutput ?? 0, read: T.proCacheRead ?? 0, creation: T.proCacheCreation ?? 0,
  }
  const cheap: TokenSplit = {
    input: Math.max(0, T.input - pro.input),
    output: Math.max(0, T.output - pro.output),
    read: Math.max(0, T.cacheRead - pro.read),
    creation: Math.max(0, T.cacheCreation - pro.creation),
  }
  return { pro, cheap }
}
const tokensOf = (t: TokenSplit): number => t.input + t.output + t.read + t.creation
// usage 两种语义兼容(实测两种端点都存在):
//   DeepSeek 兼容层: input_tokens 不含缓存读(cacheRead > input 时)→ 按 miss 价部分 = input + creation
//   Anthropic 官方:  input 含缓存读 → 按 miss 价部分 = input - cacheRead(creation 含在 input 内)
const missPart = (inputT: number, read: number, creation: number): number =>
  Math.max(0, read > inputT ? inputT + creation : inputT - read)
// 命中率分母同理:总输入 = DeepSeek 语义下 input + read + creation;Anthropic 语义下 input 已含
const totalInputTokens = (inputT: number, read: number, creation: number): number =>
  read > inputT ? inputT + read + creation : inputT

// 本回合是否升过档(2026-10-10 重做,取代旧的 proNotice)。
// 旧判据是 `turn.complete` 的 `usage.model`(类型原话"by the id the API reports")—— 但**直连 DeepSeek 时它是假的**:
// 引擎写进 usage.model 与会话日志的 model/requestedModel 全是**会话档位**,技能升档它看不见
// (实测:真跑在 Pro 上,`/token-status` 却报 `Pro ¥0.000(0 轮)`;近 24h 共 548 条日志零条 pro)。
// ⇒ 改用 hooks 层落的**机械事实**:`classic.PostToolUse(Skill)` 从 **Skill 工具自己的结果**里读到引擎解析出的
// 模型(技能 frontmatter 的 `model:` 头生效时才出现),写进 guard-state 的 `_proAt`(见 tokenGuard.ts)。
// 这里原则上只**读** guard-state(hooks 层的财产);唯一例外是 noteTurnEnd —— 本文件才是
// turn.complete 的注册方,回合边界只能由它代 hooks 层落笔。
// 用户侧提醒已移交 hooks 层(升档当场弹,见 tokenGuard.ts 的 markSkillUpgrade),这里只做分账。
async function guardProHit($: any, durationMs: number): Promise<boolean> {
  try {
    const st = ((await $.store.get(GUARD_STATE_KEY)) ?? {}) as any
    let sid = ''
    try { sid = String((await $.session.id()) ?? '') } catch { /* fail-open */ }
    if (sid === '') return false
    const at = st?.[sid]?._proAt
    if (typeof at !== 'number') return false
    // 时间窗:turn.complete 的 durationMs 是该回合的**墙钟长度** ⇒ 回合起点 = now - durationMs;
    // 技能调用必然落在本回合内 ⇒ at >= 起点。**不能用回合序号**:2026-10-11 实测 `_turn` 会在同一
    // 回合内被再次触发的 UserPromptSubmit 顶高(子 agent 的 hand-back 以 user 角色消息注入)⇒ 序号不可靠。
    // SLACK 只抵消计时抖动。⚠ 已知边界:若下一回合恰在 at 之后 1 秒内开始(人肉操作基本不可能),
    // 该回合会被误记成 Pro —— 宁可轻微高估也不漏账,这是刻意取向。
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
  /** 按**真实档位**分账(2026-10-10):本会话里由 Pro 档模型作答的那部分 token。
   *  基础档部分 = 总量 − pro 部分;旧账本没有这些字段 ⇒ 视为 0(整段按基础档计价,与旧口径一致)。 */
  proInput: number
  proOutput: number
  proCacheRead: number
  proCacheCreation: number
  proTurns: number // 由 Pro 档作答的主会话轮次
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
  configCache = null // 每次加载重读 config.json(见 loadConfig),热重载后改配置即生效
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
        // 真实档位分账:以引擎报的作答模型为准;引擎没报模型时退回会话档位(与旧口径一致,fail-safe)
        let served = typeof e.usage.model === 'string' ? e.usage.model : ''
        if (served === '') {
          try { served = (await $.session.model()) ?? '' } catch { /* 取不到 ⇒ 当基础档 */ }
        }
        if (isProModel(await loadConfig($), served) || (await guardProHit($, e.durationMs ?? 0))) {
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
    const { totalIn, hit } = totals()
    const { Box, Text } = $.ui.resolve(e)
    const cfg = await loadConfig($)
    const { pro: proTok, cheap: cheapTok } = splitByTier(T)
    const peak = isPeakAt(cfg.holidays)
    const proCost = costOfTokens(cfg.pricing.pro, proTok, peak)
    const cheapCost = costOfTokens(cfg.pricing.cheap, cheapTok, peak)
    const cost = proCost + cheapCost
    const hasPro = tokensOf(proTok) > 0
    const hasCheap = tokensOf(cheapTok) > 0
    // 档位标记按**真实分账**给(2026-10-10):两边都有 token 即混合档,并标出 Pro 那部分花的钱
    const tierMark = hasPro && hasCheap
      ? `·混合(Pro ${cfg.currency}${proCost.toFixed(2)})`
      : hasPro ? '·Pro' : '·基础档'
    // A:口径标记 —— 热重载续计过的会话在条上明示(没发生过就不占位置)
    const reloadMark = T.loads.length > 1 ? ` · 续计${T.loads.length - 1}载` : ''
    return (
      <Box>
        <Text dimColor>
          [opt] {T.turns}轮 · ctx {ctxText || '?'} · 输入 {fmt(T.input)} + 缓存读 {fmt(T.cacheRead)} / 写 {fmt(T.cacheCreation)} · 输出 {fmt(T.output)}
          {hit !== null ? ` · 命中 ${hit.toFixed(1)}%` : ''} · {cfg.currency}{cost.toFixed(2)}{peak ? ' 高峰' : ''}{tierMark}{reloadMark}
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
    const cfg = await loadConfig($)
    let model: string | null = null
    try { model = (await $.session.model()) ?? null } catch { /* fail-open */ }
    const { pro: proTok, cheap: cheapTok } = splitByTier(T)
    const peak = isPeakAt(cfg.holidays)
    const p = peak ? cfg.pricing.pro.peak : cfg.pricing.pro.idle
    const c = peak ? cfg.pricing.cheap.peak : cfg.pricing.cheap.idle
    const proCost = costOfTokens(cfg.pricing.pro, proTok, peak)
    const cheapCost = costOfTokens(cfg.pricing.cheap, cheapTok, peak)
    const cost = proCost + cheapCost
    const proTurns = T.proTurns ?? 0
    const proIn = missPart(proTok.input, proTok.read, proTok.creation)
    const cheapIn = missPart(cheapTok.input, cheapTok.read, cheapTok.creation)
    // 三笔明细同样按真实分账混合(Pro 那部分走 Pro 价,其余走基础价)
    const missCost = (proIn * p.miss + cheapIn * c.miss) / 1_000_000
    const hitCost = (proTok.read * p.hit + cheapTok.read * c.hit) / 1_000_000
    const outCost = (proTok.output * p.out + cheapTok.output * c.out) / 1_000_000
    const outShare = totalIn > 0 ? Math.round((100 * T.output) / (totalIn + T.output)) : null
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
        `- 当前模型: ${model ?? '未知'}(会话档位;成本按**各轮真实档位**分账计价)`,
        `- 轮次: ${T.turns}${T.turnsNoUsage > 0 || T.subagentTurns > 0 ? `(另有 usage 缺失 ${T.turnsNoUsage} 轮、子代理 ${T.subagentTurns} 轮,未计价)` : ''}`,
        `- 输入 ${fmt(T.input)} / 缓存读 ${fmt(T.cacheRead)} / 缓存写 ${fmt(T.cacheCreation)} / 输出 ${fmt(T.output)}`,
        `- 缓存命中率: ${hit !== null ? `${hit.toFixed(1)}%` : '暂无数据'}`,
        `- 成本(${cfg.currency},按各轮真实档位分账 · ${peak ? '高峰' : '空闲'}价): ${cfg.currency}${cost.toFixed(3)} = 输入未命中 ${cfg.currency}${missCost.toFixed(3)} + 缓存读 ${cfg.currency}${hitCost.toFixed(3)} + 输出 ${cfg.currency}${outCost.toFixed(3)}`,
        `- 档位构成: Pro ${cfg.currency}${proCost.toFixed(3)}(${proTurns} 轮)/ 基础档 ${cfg.currency}${cheapCost.toFixed(3)}(${Math.max(0, T.turns - proTurns)} 轮)${proTurns === 0 ? ' · 本会话未升过档' : ''}`,
        outShare !== null ? `- 输出占比 ${outShare}%(输出含思考 token;cacheCreation 按未命中价计)` : '- 输出占比: 暂无数据',
        `- 统计窗口: 会话始于 ${stamp(T.startedAt)} · 首轮于 ${hm(T.firstAt)} · 本实例 register 加载 ${T.loads.length} 次${T.loads.length > 1 ? '(热重载过 → 已续计,未丢轮次)' : '(未重载)'}${T.loads.length >= 20 ? ' ⚠ 加载次数触顶,可能频繁重载' : ''}`,
        '- 口径: 来自 turn.complete usage 聚合(仅主会话);**档位归属 = 本回合是否升过档** —— 判据是 hooks 层落的机械事实(Skill 工具结果里引擎报的解析模型,见 plugin/hooks/tokenGuard.ts 的 markSkillUpgrade),并 OR 引擎报的作答模型(部分宿主会报,如官方 Anthropic;直连 DeepSeek 时它报的是**会话档位**,不可用);归属是**回合级**:该回合内技能调用之前的请求其实仍在基础档,故 Pro 那部分略偏高;0.2.5 及以前用 usage.model 判 ⇒ 在直连 DeepSeek 上恒记为基础档;计数持久在 $.state,热重载不清零;高峰=工作日 9-12/14-18 且非法定节假日,周末(含调休周末)与节假日全空闲;价目/档位/升级规则在 plugin/config.json。',
        '- hooks 层(readDedup/outputTrim/coldStartGuard/modelDirector)计数在 <CLAUDE_CONFIG_DIR>/plugins/store/cc-token-optimizer*.json 的 guard-state(v0.2.1 起跨会话);工具结果里的裁剪/存档标注同源。',
        compactLine,
      ].filter(Boolean).join('\n'),
      context: compactNote ? [compactNote] : undefined,
    }
  })
}

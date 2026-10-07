// cc-token-optimizer — mods 层:AbovePrompt 悬浮条(含 compactionDriver ⚠ 提示)+ /token-status 统计。
// 数据源:turn.complete 的 usage 聚合(仅主会话,排除 subagent)+ $.session.usage() 的上下文快照。
// 铁律:任何异常静默放行。
// 累计口径(B 修正 2026-10-08):计数持久在 $.state(宿主保存、热重载不清零),按会话 startedAt 分账 ——
//   热重载不再丢已计轮次;新会话 / `/clear`(startedAt 变)自然开新账;多窗口并发各记各的,互不覆盖。
// 诊断刻度:每次 register() 往账本记一行 loads{时刻, 当时轮数, 当时无 usage 轮数} ——
//   事后可判定缺数是"热重载丢的"还是"事件本身没收到"(口径行见 /token-status)。
import type { Register } from 'claude-code'

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
  upgrade: { minPromptChars: number; keywords: string[]; cooldownMin: number }
} = {
  pricing: {
    cheap: { idle: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } },
    pro: { idle: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } },
  },
  holidays: ['2026-01-01', '2026-05-01', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
  models: { cheap: 'deepseek-v4-flash', pro: 'deepseek-v4-pro[1m]' },
  upgrade: { minPromptChars: 120, keywords: ['设计', '架构', '重构', '方案', '决策', '算法', 'design', 'architecture', 'refactor', 'plan'], cooldownMin: 10 },
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
  return configCache
}
// 档位判定:模型名命中 models.pro → Pro 档,否则按 cheap 档计价
const isProModel = (cfg: typeof DEFAULT_CONFIG, model: string | null | undefined): boolean =>
  !!model && (model === cfg.models.pro || (model.includes('pro') && !model.includes('flash')))
// 高峰 = 北京时间周一至周五 9:00-12:00、14:00-18:00 且非节假日;
// 周末(含调休周末)与节假日全天按空闲价(官方口径)——调休周末是周六/周日,天然空闲,无需建模。
const isPeakAt = (holidays: string[], d = new Date()): boolean => {
  const h = d.getHours()
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (holidays.includes(key)) return false
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}
const costYuan = (pricing: PriceTier, uncachedIn: number, cachedIn: number, out: number, peak: boolean): number => {
  const p = peak ? pricing.peak : pricing.idle
  return (uncachedIn * p.miss + cachedIn * p.hit + out * p.out) / 1_000_000
}
// usage 两种语义兼容(实测两种端点都存在):
//   DeepSeek 兼容层: input_tokens 不含缓存读(cacheRead > input 时)→ 按 miss 价部分 = input + creation
//   Anthropic 官方:  input 含缓存读 → 按 miss 价部分 = input - cacheRead(creation 含在 input 内)
const missPart = (inputT: number, read: number, creation: number): number =>
  Math.max(0, read > inputT ? inputT + creation : inputT - read)
// 命中率分母同理:总输入 = DeepSeek 语义下 input + read + creation;Anthropic 语义下 input 已含
const totalInputTokens = (inputT: number, read: number, creation: number): number =>
  read > inputT ? inputT + read + creation : inputT

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
  input: 0, output: 0, cacheRead: 0, cacheCreation: 0, firstAt: null, lastAt: null, loads: [],
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

export const register: Register = (on) => {
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
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (!ready) ready = readTotals($, loadAt).then((t) => { T = t })
      await ready
      if (e.agentId) {
        T.subagentTurns += 1
      } else if (e.usage) {
        T.turns += 1
        T.input += e.usage.input_tokens ?? 0
        T.output += e.usage.output_tokens ?? 0
        T.cacheRead += e.usage.cache_read_input_tokens ?? 0
        T.cacheCreation += e.usage.cache_creation_input_tokens ?? 0
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
  })

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
    let model: string | null = null
    try { model = (await $.session.model()) ?? null } catch { /* fail-open */ }
    const pro = isProModel(cfg, model)
    const pricing = pro ? cfg.pricing.pro : cfg.pricing.cheap
    const peak = isPeakAt(cfg.holidays)
    const cost = costYuan(pricing, missPart(T.input, T.cacheRead, T.cacheCreation), T.cacheRead, T.output, peak)
    // A:口径标记 —— 热重载续计过的会话在条上明示(没发生过就不占位置)
    const reloadMark = T.loads.length > 1 ? ` · 续计${T.loads.length - 1}载` : ''
    return (
      <Box>
        <Text dimColor>
          [opt] {T.turns}轮 · ctx {ctxText || '?'} · 输入 {fmt(T.input)} + 缓存读 {fmt(T.cacheRead)} / 写 {fmt(T.cacheCreation)} · 输出 {fmt(T.output)}
          {hit !== null ? ` · 命中 ${hit.toFixed(1)}%` : ''} · ¥{cost.toFixed(2)}{peak ? ' 高峰' : ''}{pro ? '·Pro' : '·基础档'}{reloadMark}
        </Text>
        {compactWarn !== '' && <Text>{compactWarn}</Text>}
      </Box>
    )
  })

  on('command.run', { command: 'token-status' }, async ($) => {
    if (!ready) ready = readTotals($, loadAt).then((t) => { T = t })
    await ready.catch(() => { /* fail-open */ })
    const { totalIn, hit } = totals()
    const cfg = await loadConfig($)
    let model: string | null = null
    try { model = (await $.session.model()) ?? null } catch { /* fail-open */ }
    const pro = isProModel(cfg, model)
    const pricing = pro ? cfg.pricing.pro : cfg.pricing.cheap
    const peak = isPeakAt(cfg.holidays)
    const uncached = missPart(T.input, T.cacheRead, T.cacheCreation)
    const cost = costYuan(pricing, uncached, T.cacheRead, T.output, peak)
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
        `- 当前模型: ${model ?? '未知'}(${pro ? 'Pro 档' : '基础档'},按 config.json 价目计价)`,
        `- 轮次: ${T.turns}${T.turnsNoUsage > 0 || T.subagentTurns > 0 ? `(另有 usage 缺失 ${T.turnsNoUsage} 轮、子代理 ${T.subagentTurns} 轮,未计价)` : ''}`,
        `- 输入 ${fmt(T.input)} / 缓存读 ${fmt(T.cacheRead)} / 缓存写 ${fmt(T.cacheCreation)} / 输出 ${fmt(T.output)}`,
        `- 缓存命中率: ${hit !== null ? `${hit.toFixed(1)}%` : '暂无数据'}`,
        `- 成本(¥,${pro ? 'Pro' : '基础'}档): ¥${cost.toFixed(3)}(${peak ? '高峰' : '空闲'}价) · 输入未命中 ¥${((uncached * pricing[peak ? 'peak' : 'idle'].miss) / 1_000_000).toFixed(3)} / 命中 ¥${((T.cacheRead * pricing[peak ? 'peak' : 'idle'].hit) / 1_000_000).toFixed(3)} / 输出 ¥${((T.output * pricing[peak ? 'peak' : 'idle'].out) / 1_000_000).toFixed(3)}`,
        outShare !== null ? `- 输出占比 ${outShare}%(输出含思考 token;cacheCreation 按未命中价计)` : '- 输出占比: 暂无数据',
        `- 统计窗口: 会话始于 ${stamp(T.startedAt)} · 首轮于 ${hm(T.firstAt)} · 本实例 register 加载 ${T.loads.length} 次${T.loads.length > 1 ? '(热重载过 → 已续计,未丢轮次)' : '(未重载)'}${T.loads.length >= 20 ? ' ⚠ 加载次数触顶,可能频繁重载' : ''}`,
        '- 口径: 来自 turn.complete usage 聚合(仅主会话;该事件 usage = 该轮所有真实请求之和,CC 类型定义原文);计数持久在 $.state,热重载不清零;高峰=工作日 9-12/14-18 且非法定节假日,周末(含调休周末)与节假日全空闲;价目/档位/升级规则在 plugin/config.json。',
        '- hooks 层(readDedup/outputTrim/coldStartGuard/modelDirector)计数见 <CLAUDE_CONFIG_DIR>/token-optimizer/state.json 与工具结果标注。',
        compactLine,
      ].filter(Boolean).join('\n'),
      context: compactNote ? [compactNote] : undefined,
    }
  })
}

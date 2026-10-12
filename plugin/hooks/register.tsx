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

// usage 两种语义兼容(实测两种端点都存在):
//   DeepSeek 兼容层: input_tokens 不含缓存读(cacheRead > input 时)→ 总输入 = input + read + creation
//   Anthropic 官方:  input 含缓存读 → 总输入 = input
// 本层只用到"总输入"(算命中率),不涉及金额,故两种语义下同一式即可(本文件不再有任何计价函数)。
const totalInputTokens = (inputT: number, read: number, creation: number): number =>
  read > inputT ? inputT + read + creation : inputT

// (2026-10-12 删)原 `guardProHit`:按 `_proAt` 的时间窗推断"这一轮是不是 Pro 档作答",只服务于成本分账。
// 金额显示整个移除后它没有消费者了 ⇒ 删掉推理,但 **`_proAt` / `_proEpoch` 这两个事实照旧由 hooks 层的
// markSkillUpgrade 落盘**(`_proEpoch` 给硬升档闸放行用,和金额无关),别把它们一起删了。
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
  // (0.3.0)本层不再读 config.json:金额移除后它没有要读的配置了(hooks 层的 tokenGuard.ts 照旧读)。
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
        // 「上轮 +Δ」(2026-10-12 取代原来的"按真实档位分账"):这一轮总共用掉多少 token。
        // 不再推断档位来折算金额 —— 网关会自己按调用混档、日志又不记实际服务的模型(见文件头)。
        T.lastTurnTokens = tIn + tOut + tRead + tCreation
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
    // 「上轮 +Δ」取代原来的「金额 + 档位标记」(2026-10-12):这是条上唯一能指导行为的数 ——
    // 上轮往上下文里塞了多少,之后每一轮都要连带重读一遍。旧账本没有该字段 ⇒ 那一格不显示。
    const deltaMark = T.lastTurnTokens > 0 ? ` · 上轮 +${fmt(T.lastTurnTokens)}` : ''
    // A:口径标记 —— 热重载续计过的会话在条上明示(没发生过就不占位置)
    const reloadMark = T.loads.length > 1 ? ` · 续计${T.loads.length - 1}载` : ''
    return (
      <Box>
        <Text dimColor>
          [opt] {T.turns}轮 · ctx {ctxText || '?'} · 输入 {fmt(T.input)} + 缓存读 {fmt(T.cacheRead)} / 写 {fmt(T.cacheCreation)} · 输出 {fmt(T.output)}
          {hit !== null ? ` · 命中 ${hit.toFixed(1)}%` : ''}{deltaMark}{reloadMark}
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
        outShare !== null ? `- 输出占比 ${outShare}%(输出含思考 token)` : '- 输出占比: 暂无数据',
        `- 统计窗口: 会话始于 ${stamp(T.startedAt)} · 首轮于 ${hm(T.firstAt)} · 本实例 register 加载 ${T.loads.length} 次${T.loads.length > 1 ? '(热重载过 → 已续计,未丢轮次)' : '(未重载)'}${T.loads.length >= 20 ? ' ⚠ 加载次数触顶,可能频繁重载' : ''}`,
        '- 口径: 来自 turn.complete usage 聚合(仅主会话);**只报 token,不折算金额** —— 各厂商计费口径不同,而 token 是厂商无关的硬事实。实测同一批 token,平台按"网关自己路由的模型"计费、本插件按"引擎报的档位"计价,两者曾差 2.5~4 倍,且会话日志**不记录实际服务的模型** ⇒ 0.3.0 起彻底移除金额显示,钱一律以你的账单为准。计数持久在 $.state,热重载不清零。',
        '- 档位/升级规则在 plugin/config.json(价目表已随 0.3.0 移除)。',
        '- hooks 层(readDedup/outputTrim/coldStartGuard/modelDirector)计数在 <CLAUDE_CONFIG_DIR>/plugins/store/cc-token-optimizer*.json 的 guard-state(v0.2.1 起跨会话);工具结果里的裁剪/存档标注同源。',
        compactLine,
      ].filter(Boolean).join('\n'),
      context: compactNote ? [compactNote] : undefined,
    }
  })
}

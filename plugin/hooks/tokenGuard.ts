// cc-token-optimizer — settings-hook 层的 mod 移植版(随插件一键安装,无需手工配 settings.json)
//
// 六个模块(与原 hooks/token-hook.mjs 同源):
//   readDedup      classic.PreToolUse  Read            — 文件未变且区间已读 → deny
//   recordRead     classic.PostToolUse Read            — 记录 mtime/size + 已读区间
//   outputTrim     classic.PostToolUse Bash/PowerShell — 重复行折叠 + 超长输出头尾采样
//   stats          上面两者内联                            — 拦截/裁剪/折叠计数
//   coldStartGuard classic.SessionStart                 — 缓存过期 → additionalContext
//   modelDirector  classic.SessionStart / UserPromptSubmit / PreModelSwitch / PostModelSwitch
//
// 与 Node 版的差异(仅 I/O 层):
//   * 文件读写 → $.fs.read / $.fs.write / $.fs.stat / $.fs.list(异步)
//   * state.json → $.store(宿主保存,**跨会话**与热重载都在)
//     ⚠ 别用 $.state:那是会话级内存("held by the host for the session"),会话一结束就蒸发,
//       统计/已读记录/粘性窗口全要跨会话 ⇒ 必须用 $.store(落 <配置目录>/plugins/store/)
//     ⇒ 原版的 mkdir 锁 / tmp+rename 原子写整套消失:单实例、无跨进程争抢
//   * console.log(JSON) → 直接 return(⚠ classic hook 的返回是**扁平字段**,
//     不是 settings hook stdout 的 { hookSpecificOutput: {...} } 包装 —— 引擎自己做那层转换)
//   * 给用户的提示(setTimeout 里的 systemMessage)→ $.ui.toast
// 铁律不变:任何异常静默放行(fail-open),绝不阻断工具。
import type { Register } from 'claude-code'

// ============================ 常量 ============================
const TRIM_MIN = 5000
const REPEAT_RUN = 3
const HEAD = 1500
const TAIL = 1500
const ERR_HEAD = 800
const ERR_TAIL = 800
const MAX_DENIES = 3
const MAX_FILES_PER_SESSION = 200
const SESSION_KEEP = 5
const STICKY_DEFAULT_MIN = 30
const ARCHIVE_KEEP = 20
const STATS_KEEP = 60
// 硬升档闸只对**代码文件**生效:改 README/记忆/纯文档不算 coding,拦下来只会让用户白丢一轮
// (2026-10-09 实测:闸门对任何 Edit/Write 都生效时,改文档也会被拦)。按扩展名(小写)判断。
const CODE_EXT = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'ps1', 'psm1', 'sh', 'bash', 'zsh', 'fish',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'fs', 'rb', 'php', 'lua',
  'r', 'jl', 'pl', 'scala', 'ex', 'exs', 'erl', 'hs', 'ml', 'dart', 'groovy', 'gradle', 'cmake', 'mk',
  'sql', 'proto', 'graphql', 'gql', 'vue', 'svelte', 'astro', 'css', 'scss', 'less', 'html', 'htm',
  'json', 'jsonc', 'toml', 'yaml', 'yml', 'ini', 'conf', 'cfg', 'ipynb',
])
const CODE_BASENAMES = new Set(['dockerfile', 'makefile', 'cmakelists.txt'])
// 改动类工具(用于落 coding 流时间戳)。注意:原 Node 版还列了 MultiEdit,
// 但 CC 2.1.293 的工具表里没有它(matcher 是类型化的,会被拒绝)—— 故移除。
const CODING_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

type Tier = { hit: number; miss: number; out: number }
type PriceTier = { idle: Tier; peak: Tier }
type Cfg = {
  defaultTier: string
  pricing: { cheap: PriceTier; pro: PriceTier }
  holidays: string[]
  models: { cheap: string; pro: string }
  /** 金额前缀(¥ / $ / 元 等)。换供应商时改这里,悬浮条、/token-status、切换成本估算都跟着变。 */
  currency: string
  /** skillName 非空 → 升档建议让模型调用该技能(技能的 `model:` 头是 CC 里唯一非用户触发的切档通路);
   *  留空 → 退化为通用措辞(建议用户自己 /model)。 */
  upgrade: { keywords: string[]; cooldownMin: number; stickyMin: number; skillName: string }
}
const DEFAULT_CONFIG: Cfg = {
  defaultTier: 'pro',
  pricing: {
    cheap: { idle: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } },
    pro: { idle: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } },
  },
  holidays: ['2026-01-01', '2026-05-01', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
  models: { cheap: 'deepseek-v4-flash', pro: 'deepseek-v4-pro[1m]' },
  currency: '¥',
  upgrade: {
    keywords: ['设计', '架构', '重构', '方案', '决策', '算法', 'design', 'architecture', 'refactor', 'plan'],
    cooldownMin: 10,
    stickyMin: STICKY_DEFAULT_MIN,
    // 内置默认留空 = 通用措辞(任何供应商都说得通);插件自带的 config.json 填 'coding-pro'。
    skillName: '',
  },
}
let cfgCache: Cfg | null = null
// 读一次缓存住(含失败回退);$ 只在顶层函数间传递(mod 环境无 Node,只能走 $.fs)
async function loadConfig($: any): Promise<Cfg> {
  if (cfgCache !== null) return cfgCache
  try {
    const text: string = await $.fs.read(`${$.plugin.root}/config.json`)
    const cfg = JSON.parse(text)
    cfgCache = {
      ...DEFAULT_CONFIG,
      ...cfg,
      pricing: { ...DEFAULT_CONFIG.pricing, ...cfg?.pricing },
      models: { ...DEFAULT_CONFIG.models, ...cfg?.models },
      upgrade: { ...DEFAULT_CONFIG.upgrade, ...cfg?.upgrade },
    } as Cfg
  } catch { cfgCache = DEFAULT_CONFIG }
  return cfgCache ?? DEFAULT_CONFIG
}
const isProModel = (cfg: Cfg, m: string | null | undefined): boolean =>
  !!m && (m === cfg.models.pro || (String(m).includes('pro') && !String(m).includes('flash')))
// 强档技能名的**用户级覆盖**:manifest 的 userConfig `upgrade_skill` 由宿主解析进 register(on, options)
// (值存用户 settings.json 的 pluginConfigs,改它会重载插件)。优先级:插件选项 > config.json 的 skillName。
// 有了它,插件自带的 config.json 可以留空(陌生人零副作用 —— 不会去调用一个他没有的技能),
// 而想用硬升档闸的人在自己的 /config 里填一个技能名即可,插件升级也不会覆盖。
let optSkillName = ''
const effectiveSkill = (cfg: Cfg): string => optSkillName || cfg.upgrade.skillName || ''

// ============================ 纯逻辑(与 Node 版同源) ============================
function mergeRanges(ranges: number[][], add: number[]): number[][] {
  const all = [...ranges, add].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
  const out: number[][] = []
  for (const r of all) {
    const last = out[out.length - 1]
    const lo = r[0] ?? 0
    const hi = r[1] ?? 0
    if (last && lo <= (last[1] ?? 0) + 1) last[1] = Math.max(last[1] ?? 0, hi)
    else out.push([lo, hi])
  }
  return out
}
// ⚠ e 有两种形状:classic(stdin JSON,参数包在 tool_input 里)与 mod 原生(展平到 e 上)。
// 只读 tool_input 会让 mod 路径永远退化成默认区间 1-2000,去重判据就失去意义。
function wantedRange(e: any): number[] {
  const src = e?.tool_input ?? e
  const offset = typeof src?.offset === 'number' ? src.offset : 1
  const limit = typeof src?.limit === 'number' ? src.limit : 2000
  return [offset, offset + limit - 1]
}
function collapseRepeats(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n')
  const out: string[] = []
  let collapsed = 0
  for (let i = 0; i < lines.length;) {
    const cur = lines[i] ?? ''
    let j = i
    while (j + 1 < lines.length && lines[j + 1] === cur) j++
    const run = j - i + 1
    if (run >= REPEAT_RUN && cur.trim() !== '') {
      out.push(cur)
      out.push(`[cc-token-optimizer: 后续 ${run - 1} 行与此行完全相同,已折叠]`)
      collapsed += run - 1
    } else {
      out.push(...lines.slice(i, j + 1))
    }
    i = j + 1
  }
  return { text: out.join('\n'), collapsed }
}
function trimAndCollapse(text: string, isErr: boolean): { text: string; collapsed: number; trimmedChars: number } | null {
  const origLen = text.length
  const { text: c, collapsed } = collapseRepeats(text)
  if (c.length < TRIM_MIN) {
    if (collapsed === 0) return null
    return { text: c + `\n[cc-token-optimizer: 已折叠 ${collapsed} 行重复行]`, collapsed, trimmedChars: 0 }
  }
  const head = isErr ? ERR_HEAD : HEAD
  const tail = isErr ? ERR_TAIL : TAIL
  const note =
    `\n[cc-token-optimizer: 输出 ${origLen} 字符` +
    (collapsed > 0 ? `,已折叠 ${collapsed} 行重复行` : '') +
    `,裁剪为头尾采样 ${head}+${tail}]`
  const cut = c.slice(0, head) + `\n...(中间省略 ${c.length - head - tail} 字符)...\n` + c.slice(-tail) + note
  return { text: cut, collapsed, trimmedChars: origLen - cut.length }
}
// 会话 id:状态现在落在**跨会话**的 $.store 里,必须拿到真会话 id 才能分桶。
// ⚠ mod 的 tool.call 载荷不带 session_id,只靠 e.session_id 会全部退化成 'default'
//   ⇒ 所有会话挤进同一个桶、互相污染(readDedup 拿错记录、_stats 串账)。
// 首选 $.session.id()(引擎给的真 id),取不到才回退载荷。
async function sessionId($: any, e: any): Promise<string> {
  try {
    const id = await $.session.id()
    if (typeof id === 'string' && id !== '') return id
  } catch { /* 回退载荷 */ }
  return e?.session_id ?? 'default'
}
// 上下文键:子 agent 独立成桶(payload 里只有 agent_id 可区分)
function ctxKey(e: any, session: string): string {
  // classic 事件用 snake_case(agent_id),mod 原生事件用 camelCase(agentId),两者都认。
  const agent = e.agent_id ?? e.agentId
  return agent ? `${session}::agent:${agent}` : session
}
// 事件载荷兼容:classic.* 的 e 是 stdin JSON(tool_input.file_path / tool_name),
// mod 原生 tool.call 的 e 是展平的(file_path / tool)。两处都取,哪个在就用哪个。
function filePathOf(e: any): string | undefined {
  const p = e?.tool_input?.file_path ?? e?.file_path
  return typeof p === 'string' ? p : undefined
}
// 硬升档闸的门槛:只有代码文件才值得强制升档(见 CODE_EXT);路径形态两种载荷都吃
function isCodePath(path: string | undefined): boolean {
  if (!path) return false
  const base = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  if (CODE_BASENAMES.has(base)) return true
  const dot = base.lastIndexOf('.')
  return dot >= 0 && CODE_EXT.has(base.slice(dot + 1))
}
function toolNameOf(e: any): string {
  return String(e?.tool_name ?? e?.tool ?? '')
}

// ============================ state($.store 替代 state.json) ============================
// 一个 key 存整份状态(与旧 state.json 同构):$.store 的 set 是整值覆盖,读改写一次到位。
// 与 $.state 的差别只有生命周期:这里跨会话,那边会话级。
const STORE_KEY = 'guard-state'
async function readState($: any): Promise<any> {
  try { return (await $.store.get(STORE_KEY)) ?? {} } catch { return {} }
}
async function writeState($: any, s: any): Promise<void> {
  try { await $.store.set(STORE_KEY, s) } catch { /* 写失败不致命 */ }
}
function statEntry(state: any, session: string) {
  state._stats = state._stats ?? {}
  const s = (state._stats[session] ??= { denies: 0, trims: 0, trimmedChars: 0, collapsedLines: 0 })
  s._at = Date.now() // 给 pruneStats 排序用(不是会话桶的 _at)
  return s
}
// 文件 stat:$.fs.stat → { kind, size, mtimeMs };非普通文件返回 null
async function fileStat($: any, p: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await $.fs.stat(p)
    return st && st.kind === 'file' ? { mtimeMs: st.mtimeMs, size: st.size } : null
  } catch { return null }
}
// 裁剪前存档:原输出落盘,模型只看到路径。
// ⚠ mod 的 $.fs 没有删除 API,所以"淘汰最旧"用清空(写空串)代替删除 —— 空存档等同失效。
async function archiveOriginal($: any, session: string, tool: string, raw: string): Promise<string | null> {
  try {
    const dir = `${$.plugin.root}/.archive/${String(session).replace(/[^\w-]/g, '') || 'default'}`
    let names: string[] = []
    try {
      const entries = await $.fs.list(dir)
      names = entries.filter((x: any) => x.kind === 'file').map((x: any) => String(x.name)).sort()
    } catch { /* 目录还不存在 */ }
    const excess = names.length - ARCHIVE_KEEP + 1
    for (const n of names.slice(0, Math.max(0, excess))) {
      try { await $.fs.write(`${dir}/${n}`, '') } catch { /* 清不掉就算了 */ }
    }
    const path = `${dir}/${Date.now()}-${String(tool).replace(/[^\w-]/g, '') || 'tool'}.txt`
    await $.fs.write(path, raw)
    return path
  } catch { return null }
}
// 修剪:状态跨会话累积在同一个 store 文件里(有 4 MiB 上限),保留最近活跃的若干会话桶
function pruneState(state: any): void {
  const keys = Object.keys(state).filter((k) => k !== '_strikes' && k !== '_stats')
  const mains = keys.filter((k) => !k.includes('::agent:'))
  const byAge = [...mains].sort((a, b) => (state[b]?._at ?? 0) - (state[a]?._at ?? 0))
  const dropped = new Set(byAge.slice(SESSION_KEEP))
  for (const m of dropped) delete state[m]
  for (const k of keys) {
    if (k.includes('::agent:') && dropped.has(k.slice(0, k.indexOf('::agent:')))) delete state[k]
  }
  if (state._strikes) {
    for (const k of Object.keys(state._strikes)) if (!state[k]) delete state._strikes[k]
  }
  pruneStats(state)
}
// _stats 跨会话永久累积,只留最近 STATS_KEEP 个会话的计数(防 store 文件无限膨胀)
function pruneStats(state: any): void {
  const st = state._stats
  if (!st) return
  const keys = Object.keys(st)
  if (keys.length <= STATS_KEEP) return
  keys.sort((a, b) => (st[a]?._at ?? 0) - (st[b]?._at ?? 0))
  for (const k of keys.slice(0, keys.length - STATS_KEEP)) delete st[k]
}

// ============================ 六模块 ============================
// readDedup:文件未变 + 区间已覆盖 → permissionDecision: deny
async function readDedup($: any, e: any): Promise<string | null> {
  const path = filePathOf(e)
  if (path === undefined || e?.tool_input?.pages !== undefined) return null
  const st = await fileStat($, path)
  if (!st) return null
  const session = await sessionId($, e)
  const ctx = ctxKey(e, session)
  const want = wantedRange(e)
  const state = await readState($)
  const rec = state[ctx]?.[path]
  const strikes = state._strikes?.[ctx]?.[path] ?? 0
  const unchanged = rec && rec.v === 2 && rec.mtimeMs === st.mtimeMs && rec.size === st.size
  if (unchanged && rec.ranges) {
    const covered = (rec.ranges as number[][]).some(([s, t]) => (s ?? 0) <= (want[0] ?? 0) && (t ?? 0) >= (want[1] ?? 0))
    if (covered && strikes < MAX_DENIES) {
      state._strikes = state._strikes ?? {}
      state._strikes[ctx] = state._strikes[ctx] ?? {}
      state._strikes[ctx][path] = strikes + 1
      if (state[ctx]) state[ctx]._at = Date.now()
      statEntry(state, session).denies += 1
      await writeState($, state)
      return (
        `[cc-token-optimizer] ${path} 自上次读取后未变化,区间 ${want[0]}-${want[1]} 已在上下文中,无需重读。` +
        `连续 ${MAX_DENIES} 次拦截将自动放行;强制重读可修改文件。`
      )
    }
  }
  if (strikes > 0) {
    state._strikes[ctx][path] = 0
    if (state[ctx]) state[ctx]._at = Date.now()
    await writeState($, state)
  }
  return null
}

// recordRead:成功读后记录 mtime/size + 区间
async function recordRead($: any, e: any): Promise<void> {
  const path = filePathOf(e)
  if (path === undefined) return
  const st = await fileStat($, path)
  if (!st) return
  const ctx = ctxKey(e, await sessionId($, e))
  const state = await readState($)
  const sess = state[ctx] ?? {}
  const rec = sess[path]
  const range = wantedRange(e)
  const sameFile = rec && rec.v === 2 && rec.mtimeMs === st.mtimeMs && rec.size === st.size
  const ranges = sameFile ? mergeRanges(rec.ranges ?? [], range) : [range]
  if (!sess[path]) {
    const paths = Object.keys(sess).filter((k) => !k.startsWith('_'))
    if (paths.length >= MAX_FILES_PER_SESSION) delete sess[paths[0] as string]
  }
  sess[path] = { mtimeMs: st.mtimeMs, size: st.size, ranges, v: 2, at: Date.now() }
  sess._at = Date.now()
  state[ctx] = sess
  pruneState(state)
  await writeState($, state)
}

// 每回合把序号 +1:硬升档闸据此保证「每回合最多强制一次」(见 codingToolGate)。
// ⚠ 实测(2026-10-09)两条:①$.session.model() 反映的是**会话基础档**,技能的 model: 头切档它看不见
// ⇒ 不能用"冷却时间"去重(长回合里会每 60 秒重复拦同一件事);②用**回合序号**而非时间戳 ——
// 时间戳在"从未打过回合标记"时会被误判成"本回合已经强制过",该拦的就不拦了。
async function markTurn($: any, e: any): Promise<void> {
  const session = await sessionId($, e)
  const state = await readState($)
  const sess = state[session] ?? {}
  sess._turn = (sess._turn ?? 0) + 1
  sess._at = Date.now()
  state[session] = sess
  await writeState($, state)
}
// 改动类工具:①落 coding 时间戳(升档粘性窗口) ②硬升档闸 —— 当前在基础档且配了升级技能时,
// 拦一次"模型对本回合代码的首次改动",要它先激活技能再重试;该回合余下推理就走强档。
// 判据是模型自己的动作(它决定改代码=这轮是 coding),不是猜用户文本;决定仍由插件做出。
// 档位取 $.session.model():它是**会话基础档**(实测技能的回合级切档它看不见),所以只用它判断
// "用户是不是本来就常驻强档",不用它去重;去重靠 `_turn`/`_forcedTurn`(每回合最多强制一次)。
// 没配技能名时完全不拦(没技能可调,拦下来只会让模型卡住)。
async function codingToolGate($: any, e: any): Promise<string | null> {
  const session = await sessionId($, e)
  const state = await readState($)
  const sid = session
  const sess = state[sid] ?? {}
  // 只认**代码文件**:改 README/.json 不该算"近期改过代码"(2026-10-10 修 —— 这个时间戳曾经无条件写,
  // 于是写文档也会让粘性窗口连续 stickyMin 分钟把纯文档轮判成 coding 流,实测把不该升档的轮也推上强档)
  const isCode = isCodePath(filePathOf(e))
  if (isCode) sess._codingAt = Date.now()
  sess._at = Date.now()
  state[sid] = sess
  let deny: string | null = null
  const cfg = await loadConfig($)
  const skill = effectiveSkill(cfg)
  if (skill) {
    let live: unknown = null
    try { live = await $.session.model() } catch { /* 取不到当未知 */ }
    // 每回合最多强制一次:用回合序号比对(时间戳在"未打标记"时会误判为已强制,且同毫秒会撞)
    const turn = sess._turn ?? 0
    // 只拦代码文件(改文档不拦);档位未知时不拦:拦了却给不出可行的下一步,比不拦更糟(fail-open)
    if (
      (sess._forcedTurn ?? -1) !== turn &&
      isCode &&
      typeof live === 'string' && live !== '' && !isProModel(cfg, live)
    ) {
      sess._forcedTurn = turn
      deny =
        `[cc-token-optimizer] 本回合首次改动代码,但当前是基础档:请先调用 Skill 工具(${skill}) ` +
        `让后续在强档执行(回合级、下一轮自动回落),然后**重试刚才那次调用** —— 只多花一次往返。`
    }
  }
  await writeState($, state)
  return deny
}

// outputTrim:重复行折叠 + 超长输出头尾采样 → updatedToolOutput
async function trimOutput($: any, e: any): Promise<any | null> {
  const resp = e.tool_response
  if (resp == null) return null
  const session = await sessionId($, e)
  const tool = toolNameOf(e)
  let collapsed = 0
  let trimmedChars = 0
  let updated: unknown = null
  if (typeof resp === 'string') {
    const isFail = /\[exit[^\]]*code[^\]]*[:：]\s*[1-9]/.test(resp)
    const r = trimAndCollapse(resp, isFail)
    if (!r) return null
    collapsed += r.collapsed
    trimmedChars += r.trimmedChars
    const archived = await archiveOriginal($, session, tool, resp)
    updated = archived ? r.text + `\n[cc-token-optimizer: 完整原输出已存档(未注入上下文):${archived}]` : r.text
  } else if (typeof resp === 'object') {
    const o: any = { ...(resp as object) }
    const touched: string[] = []
    for (const k of ['stdout', 'stderr']) {
      const v = o[k]
      if (typeof v !== 'string') continue
      const r = trimAndCollapse(v, k === 'stderr')
      if (!r) continue
      o[k] = r.text
      collapsed += r.collapsed
      trimmedChars += r.trimmedChars
      touched.push(k)
    }
    if (!touched.length) return null
    const archived = await archiveOriginal($, session, tool, JSON.stringify(resp))
    const first = touched[0] as string
    o[first] = String(o[first]) + (archived ? `\n[cc-token-optimizer: 完整原输出已存档(未注入上下文):${archived}]` : '')
    updated = o
  }
  if (updated === null) return null
  if (collapsed > 0 || trimmedChars > 0) {
    const state = await readState($)
    const s = statEntry(state, session)
    if (trimmedChars > 0) { s.trims += 1; s.trimmedChars += trimmedChars }
    if (collapsed > 0) s.collapsedLines += collapsed
    await writeState($, state)
  }
  return { updatedToolOutput: updated }
}

// coldStartGuard:resume 且缓存过期 → additionalContext
function coldStartGuard(e: any): string | null {
  if (!e.prompt_cache_likely_expired) return null
  const ctx = typeof e.context_tokens === 'number' ? Math.round(e.context_tokens / 1000) : null
  const usd = e.estimated_cache_write_usd
  return (
    `[cc-token-optimizer] 会话恢复,但提示缓存已过期` +
    (ctx !== null ? `:上下文约 ${ctx}k token` : '') +
    (usd !== undefined ? `,重新缓存预计约 $${usd}` : '') +
    `。若本会话任务已结束,建议 /clear 开新会话,可免去整段历史的全价重读。`
  )
}

// ---- modelDirector ----
async function setSessionModel($: any, session: string, model: string): Promise<void> {
  const state = await readState($)
  const sess = state[session] ?? {}
  sess._model = model
  sess._at = Date.now()
  state[session] = sess
  await writeState($, state)
}
function tierAdvice(cfg: Cfg): { stay: string; up: string } {
  const isProDefault = cfg.defaultTier !== 'cheap'
  const skill = effectiveSkill(cfg)
  const upCheap = skill
    ? `涉及 coding(写/改代码、调试、重构、脚本、报错)时,先调用 Skill 工具(${skill}) 让本回合跑 Pro 档(回合级、自动回落),再动手;其他复杂任务可在动手前建议用户 /model ${cfg.models.pro}。`
    : `涉及 coding(写/改代码、调试、重构、脚本、报错)时,建议用户先 /model ${cfg.models.pro} 升 Pro 档再动手;其他复杂任务同理。`
  return {
    stay: isProDefault
      ? '跑腿活(搜索/批量读取/机械改动)派 subagent,它们走基础档;主会话不必为省钱降档。'
      : `任务完成后记得切回基础档:/model ${cfg.models.cheap}。`,
    up: isProDefault
      ? `判断力吃紧(设计/架构/复杂调试)就切回主力:/model ${cfg.models.pro}。`
      : upCheap,
  }
}
// SessionStart:记模型 + 档位纪律注入
async function modelPolicy($: any, e: any, cfg: Cfg): Promise<string | null> {
  const model = e.model
  if (typeof model !== 'string' || model === '') return null
  await setSessionModel($, await sessionId($, e), model)
  const adv = tierAdvice(cfg)
  return isProModel(cfg, model)
    ? `[cc-token-optimizer] 当前 Pro 档(输出 ${cfg.currency}${cfg.pricing.pro.idle.out}/M)。` + adv.stay
    : `[cc-token-optimizer] 当前基础档(输出 ${cfg.currency}${cfg.pricing.cheap.idle.out}/M)。` + adv.up
}
// UserPromptSubmit:机械检测 → 驱动回合级升档。返回 { additionalContext, toast? }
async function upgradeHeuristic($: any, e: any, cfg: Cfg): Promise<{ additionalContext: string; toast?: string } | null> {
  const prompt = e.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') return null
  const session = await sessionId($, e)
  const state = await readState($)
  const up = cfg.upgrade
  const kwHit = (up.keywords ?? []).some((k) => prompt.toLowerCase().includes(String(k).toLowerCase()))
  const codingFlow = Date.now() - (state[session]?._codingAt ?? 0) < (up.stickyMin ?? STICKY_DEFAULT_MIN) * 60_000
  // 长度不再单独触发(2026-10-09):阈值 120 字符时粘贴网页/日志必然命中,而"长"与"复杂任务"无关,
  // 误报的代价是用户白升 Pro —— 省钱插件让人多花钱是最糟的方向。只认关键词命中与粘性窗口。
  if (!kwHit && !codingFlow) return null
  const model = state[session]?._model ?? null
  // 给模型的指令:条件式、每轮都给、不带冷却(档位判定交给模型读自己每轮的系统提示,不按 state 拦)
  const skill = effectiveSkill(cfg)
  const additionalContext =
    `[cc-token-optimizer] 本条命中${kwHit ? ' coding 信号' : ' coding 流(近期有代码改动)'}:` +
    (skill
      ? `若你当前不在 Pro 档,动手前先调用 Skill 工具(${skill})让本回合以 Pro 档执行(回合级、自动回落;改一行/加注释这类小事可不调用);已在 Pro 档则忽略本条。`
      : `若你当前不在 Pro 档,动手前建议用户 /model ${cfg.models.pro} 升档再动手(改一行/加注释这类小事可不升);已在 Pro 档则忽略本条。`)
  // 给用户的提示:只对关键词命中发(粘性窗口下的短句续接只提醒模型、不打扰用户);带冷却;记录档位已是 Pro 时不发
  const last = state[session]?._upgradeSugAt ?? 0
  if (kwHit && !isProModel(cfg, model) && Date.now() - last >= (up.cooldownMin ?? 10) * 60_000) {
    const s2 = await readState($)
    const sess = s2[session] ?? {}
    sess._upgradeSugAt = Date.now()
    sess._at = Date.now()
    s2[session] = sess
    await writeState($, s2)
    return {
      additionalContext,
      toast: skill
        ? `[cc-token-optimizer] 本条判为 coding 任务,本回合按 Pro 档执行(下一轮自动回 ${cfg.models.cheap})。` +
          `想让整段会话都用 Pro 就 /model ${cfg.models.pro};否则无需操作。`
        : `[cc-token-optimizer] 本条判为 coding 任务。未配升级技能,请自行 /model ${cfg.models.pro} 切强档(下次启动自动回 ${cfg.models.cheap})。`,
    }
  }
  return { additionalContext }
}
// PreModelSwitch:切换成本透明(给用户)
function preModelSwitch(cfg: Cfg, e: any): string | null {
  const to = e.to_model
  const from = e.from_model
  if (typeof to !== 'string' || to === from) return null
  const ctx = typeof e.context_tokens === 'number' ? Math.round(e.context_tokens / 1000) : null
  const tier = isProModel(cfg, to) ? 'pro' : 'cheap'
  const miss = cfg.pricing[tier].idle.miss
  const est = ctx !== null ? `,重缓存约 ${cfg.currency}${((ctx * 1000 * miss) / 1_000_000).toFixed(2)}(空闲价)` : ''
  return (
    `[cc-token-optimizer] 切换 ${from ?? '?'} → ${to} 将丢弃当前提示缓存` +
    (ctx !== null ? `:上下文约 ${ctx}k token` : '') + est +
    `。切换前可考虑先 /compact 或任务边界再切。`
  )
}
// PostModelSwitch:更新记录 + 档位提醒
async function postModelSwitch($: any, e: any, cfg: Cfg): Promise<{ additionalContext: string; toast: string } | null> {
  const to = e.to_model
  if (typeof to !== 'string') return null
  await setSessionModel($, await sessionId($, e), to)
  const adv = tierAdvice(cfg)
  const pro = isProModel(cfg, to)
  return pro
    ? {
      additionalContext: `[cc-token-optimizer] 已切 Pro 档(输出 ${cfg.currency}${cfg.pricing.pro.idle.out}/M,${(cfg.pricing.pro.idle.out / cfg.pricing.cheap.idle.out).toFixed(1)}x 基础档)。` + adv.stay,
      toast: `[cc-token-optimizer] 已切 Pro 档 · ${adv.stay}`,
    }
    : {
      additionalContext: `[cc-token-optimizer] 已切基础档(输出 ${cfg.currency}${cfg.pricing.cheap.idle.out}/M)。` + adv.up,
      toast: `[cc-token-optimizer] 已切基础档 · ${adv.up}`,
    }
}
// 给用户的提示走 $.ui.toast(原版是 settings hook 的 systemMessage/console.log)
async function toast($: any, text: string | undefined): Promise<void> {
  if (!text) return
  try { await $.ui.toast(text) } catch { /* fail-open */ }
}

// ============================ 注册 ============================
export const register: Register = (on, options) => {
  // 每次插件加载重读 config.json(loadConfig 会读一次缓存住):热重载/新会话改完配置即生效,
  // 引擎级测试里各用例也不会串用上一个用例的配置。
  cfgCache = null
  // userConfig 选项(manifest 声明,宿主解析后经 options 传来):强档技能名的用户级覆盖
  const v = (options as Record<string, unknown> | undefined)?.upgrade_skill
  optSkillName = typeof v === 'string' ? v.trim() : ''
  // SessionStart:coldStartGuard + modelPolicy 合并注入(都走 additionalContext)
  on('classic.SessionStart', async ($, e, next) => {
    try {
      const cfg = await loadConfig($)
      const parts: string[] = []
      const g = coldStartGuard(e)
      if (g) parts.push(g)
      const p = await modelPolicy($, e, cfg)
      if (p) parts.push(p)
      if (parts.length) return { additionalContext: [parts.join('\n\n')] }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      const cfg = await loadConfig($)
      await markTurn($, e) // 回合标记:硬升档闸每回合最多强制一次
      const out = await upgradeHeuristic($, e, cfg)
      if (out) {
        await toast($, out.toast)
        return { additionalContext: [out.additionalContext] }
      }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('classic.PreModelSwitch', async ($, e, next) => {
    try {
      const cfg = await loadConfig($)
      const msg = preModelSwitch(cfg, e)
      if (msg) await toast($, msg)
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('classic.PostModelSwitch', async ($, e, next) => {
    try {
      const cfg = await loadConfig($)
      const out = await postModelSwitch($, e, cfg)
      if (out) {
        await toast($, out.toast)
        return { additionalContext: [out.additionalContext] }
      }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  // Read 去重 + 读后记录:走 mod 原生 tool.call,而不是 classic.PreToolUse。
  // ⚠ classic.PreToolUse 不接受 permission 决策(ClassicResultFields 里没有 PreToolUse 条目),
  // 在那里返回 permissionDecision 会被静默丢弃;tool.call 的 { deny } 才是有效语义。
  // 另一个好处:去重与记录共用同一个 e,ctxKey 天然一致(两条独立 classic 事件链不保证一致)。
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    try {
      const reason = await readDedup($, e)
      if (reason) return { deny: reason }
      const r = await next(e)
      await recordRead($, e)
      return r
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  // 改动类工具:落 coding 时间戳 + 硬升档闸(见 codingToolGate)
  on('tool.call', { tool: CODING_TOOLS }, async ($, e, next) => {
    try {
      const reason = await codingToolGate($, e)
      if (reason) return { deny: reason }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  // PostToolUse:Read 记区间;Bash/PowerShell 裁剪输出
  on('classic.PostToolUse', async ($, e, next) => {
    try {
      const tool = toolNameOf(e)
      if (tool === 'Read') {
        await recordRead($, e)
      } else if (tool === 'Bash' || tool === 'PowerShell') {
        const out = await trimOutput($, e)
        if (out) return out
      }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))
}

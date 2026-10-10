// cc-token-optimizer — settings-hook 层的 mod 移植版(随插件一键安装,无需手工配 settings.json)
//
// 八个模块(与原 hooks/token-hook.mjs 同源;后两个是 0.2.6 加的):
//   readDedup      tool.call Read                      — 文件未变且区间已读 → deny(带 3 次逃生)
//   recordRead     同一条 hook 里                         — 记录 mtime/size + **实际**读到的那段区间(键=解析后路径)
//   outputTrim     classic.PostToolUse Bash/PowerShell — 重复行折叠 + 超长输出头尾采样
//   stats          上面两者内联                            — 拦截/裁剪/折叠计数
//   coldStartGuard classic.SessionStart                 — 缓存过期 → additionalContext
//   modelDirector  classic.SessionStart / UserPromptSubmit / PreModelSwitch / PostModelSwitch
//   tierFact       classic.PostToolUse Skill             — 引擎自报解析模型 = 升档事实 → 当场提醒 + 落 _proAt/_proEpoch
//                  (2026-10-10:直连 DeepSeek 时 usage.model/日志的 model 报的是**会话档位**,只有这个源是真的)
//   compactReset   session.compact                      — 压缩点作废该 loop 的读记录(旧工具输出已被清出上下文)
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
    keywords: ['重构', '编译', '报错', '调试', 'refactor', 'debug', 'bug', '.py', '.ts', '.tsx', '.js', '.mjs', '.jsx', '.ps1', '.sh', '.go', '.rs', '.java', '.cpp'],
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
// Read 的 PDF 分页读(types 里 `pages` 是顶层可选参数)。
// ⚠ 2026-10-11 修:旧守卫只读 `e.tool_input.pages`,而 readDedup 只跑在 mod 原生的 tool.call 上,
// 那里的载荷是**展平**的(`e.pages`)⇒ 该守卫在真实路径上恒不成立(移植残留)。
// 后果:同一 PDF 第二次分页读被判"读过"直接拦,而拦截文案还谎称"已在上下文中"。
// 页码与行区间没有可比性 ⇒ 带 pages 的读**完全不参与**行区间去重与记账。
function pagesOf(e: any): unknown {
  return e?.tool_input?.pages ?? e?.pages
}
// 读到的**实际**行区间(优先于"请求区间")。tool.call 的 next(e) 返回值形如 { ref, result, text },
// result 是 BuiltinToolResults.Read = { type:'text', file:{ startLine, numLines, totalLines, truncatedByTokenCap? } }。
// ⚠ 2026-10-11 修:旧实现记的是**请求**区间(offset/limit,默认 1-2000)。而大文件会被 token 上限
// 自动分页(结果里 truncatedByTokenCap 就是给插件看的信号)、allow_large 读也常只回首页 ⇒
// 模型其实没看到 1-2000,记录却说看到了 ⇒ 之后为拿剩余部分重读 1-2000 被误拦。
function actualRange(r: any): number[] | null {
  const f = r?.result?.file
  const start = f?.startLine
  const n = f?.numLines
  if (typeof start !== 'number' || typeof n !== 'number' || n <= 0) return null
  return [start, start + n - 1]
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
// 正则转义(关键词里的 `.` 要当字面量)
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// 关键词命中判定。
// ⚠ 2026-10-10 修:旧实现是一律 `includes`(子串),于是 **`.json` 会命中 `.js`**、`.tsx` 会命中 `.ts` ——
// 实测证据:用户贴回一段 `/token-status` 输出(里面有 `cc-token-optimizer*.json`),模型侧就收到了 coding 指令。
// 扩展名类关键词改成"后面不能再跟字母数字";中文词与英文词仍按子串(改一行/调试一下/refactor 都要能中)。
function keywordHit(prompt: string, keywords: string[]): boolean {
  const p = prompt.toLowerCase()
  return (keywords ?? []).some((k) => {
    const s = String(k).toLowerCase()
    if (s === '') return false
    if (s.startsWith('.')) return new RegExp(`${escapeRe(s)}(?![a-z0-9])`).test(p)
    return p.includes(s)
  })
}
// 升档事实的判据(2026-10-10 重做)。
// 背景:直连 DeepSeek 时,引擎写进 `turn.complete` 的 `usage.model` 与会话日志的 `model`/`requestedModel`
// 全都是**会话档位** —— 技能升档它看不见 ⇒ 0.2.5 那条"事实式"判据(读 usage.model)在本机恒为假
// (实测:真跑在 Pro 上、`/token-status` 却报 `Pro ¥0.000(0 轮)`;近 24h 共 548 条日志零条 pro)。
// 真正可靠的来源是 **Skill 工具自己的结果**:技能的 frontmatter `model:` 头生效时,引擎把解析到的模型
// 放进结果里(类型原话:"Resolved model the skill turn runs on when a frontmatter model override took
// effect; omitted otherwise")。会话日志实测:
//   toolUseResult = {"success":true,"commandName":"coding-pro","model":"deepseek-v4-pro[1m]"}
// classic.PostToolUse 的 `tool_response`(类型 unknown,故按形状逐层取)就是它。
// Skill 工具结果的取形(类型 unknown,故按形状逐层取)。结果有两支联合:
//   内联 `{success, commandName, model?, status?, readOnly?}` / **fork** `{success, commandName, status:'forked', agentId, result}`。
// 只有内联那支带 `model`;fork 那支干活的是子 agent,主循环档位没变(见 markSkillUpgrade 的跳过)。
function skillResultObject(resp: any): any | null {
  if (resp == null) return null
  if (typeof resp === 'string') {
    const t = resp.trim()
    if (t === '' || (t[0] !== '{' && t[0] !== '[')) return null
    try { return skillResultObject(JSON.parse(t)) } catch { return null }
  }
  if (Array.isArray(resp)) {
    for (const it of resp) {
      const o = skillResultObject((it as any)?.text ?? it)
      if (o) return o
    }
    return null
  }
  if (typeof resp !== 'object') return null
  const o: any = resp
  if (o.success !== undefined || o.commandName !== undefined || o.status !== undefined || o.model !== undefined) return o
  for (const k of ['result', 'content', 'toolUseResult', 'data']) {
    if (o[k] !== undefined) {
      const inner = skillResultObject(o[k])
      if (inner) return inner
    }
  }
  return null
}
// 引擎解析出的模型:技能 frontmatter 的 `model:` 头**生效时才有**("omitted otherwise")⇒ 报了就是真的。
function resolvedSkillModel(resp: any): string | null {
  const o = skillResultObject(resp)
  const m = o?.model ?? o?.resolvedModel ?? o?.modelName
  return typeof m === 'string' && m.trim() !== '' ? m.trim() : null
}
// 展平/包封两种载荷都取(e.tool_input.skill 是 classic 信封,skill 是展平形态);
// 名字规范化:Skill 结果里的 `commandName` 可能带插件名前缀(`ns:skill`),比对时剥掉。
function skillNameOf(e: any): string {
  const s = e?.tool_input?.skill ?? e?.skill
  return typeof s === 'string' ? s.trim() : ''
}
function normalizeSkillName(s: unknown): string {
  const t = typeof s === 'string' ? s.trim() : ''
  const i = t.lastIndexOf(':')
  return i >= 0 ? t.slice(i + 1) : t
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
// 文件 stat:$.fs.stat → { kind, size, mtimeMs };非普通文件返回 null。
// ⚠ 2026-10-11:加 `{ resolve:true }` 取 realPath 当**记录键** —— 旧实现拿模型写的字面路径当键,
// 同一文件写 `D:\a\b.ts` 与 `D:/a/b.ts`(子 agent 实测真这么发生过)会各记一条 ⇒
// 去重机会白白丢掉、每会话 200 条的上限被重复项占掉。realPath 取不到就退回字面路径:
// 宁可少归一,不能丢记录。
async function fileStat($: any, p: string): Promise<{ mtimeMs: number; size: number; key: string } | null> {
  try {
    let st: any = null
    try { st = await $.fs.stat(p, { resolve: true }) } catch { st = await $.fs.stat(p) }
    if (!st || st.kind !== 'file') return null
    const real = typeof st.realPath === 'string' && st.realPath !== '' ? st.realPath : p
    return { mtimeMs: st.mtimeMs, size: st.size, key: real }
  } catch { return null }
}
// 裁剪前存档:原输出落盘,模型只看到路径。
// ⚠ mod 的 $.fs **没有删除 API**(只有 read/write/list/exists/stat/ancestors)⇒"淘汰最旧"只能用
// 清空(写空串)代替删除 —— 空存档等同失效。副作用:被淘汰的文件留下空壳、永不回收
// (内容体积有界,文件**个数**随裁剪次数增长;已知取舍,README 的 Honest edges 有记)。
// ⚠ 另一条边界:$.fs.write 超 4 MiB 会被宿主拒绝 ⇒ 超大输出其实**存不下来**(本函数返回 null,
// 调用方降级为"只给头尾采样、不给存档路径"),README 那句 "the full original is archived" 有这条上限。
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
  if (path === undefined || pagesOf(e) !== undefined) return null // 分页读不参与行区间去重(见 pagesOf)
  const st = await fileStat($, path)
  if (!st) return null
  const key = st.key // 归一后的记录键(见 fileStat);给用户的文案仍用模型自己的拼写 path
  const session = await sessionId($, e)
  const ctx = ctxKey(e, session)
  const want = wantedRange(e)
  const state = await readState($)
  const rec = state[ctx]?.[key]
  const strikes = state._strikes?.[ctx]?.[key] ?? 0
  const unchanged = rec && rec.v === 2 && rec.mtimeMs === st.mtimeMs && rec.size === st.size
  if (unchanged && rec.ranges) {
    const covered = (rec.ranges as number[][]).some(([s, t]) => (s ?? 0) <= (want[0] ?? 0) && (t ?? 0) >= (want[1] ?? 0))
    if (covered && strikes < MAX_DENIES) {
      state._strikes = state._strikes ?? {}
      state._strikes[ctx] = state._strikes[ctx] ?? {}
      state._strikes[ctx][key] = strikes + 1
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
    state._strikes[ctx][key] = 0
    if (state[ctx]) state[ctx]._at = Date.now()
    await writeState($, state)
  }
  return null
}

// recordRead:成功读后记录 mtime/size + 区间。
// r(可选)= tool.call 里 next(e) 的返回值 —— 有它才能记**实际**读到的区间(见 actualRange)。
// 记账**只**走 tool.call 这一条路(2026-10-11 删掉 classic.PostToolUse 里的重复记账):
// 那条路只有"请求区间"可记,会把这里记好的实际区间又并回 1-2000(截断读被污染),且每次读写两遍 store。
async function recordRead($: any, e: any, r?: any): Promise<void> {
  const path = filePathOf(e)
  if (path === undefined || pagesOf(e) !== undefined) return // 分页读不记账(见 pagesOf)
  const st = await fileStat($, path)
  if (!st) return
  const key = st.key
  const ctx = ctxKey(e, await sessionId($, e))
  const state = await readState($)
  const sess = state[ctx] ?? {}
  const rec = sess[key]
  const range = actualRange(r) ?? wantedRange(e)
  const sameFile = rec && rec.v === 2 && rec.mtimeMs === st.mtimeMs && rec.size === st.size
  const ranges = sameFile ? mergeRanges(rec.ranges ?? [], range) : [range]
  if (!sess[key]) {
    const paths = Object.keys(sess).filter((k) => !k.startsWith('_'))
    if (paths.length >= MAX_FILES_PER_SESSION) delete sess[paths[0] as string]
  }
  sess[key] = { mtimeMs: st.mtimeMs, size: st.size, ranges, v: 2, at: Date.now() }
  sess._at = Date.now()
  state[ctx] = sess
  pruneState(state)
  await writeState($, state)
}

// ---------- 压缩点作废(2026-10-11 新增,修「/compact 之后误拦」)----------
// harness 压缩时会把旧工具输出清出上下文(README 的 Cache safety 一节自己写着这条),
// 而 guard-state 里的已读区间正是"内容还在上下文里"的断言 ⇒ 跨过压缩点即失效。
// 不作废的后果:重读被拦,而拦截文案谎称「已在上下文中」——
// 插件自己还在 ctx ≥ 50% 时劝用户 /compact,等于自造误伤。
// 只清**文件记录**(非 `_` 前缀键),保留 _epoch/_forcedEpoch/_codingAt/_proAt/_proEpoch/_model 等回合态:
// 连回合态一起清,会让硬升档闸在同一回合里再白拦一次。
function clearReadRecords(bucket: any): void {
  if (!bucket || typeof bucket !== 'object') return
  for (const k of Object.keys(bucket)) if (!k.startsWith('_')) delete bucket[k]
  bucket._at = Date.now()
}
async function compactReset($: any, e: any): Promise<void> {
  // ⚠ trigger='precompute' 是**唯一不落地**的那种(类型原话 "the one dispatch that installs
  // nothing: its result is kept for the next compaction"):上下文没变 ⇒ 记录仍然有效,
  // 清掉只会白白废掉去重,而 precompute 可能跑得不稀。
  if (e?.trigger === 'precompute') return
  const session = await sessionId($, e)
  const state = await readState($)
  const doomed: string[] = []
  if ((e?.agent_id ?? e?.agentId) !== undefined) {
    doomed.push(ctxKey(e, session)) // 子 agent 自己的转写被压缩:只作废它那一桶
  } else {
    doomed.push(session) // 主上下文压缩:同会话的子 agent 桶一并作废(它们多已结束)
    for (const k of Object.keys(state)) if (k.startsWith(`${session}::agent:`)) doomed.push(k)
  }
  let touched = false
  for (const k of doomed) {
    if (state[k]) { clearReadRecords(state[k]); touched = true }
    if (state._strikes?.[k]) { delete state._strikes[k]; touched = true }
  }
  if (touched) await writeState($, state)
}

// 回合边界(2026-10-11 重做,取代原来的"回合序号"):
// ⚠ 原实现拿 UserPromptSubmit 自增的 `_turn` 当"本回合"的标识。2026-10-11 实测证明它不可靠 ——
// **同一回合内会再次触发 UserPromptSubmit**:子 agent 的 hand-back 以 user 角色消息注入,
// markTurn 把 `_turn` 4→5,`_proTurn === _turn` 的放行判据当场失效 ⇒ 模型刚调过强档技能,
// 本回合首次改代码**仍被白拦一次**(0.2.6 号称修好的那个 wart,现场复现)。
// ⇒ 边界只由**引擎自己的回合结束**定义:`_epoch` 在 turn.complete 自增。
//   markSkillUpgrade 记 `_proEpoch = 当时 _epoch`;闸记 `_forcedEpoch = 当时 _epoch`
//   ⇒ `_proEpoch === _epoch` = 本回合已升过档(放行);`_forcedEpoch === _epoch` = 本回合已强制过。
// 用**计数**而非时间戳:计数没有"同毫秒相撞"的边界情形(turn.complete 与 deny 同毫秒在测试里必然发生),
// 且 `_epoch` 只在回合末变化 ⇒ 回合中途插进来几条 user 消息都不影响。
// ⚠ `_epoch` 的自增**写在 register.tsx**:那里才是 turn.complete 的注册方(tokenGuard 同事件不能再注册一次),
//   而且插件验证器禁止把 $ 跨 import 传(`$ is followed only into a function declared in this same file`)
//   ⇒ 没法在本文件代劳。本文件只**读** `_epoch`(codingToolGate)。
// 改动类工具:①落 coding 时间戳(升档粘性窗口) ②硬升档闸 —— 当前在基础档且配了升级技能时,
// 拦一次"**主线程**对本回合代码的首次改动",要它先激活技能再重试;该回合余下推理就走强档。
// 子 agent 的改动只落时间戳、不拦(它切不动档,拦了只会白丢一轮,见 codingToolGate 里的 fromAgent)。
// 判据是模型自己的动作(它决定改代码=这轮是 coding),不是猜用户文本;决定仍由插件做出。
// 档位取 $.session.model():它是**会话基础档**(技能的回合级切档它看不见),所以只用它判断
// "用户是不是本来就常驻强档"。**每回合最多强制一次**与**本回合已升档就放行**都按**回合边界序号**
// `_epoch` 比对(`_epoch` 只由 turn.complete 自增,见 noteTurnEnd)——
// ⚠ 不能拿 UserPromptSubmit 自增的计数器当回合标识:同一回合内会**再次触发**它(2026-10-11 实测:
// 子 agent 的 hand-back 以 user 角色消息注入,`_turn` 被顶高),判据当场失效 ——
// 模型刚调过强档技能,首次改代码仍被白拦一次。没配技能名时完全不拦(没技能可调,拦下来只会卡住模型)。
async function codingToolGate($: any, e: any): Promise<string | null> {
  const session = await sessionId($, e)
  const state = await readState($)
  const sess = state[session] ?? {}
  // 只认**代码文件**:改 README/.json 不该算"近期改过代码"(2026-10-10 修 —— 这个时间戳曾经无条件写,
  // 于是写文档也会让粘性窗口连续 stickyMin 分钟把纯文档轮判成 coding 流,实测把不该升档的轮也推上强档)
  const isCode = isCodePath(filePathOf(e))
  if (isCode) sess._codingAt = Date.now()
  sess._at = Date.now()
  state[session] = sess
  let deny: string | null = null
  const cfg = await loadConfig($)
  const skill = effectiveSkill(cfg)
  if (skill) {
    let live: unknown = null
    try { live = await $.session.model() } catch { /* 取不到当未知 */ }
    // 「本回合」= `_epoch`(只由 turn.complete 自增,见 noteTurnEnd)
    const epoch = sess._epoch ?? 0
    // 本回合是否已经处于强档:①会话基础档就是 Pro;②**本回合已经调用过强档技能**(PostToolUse(Skill)
    // 落的 _proEpoch,见 markSkillUpgrade)。`$.session.model()` 读的是**会话基础档**,技能切档它看不见。
    const alreadyPro = isProModel(cfg, live) || (sess._proEpoch ?? -1) === epoch
    // ⚠ 2026-10-11 修(发布前复核抓出):**子 agent 的改动一律不拦**。
    // 子 agent 跑的是子代理模型(本机 CLAUDE_CODE_SUBAGENT_MODEL=flash),而技能 `model:` 头切的是
    // **会话那一轮**的模型 —— 已经在跑的那一轮子 agent 切不动 ⇒ 拦下来的建议(先调 Skill)它执行不了,
    // 纯白丢一轮。更实质的后果:那次误拦把 `_forcedEpoch` 写成当前 epoch(记在**主会话桶**),
    // 于是主线程本回合**自己**第一次改代码反而不拦了 —— 一次不该发生的拦截换掉了一次该发生的。
    // 子 agent 的改动照旧落 _codingAt(粘性窗口口径不变,见上面那行)。
    const fromAgent = !!(e?.agent_id ?? e?.agentId)
    // 只拦代码文件(改文档不拦);档位未知时不拦:拦了却给不出可行的下一步,比不拦更糟(fail-open)
    if (
      !fromAgent &&
      (sess._forcedEpoch ?? -1) !== epoch &&
      isCode &&
      typeof live === 'string' && live !== '' && !alreadyPro
    ) {
      sess._forcedEpoch = epoch
      deny =
        `[cc-token-optimizer] 本回合首次改动代码,而本会话档位是基础档:请先调用 Skill 工具(${skill}) ` +
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
// UserPromptSubmit:机械检测 → 驱动回合级升档。只给模型发**静默**指令,不给用户发预测式提示(见 proNotice)
async function upgradeHeuristic($: any, e: any, cfg: Cfg): Promise<string | null> {
  const prompt = e.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') return null
  const session = await sessionId($, e)
  const state = await readState($)
  const up = cfg.upgrade
  const kwHit = keywordHit(prompt, up.keywords ?? [])
  const codingFlow = Date.now() - (state[session]?._codingAt ?? 0) < (up.stickyMin ?? STICKY_DEFAULT_MIN) * 60_000
  // 长度不再单独触发(2026-10-09):阈值 120 字符时粘贴网页/日志必然命中,而"长"与"复杂任务"无关,
  // 误报的代价是用户白升 Pro —— 省钱插件让人多花钱是最糟的方向。只认关键词命中与粘性窗口。
  if (!kwHit && !codingFlow) return null
  // 给模型的指令:条件式、每轮都给、不带冷却(档位判定交给模型读自己每轮的系统提示,不按 state 拦)
  const skill = effectiveSkill(cfg)
  return (
    `[cc-token-optimizer] 本条命中${kwHit ? ' coding 信号' : ' coding 流(近期有代码改动)'}:` +
    (skill
      ? `若你当前不在 Pro 档,动手前先调用 Skill 工具(${skill})让本回合以 Pro 档执行(回合级、自动回落;改一行/加注释这类小事可不调用);已在 Pro 档则忽略本条。`
      : `若你当前不在 Pro 档,动手前建议用户 /model ${cfg.models.pro} 升档再动手(改一行/加注释这类小事可不升);已在 Pro 档则忽略本条。`)
  )
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
// 给用户的提示走 $.ui.toast(原版是 settings hook 的 systemMessage/console.log)。
// ⚠ 2026-10-10 复核过类型:classic 结果里 **没有** systemMessage(ClassicResultFields.PostToolUse 只有
// additionalContext/updatedToolOutput/updatedMCPToolOutput,而 additionalContext 只给模型看)
// ⇒ 用户可见的提示只能走 $.ui.toast(引擎文档:插件 toast 栈浮在 transcript **右上角**,与用户看到的旧提示同位置)。
async function toast($: any, text: string | undefined): Promise<void> {
  if (!text) return
  try { await $.ui.toast(text) } catch { /* fail-open */ }
}

// 强档技能被调用 ⇒ 本回合确实升档(判据见 resolvedSkillModel 上方)。写进**会话桶**
// (与 codingToolGate 同一个桶,`_epoch` 也在那里):
//   _proAt       升档时刻 —— 账本(register.tsx 的 guardProHit)用**时间窗**做归属判据
//   _proEpoch    升档当时的 `_epoch` —— 硬升档闸据此放行(见 codingToolGate);`_epoch` 只由
//                turn.complete 自增 ⇒ 同一回合内插进来几条 user 消息都不影响归谁
//   _proNoticeAt 上次提醒时刻 —— 冷却**只压提醒、不压记账**,否则冷却窗内的第二个 Pro 回合会漏账
// 提醒**当场发**(用户 2026-10-10 选定):那一刻起这段回答就是 Pro 价,不必等回合结束(回合末=钱已花完)。
// 实测(2026-10-11,本机直连 DeepSeek):`tool_response` 形状 = {success, commandName, allowedTools, model},
// `model` 字段在位 ⇒ 结构化路径生效,不走"按技能名退化判定"那条(该路径仅作兜底)。
async function markSkillUpgrade($: any, e: any): Promise<void> {
  const raw = e?.tool_response
  const o = skillResultObject(raw)
  const agent = e?.agent_id ?? e?.agentId
  // fork 出去的技能:结果里没有 model,只有 status:'forked' + agentId —— 干活的是子 agent,
  // **主循环档位没变**,故既不标记也不提醒(否则会把仍是基础档的主回合记成 Pro)。
  const forked = o !== null && (o.status === 'forked' || o.agentId != null)
  const resolved = resolvedSkillModel(o ?? raw)
  const named = normalizeSkillName(o?.commandName ?? skillNameOf(e))
  const cfg = await loadConfig($)
  let live = ''
  try { live = String((await $.session.model()) ?? '') } catch { /* 取不到 ⇒ 当基础档 */ }
  const session = await sessionId($, e)
  const state = await readState($)
  const sess = state[session] ?? {}
  const now = Date.now()
  let notify = false
  if (!agent && !forked) {
    // 引擎报了解析模型就以它为准("生效时才有,omitted otherwise" ⇒ 报了就是真的);没报才退化为按技能名判定
    const pro = resolved !== null
      ? isProModel(cfg, resolved)
      : named !== '' && named === normalizeSkillName(effectiveSkill(cfg))
    if (pro) {
      sess._proAt = now // 账本的归属判据(register.tsx guardProHit 的**时间窗**)
      sess._proEpoch = sess._epoch ?? 0 // 闸的放行判据(见 codingToolGate);_epoch 只在回合末变
      // 会话本来就常驻 Pro ⇒ 没有"升"发生(读实时档位,与硬升档闸同源)
      const cooling = now - (sess._proNoticeAt ?? 0) < (cfg.upgrade.cooldownMin ?? 10) * 60_000
      const sessionPro = isProModel(cfg, live)
      if (!cooling && !sessionPro) {
        sess._proNoticeAt = now
        notify = true
      }
    }
  }
  sess._at = now
  state[session] = sess
  await writeState($, state)
  if (!notify) return
  const how = resolved !== null
    ? `引擎报 ${resolved};会话档位 ${live || '未知'}`
    : `引擎未报解析模型,按技能名判定(${named});会话档位 ${live || '未知'}`
  await toast(
    $,
    `[cc-token-optimizer] 本回合已升到 Pro 档(${how})。` +
      `输出 ${cfg.currency}${cfg.pricing.pro.idle.out}/M,下一轮自动回落;` +
      `想让整段会话都用 Pro 就 /model ${cfg.models.pro}。`
  )
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

  // 压缩点:该 loop 的旧工具输出已被清出上下文 ⇒ 读记录作废(否则重读被误拦,见 compactReset)。
  on('session.compact', async ($, e, next) => {
    try {
      await compactReset($, e)
    } catch { /* fail-open:压缩照常进行 */ }
    return next(e) // 必须显式 next:compact 的结果里 `{skip}` 会取消压缩,不能让它落空
  }).catch(($, e, next) => (next.called ? next(e) : undefined))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      const cfg = await loadConfig($)
      const out = await upgradeHeuristic($, e, cfg)
      if (out) return { additionalContext: [out] }
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
      await recordRead($, e, r) // r 带**实际**读到的 startLine/numLines(见 actualRange)
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

  // PostToolUse:Bash/PowerShell 裁剪输出;Skill 记升档事实。
  // ⚠ Read 的记账**只**在 tool.call 包装里做(2026-10-11 删掉这里的重复记账):此处拿不到实际区间,
  // 会把那边记好的实际区间又并回"请求区间"(截断读被污染成 1-2000),而且每次 Read 写两遍 store。
  on('classic.PostToolUse', async ($, e, next) => {
    try {
      const tool = toolNameOf(e)
      if (tool === 'Bash' || tool === 'PowerShell') {
        const out = await trimOutput($, e)
        if (out) return out
      } else if (tool === 'Skill') {
        // 升档事实 + 当场提醒(见 markSkillUpgrade);不改工具结果,继续走 next
        await markSkillUpgrade($, e)
      }
    } catch { /* fail-open */ }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : undefined))
}

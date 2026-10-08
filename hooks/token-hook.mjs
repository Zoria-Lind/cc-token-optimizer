#!/usr/bin/env node
// cc-token-optimizer — settings-hook 层(零依赖,stdin JSON → stdout JSON)
// 模块:
//   readDedup     PreToolUse Read   — 文件未变且区间已读 → deny(出生点去重,缓存安全)
//   recordRead    PostToolUse Read  — 记录 mtime/size + 已读区间
//   outputTrim    PostToolUse Bash/PowerShell — 裁剪/折叠前原输出存档(不读),再重复行折叠 + 超长输出头尾采样
//   stats         PostToolUse Bash/PowerShell — 拦截/裁剪/折叠计数记入 state.json 的 _stats
//   coldStartGuard SessionStart     — resume 且缓存已过期 → 注入一行提醒
//   modelDirector SessionStart/UserPromptSubmit/PreModelSwitch/PostModelSwitch —
//                    档位"导演"(混合双保险:模型自评纪律 + 启发式兜底 + 切换成本透明)。
//                    主力常驻档由 config.json 的 defaultTier 定:cheap(当前)=启动恒 Flash,需要时用户
//                    手动 /model 升 Pro、下次启动自动回 Flash;pro=主力常驻 Pro、跑腿活派 subagent。
//                    自指坑(cheap 模式必读):升级触发器必须在人——若交给模型自评,便宜档不知道自己
//                    便宜在哪,会漏升级、做砸了也报告不出来(2026-10-07 实测踩过)。
// 铁律:任何异常静默放行(fail-open),绝不阻断工具。

import { readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, unlinkSync, rmdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 状态/存档目录:跟随 CLAUDE_CONFIG_DIR(与 CC 配置同处,不再往 C 盘 home 写);未设时回退旧位置
const STATE_DIR = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'token-optimizer')
const STATE_FILE = join(STATE_DIR, 'state.json')
const TRIM_MIN = 5000 // 输出超过该字符数才裁剪(先折叠重复行,按折叠后长度判断)
const REPEAT_RUN = 3 // 连续相同行 ≥该值才折叠(纯空白行不折叠,避免破坏 diff/代码排版)
const HEAD = 1500 // 成功输出:保留头部字符数
const TAIL = 1500 // 成功输出:保留尾部字符数
const ERR_HEAD = 800 // 错误输出:保留头部字符数
const ERR_TAIL = 800 // 错误输出:保留尾部字符数
const MAX_DENIES = 3 // readDedup 逃生:同文件连续拦截超过该次数放行(DSH 同款防死锁)
const SESSION_KEEP = 5 // 状态文件只保留最近 N 个会话
const MAX_FILES_PER_SESSION = 200 // 单会话记录文件数上限(超出丢最旧)
const AGENT_KEEP = 8 // 每会话的子 agent 读去重桶上限(_at LRU 保留最近 N 个)
const CODING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] // 改动类工具:PreToolUse 只用于给升级提醒落 coding 流时间戳
const STICKY_DEFAULT_MIN = 30 // 升档粘性窗口默认值(分钟):改过代码后的续接轮都提醒升档

// ---- 配置:优先读 ../plugin/config.json(可分发:用户自填价目/模型名/升级规则),失败回退内置默认 ----
const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'config.json')
const DEFAULT_CONFIG = {
  defaultTier: 'pro', // 主力常驻档:pro=主会话跑 Pro、跑腿活派 subagent;cheap=便宜主力 + 复杂任务临时升 Pro
  pricing: {
    cheap: { idle: { hit: 0.02, miss: 1, out: 4 }, peak: { hit: 0.04, miss: 2, out: 8 } },
    pro: { idle: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9, out: 27 } },
  },
  holidays: ['2026-01-01', '2026-05-01', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
  models: { cheap: 'deepseek-v4-flash', pro: 'deepseek-v4-pro[1m]' },
  upgrade: { minPromptChars: 120, keywords: ['设计', '架构', '重构', '方案', '决策', '算法', 'design', 'architecture', 'refactor', 'plan'], cooldownMin: 10 },
}
function loadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    return {
      ...DEFAULT_CONFIG,
      ...cfg,
      pricing: { ...DEFAULT_CONFIG.pricing, ...cfg?.pricing },
      models: { ...DEFAULT_CONFIG.models, ...cfg?.models },
      upgrade: { ...DEFAULT_CONFIG.upgrade, ...cfg?.upgrade },
    }
  } catch { return DEFAULT_CONFIG }
}
const CFG = loadConfig()
const isProModel = (m) => !!m && (m === CFG.models.pro || (String(m).includes('pro') && !String(m).includes('flash')))
// 档位纪律的口径随主力档位走(全部策略文本集中在此,改 defaultTier 即整体换向)
const isProDefault = CFG.defaultTier !== 'cheap'
const stayAdvice = isProDefault
  ? '跑腿活(搜索/批量读取/机械改动)派 subagent,它们走基础档;主会话不必为省钱降档。'
  : `任务完成后记得切回基础档:/model ${CFG.models.cheap}。`
const upAdvice = isProDefault
  ? `判断力吃紧(设计/架构/复杂调试)就切回主力:/model ${CFG.models.pro}。`
  : `涉及 coding(写/改代码、调试、重构、脚本、报错)时,先调用 Skill 工具(coding-pro) 让本回合跑 Pro 档(回合级、自动回落),再动手;其他复杂任务可在动手前建议用户 /model ${CFG.models.pro}。`

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  const tmp = `${STATE_FILE}.tmp-${process.pid}`
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(tmp, JSON.stringify(s)) // 原子替换:防并发读到写一半的 JSON(读失败会把全量状态归零)
    renameSync(tmp, STATE_FILE)
  } catch { try { unlinkSync(tmp) } catch { /* 状态写失败不致命 */ } }
}
// ---- 状态文件跨进程锁(2026-10-08):多会话/多 hook 进程并发 read-modify-write 会互相覆盖丢更新 ----
// mkdir 原子性做锁;建锁失败/等锁超时一律照常干活(fail-open,锁绝不成为故障点);崩溃遗留的陈旧锁按 mtime 强抢。
const LOCK_DIR = `${STATE_FILE}.lock`
const LOCK_WAIT_MS = 800
const LOCK_STALE_MS = 2000
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { } }
function withStateLock(fn) {
  let held = false
  try { mkdirSync(STATE_DIR, { recursive: true }) } catch { }
  const start = Date.now()
  for (;;) {
    try { mkdirSync(LOCK_DIR); held = true; break } catch (err) {
      if (err?.code !== 'EEXIST') break
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > LOCK_STALE_MS) { rmdirSync(LOCK_DIR); continue }
      } catch { }
      if (Date.now() - start > LOCK_WAIT_MS) break
      sleepMs(25)
    }
  }
  try { return fn() } finally { if (held) { try { rmdirSync(LOCK_DIR) } catch { } } }
}
// 读去重的上下文键:子 agent 上下文独立于父会话(2026-10-08 实测:两者共用 session_id/transcript_path,
// 载荷里只有 agent_id 可区分)—— 各自成桶,互不顶替,防"内容不在却报已在"的静默致盲。
function ctxKey(e) {
  const s = e.session_id ?? 'default'
  return e.agent_id ? `${s}::agent:${e.agent_id}` : s
}
// 会话级统计条目:拦截/裁剪/折叠计数(供 /token-status 或人工查 state.json)
function statEntry(state, session) {
  state._stats = state._stats ?? {}
  return state._stats[session] ??= { denies: 0, trims: 0, trimmedChars: 0, collapsedLines: 0 }
}
// ---- 裁剪前存档:原版未裁剪输出落盘(模型只看到路径,内容不注入上下文) ----
const ARCHIVE_KEEP = 20 // 每会话最多保留份数,超出删最旧
function archiveRoot(session) {
  return join(STATE_DIR, 'archive', String(session).replace(/[^\w-]/g, '') || 'default')
}
function archiveOriginal(session, tool, raw) {
  try {
    const dir = archiveRoot(session)
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir).sort()
    while (files.length >= ARCHIVE_KEEP) unlinkSync(join(dir, files.shift()))
    const path = join(dir, `${Date.now()}-${String(tool).replace(/[^\w-]/g, '') || 'tool'}.txt`)
    writeFileSync(path, raw)
    return path
  } catch { return null }
}
function fileStat(p) {
  try {
    const st = statSync(p)
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null
  } catch { return null }
}
function mergeRanges(ranges, add) {
  const all = [...ranges, add].sort((a, b) => a[0] - b[0])
  const out = []
  for (const r of all) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}
function wantedRange(input) {
  const offset = typeof input.offset === 'number' ? input.offset : 1
  const limit = typeof input.limit === 'number' ? input.limit : 2000
  return [offset, offset + limit - 1]
}

// ---- readDedup:文件未变且区间已覆盖 → deny ----
// ⚠ 记录按 ctxKey 分桶(主会话 / 各子 agent 独立);只信任 v===2 格式的记录 —— 修复前被跨上下文
//    污染写入的旧记录无 v 标记,自动失效(最坏多读一次,方向是 fail-open)。
function readDedup(e, out) {
  const path = e.tool_input?.file_path
  if (typeof path !== 'string' || e.tool_input?.pages !== undefined) return
  const abs = resolve(path)
  const st = fileStat(abs)
  if (!st) return
  const ctx = ctxKey(e)
  const session = e.session_id ?? 'default'
  const want = wantedRange(e.tool_input)
  withStateLock(() => {
    const state = loadState()
    const rec = state[ctx]?.[abs]
    const strikes = state._strikes?.[ctx]?.[abs] ?? 0
    const unchanged = rec && rec.v === 2 && rec.mtimeMs === st.mtimeMs && rec.size === st.size
    if (unchanged && rec.ranges) {
      const covered = rec.ranges.some(([s, t]) => s <= want[0] && t >= want[1])
      if (covered && strikes < MAX_DENIES) {
        state._strikes = state._strikes ?? {}
        state._strikes[ctx] = state._strikes[ctx] ?? {}
        state._strikes[ctx][abs] = strikes + 1
        if (state[ctx]) state[ctx]._at = Date.now()
        statEntry(state, session).denies += 1
        saveState(state)
        out.hookSpecificOutput = {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `[cc-token-optimizer] ${path} 自上次读取后未变化,区间 ${want[0]}-${want[1]} 已在上下文中,无需重读。` +
            `连续 ${MAX_DENIES} 次拦截将自动放行;强制重读可修改文件或删除状态文件中该条目。`,
        }
        return
      }
    }
    if (strikes > 0) {
      state._strikes[ctx][abs] = 0 // 放行则清连续拦截计数
      if (state[ctx]) state[ctx]._at = Date.now()
      saveState(state)
    }
  })
}

// ---- recordRead:成功读后记录(按上下文键 ctxKey 分桶:主会话 / 各子 agent 各一桶) ----
function pruneState(state) {
  // 按活跃时间(_at)LRU 淘汰:主会话留最近 SESSION_KEEP 个;子 agent 桶随父会话淘汰 + 每会话限
  // AGENT_KEEP 个(_at LRU);被淘汰键的 _strikes 一并清(_stats 是用户数据,不清)。
  // 用 _at 而非插入序:长期挂着的活跃主会话不该被一堆短命会话挤掉。
  const keys = Object.keys(state).filter((k) => k !== '_strikes' && k !== '_stats')
  const mains = keys.filter((k) => !k.includes('::agent:'))
  const byAge = [...mains].sort((a, b) => (state[b]?._at ?? 0) - (state[a]?._at ?? 0))
  const dropped = new Set(byAge.slice(SESSION_KEEP))
  for (const m of dropped) delete state[m]
  const byMain = {}
  for (const k of keys) {
    if (!state[k]) continue
    if (k.includes('::agent:')) {
      const m = k.slice(0, k.indexOf('::agent:'))
      if (dropped.has(m)) { delete state[k]; continue }
      ;(byMain[m] ??= []).push(k)
    }
  }
  for (const m of Object.keys(byMain)) {
    const list = byMain[m].sort((a, b) => (state[b]?._at ?? 0) - (state[a]?._at ?? 0))
    for (const k of list.slice(AGENT_KEEP)) delete state[k]
  }
  if (state._strikes) for (const k of Object.keys(state._strikes)) if (!state[k]) delete state._strikes[k]
}
function recordRead(e) {
  const path = e.tool_input?.file_path
  if (typeof path !== 'string') return
  const abs = resolve(path)
  const st = fileStat(abs)
  if (!st) return
  const ctx = ctxKey(e)
  withStateLock(() => {
    const state = loadState()
    const sess = state[ctx] ?? {}
    const rec = sess[abs]
    const range = wantedRange(e.tool_input)
    const sameFile = rec && rec.v === 2 && rec.mtimeMs === st.mtimeMs && rec.size === st.size // 只并 v2 区间:旧记录可能带跨上下文污染区间,并进来等于洗白
    const ranges = sameFile ? mergeRanges(rec.ranges ?? [], range) : [range]
    if (!sess[abs]) {
      const paths = Object.keys(sess).filter((k) => !k.startsWith('_')) // _model/_at 等元字段不算文件记录
      if (paths.length >= MAX_FILES_PER_SESSION) delete sess[paths[0]]
    }
    sess[abs] = { mtimeMs: st.mtimeMs, size: st.size, ranges, v: 2, at: Date.now() }
    sess._at = Date.now()
    state[ctx] = sess
    pruneState(state) // 先落 _at 再修剪:活跃桶不会被自己剪掉
    saveState(state)
  })
}

// ---- markCodingActivity:改动类工具(Edit/Write/MultiEdit/NotebookEdit)的 PreToolUse ----
// 只落一个"最近改过代码"时间戳,供升级提醒的粘性窗口用;不产出任何输出。
// (2026-10-08:回合级升档会自动回落,靠当轮文本猜"是否在 coding 流"漏短句续接——改过代码是更硬的信号)
function markCodingActivity(e) {
  const session = e.session_id ?? 'default' // 记父会话:子 agent 的改动也算这条 coding 流
  withStateLock(() => {
    const state = loadState()
    const sess = state[session] ?? {}
    sess._codingAt = Date.now()
    sess._at = Date.now()
    state[session] = sess
    saveState(state)
  })
}

// ---- outputTrim:重复行折叠 + 超长输出头尾采样 ----
function collapseRepeats(text) {
  const lines = text.split('\n')
  const out = []
  let collapsed = 0
  for (let i = 0; i < lines.length; ) {
    let j = i
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++
    const run = j - i + 1
    if (run >= REPEAT_RUN && lines[i].trim() !== '') {
      out.push(lines[i])
      out.push(`[cc-token-optimizer: 后续 ${run - 1} 行与此行完全相同,已折叠]`)
      collapsed += run - 1
    } else {
      out.push(...lines.slice(i, j + 1))
    }
    i = j + 1
  }
  return { text: out.join('\n'), collapsed }
}
function trimAndCollapse(text, isErr) {
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
function trimOutput(e, out) {
  const resp = e.tool_response
  if (resp == null) return
  const session = e.session_id ?? 'default'
  let collapsed = 0
  let trimmedChars = 0
  if (typeof resp === 'string') {
    const isFail = /\[exit[^\]]*code[^\]]*[:：]\s*[1-9]/.test(String(resp))
    const r = trimAndCollapse(resp, isFail)
    if (!r) return
    collapsed += r.collapsed
    trimmedChars += r.trimmedChars
    const archived = archiveOriginal(session, e.tool_name, resp)
    out.hookSpecificOutput = {
      hookEventName: 'PostToolUse',
      updatedToolOutput: archived
        ? r.text + `\n[cc-token-optimizer: 完整原输出已存档(未注入上下文):${archived}]`
        : r.text,
    }
  } else if (typeof resp === 'object' && resp !== null) {
    const o = { ...resp }
    const touched = []
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
    if (touched.length) {
      const archived = archiveOriginal(session, e.tool_name, JSON.stringify(resp))
      o[touched[0]] += archived ? `\n[cc-token-optimizer: 完整原输出已存档(未注入上下文):${archived}]` : ''
      out.hookSpecificOutput = { hookEventName: 'PostToolUse', updatedToolOutput: o }
    }
  }
  if (collapsed > 0 || trimmedChars > 0) {
    withStateLock(() => {
      const state = loadState()
      const s = statEntry(state, session)
      if (trimmedChars > 0) { s.trims += 1; s.trimmedChars += trimmedChars }
      if (collapsed > 0) s.collapsedLines += collapsed
      saveState(state)
    })
  }
}

// ---- coldStartGuard:resume 且缓存过期 → stdout 注入提醒 ----
function coldStartGuard(e) {
  if (!e.prompt_cache_likely_expired) return
  const ctx = typeof e.context_tokens === 'number' ? Math.round(e.context_tokens / 1000) : null
  const usd = e.estimated_cache_write_usd
  console.log(
    `[cc-token-optimizer] 会话恢复,但提示缓存已过期` +
    (ctx !== null ? `:上下文约 ${ctx}k token` : '') +
    (usd !== undefined ? `,重新缓存预计约 $${usd}` : '') +
    `。若本会话任务已结束,建议 /clear 开新会话,可免去整段历史的全价重读。`,
  )
}

// ---- modelDirector:Flash 主力 + 复杂任务升 Pro(混合双保险,质量优先) ----
function sessionModel(state, session) {
  return state[session]?._model ?? null
}
function setSessionModel(session, model) {
  withStateLock(() => {
    const state = loadState()
    const sess = state[session] ?? {}
    sess._model = model
    sess._at = Date.now()
    state[session] = sess
    saveState(state)
  })
}
// SessionStart:记录当前模型 + 注入档位纪律(模型自评是主判定:拿不准就建议升级)
function modelPolicy(e) {
  const model = e.model
  if (typeof model !== 'string' || model === '') return
  setSessionModel(e.session_id ?? 'default', model)
  if (isProModel(model)) {
    console.log(`[cc-token-optimizer] 当前 Pro 档(输出 ${CFG.pricing.pro.idle.out} 元/M)。` + stayAdvice)
  } else {
    console.log(`[cc-token-optimizer] 当前基础档(输出 ${CFG.pricing.cheap.idle.out} 元/M)。` + upAdvice)
  }
}
// UserPromptSubmit:机械检测 → 驱动"回合级升档"(Skill(coding-pro) 的 model: 头,
// 本回合跑 Pro、下一轮自动回 Flash)。检测不依赖模型自评 —— 这是自指坑的解法。
function upgradeHeuristic(e, out) {
  const prompt = e.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') return
  const session = e.session_id ?? 'default'
  const state = loadState()
  const model = sessionModel(state, session)
  const up = CFG.upgrade
  const lenOk = prompt.length >= (up.minPromptChars ?? 120)
  const kwHit = (up.keywords ?? []).some((k) => prompt.toLowerCase().includes(String(k).toLowerCase()))
  // 粘性窗口:近期改过代码(Edit/Write 的 PreToolUse 落了 _codingAt)→ 不管当轮文本长短都提醒,
  // 覆盖"继续/修吧"这类短句续接(2026-10-08 实测漏档)
  const codingFlow = Date.now() - (state[session]?._codingAt ?? 0) < (up.stickyMin ?? STICKY_DEFAULT_MIN) * 60_000
  if (!lenOk && !kwHit && !codingFlow) return
  // 给模型的指令:条件式、每轮都给、不带冷却。
  // 不按 state 记录的档位拦截 —— 回合级升档会自动回落,state 里的 _model 可能滞后一拍(还停在 pro),
  // 按它拦截会漏掉"回落后的第一条 coding"。档位判定交给模型读自己每轮的系统提示(事实性核对,非评估)。
  out.hookSpecificOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext:
      `[cc-token-optimizer] 本条命中${kwHit ? ' coding 信号' : lenOk ? '长提示' : ' coding 流(近期有代码改动)'}:若你当前不在 Pro 档,动手前先调用 Skill 工具(coding-pro)` +
      `让本回合以 Pro 档执行(回合级、自动回落;改一行/加注释这类小事可不调用);已在 Pro 档则忽略本条。`,
  }
  // 给用户的提示:只对关键词/长提示发(粘性窗口下的短句续接只提醒模型、不打扰用户),
  // 带冷却(同会话 10 分钟内只提示一次);记录档位已是 Pro 时不发(避免误导)
  const last = state[session]?._upgradeSugAt ?? 0
  if ((kwHit || lenOk) && !(model && isProModel(model)) && Date.now() - last >= (up.cooldownMin ?? 10) * 60_000) {
    withStateLock(() => {
      const s2 = loadState()
      const sess = s2[session] ?? {}
      sess._upgradeSugAt = Date.now()
      sess._at = Date.now()
      s2[session] = sess
      saveState(s2)
    })
    out.systemMessage =
      `[cc-token-optimizer] 本条判为${kwHit ? 'coding 任务' : '长任务'},本回合按 Pro 档执行(下一轮自动回 Flash)。` +
      `想让整段会话都用 Pro 就 /model ${CFG.models.pro};否则无需操作。`
  }
}
// PreModelSwitch:切换成本透明(丢缓存重写,按目标档位未命中价估)
function preModelSwitch(e) {
  const to = e.to_model
  const from = e.from_model
  if (typeof to !== 'string' || to === from) return
  const ctx = typeof e.context_tokens === 'number' ? Math.round(e.context_tokens / 1000) : null
  const tier = isProModel(to) ? 'pro' : 'cheap'
  const miss = CFG.pricing[tier].idle.miss
  const est = ctx !== null ? `,重缓存约 ¥${((ctx * 1000 * miss) / 1_000_000).toFixed(2)}(空闲价)` : ''
  console.log(
    `[cc-token-optimizer] 切换 ${from ?? '?'} → ${to} 将丢弃当前提示缓存` +
    (ctx !== null ? `:上下文约 ${ctx}k token` : '') + est +
    `。切换前可考虑先 /compact 或任务边界再切。`
  )
}
// PostModelSwitch:更新记录的模型 + 降档/升档提醒
function postModelSwitch(e) {
  const to = e.to_model
  if (typeof to !== 'string') return
  setSessionModel(e.session_id ?? 'default', to)
  if (isProModel(to)) {
    console.log(
      `[cc-token-optimizer] 已切 Pro 档(输出 ${CFG.pricing.pro.idle.out} 元/M,` +
      `${CFG.pricing.pro.idle.out / CFG.pricing.cheap.idle.out}x 基础档)。` + stayAdvice
    )
  } else {
    console.log(`[cc-token-optimizer] 已切基础档(输出 ${CFG.pricing.cheap.idle.out} 元/M)。` + upAdvice)
  }
}

// ---- 入口:按 hook_event_name 判定(缺失时退回载荷形态判定) ----
function main() {
  let e
  try { e = JSON.parse(readFileSync(0, 'utf8')) } catch { return }
  const out = {}
  try {
    const ev = typeof e.hook_event_name === 'string' ? e.hook_event_name : ''
    if (ev === 'SessionStart') { coldStartGuard(e); modelPolicy(e) }
    else if (ev === 'UserPromptSubmit') upgradeHeuristic(e, out)
    else if (ev === 'PreModelSwitch') preModelSwitch(e)
    else if (ev === 'PostModelSwitch') postModelSwitch(e)
    else if (ev === 'PreToolUse' && e.tool_name === 'Read') readDedup(e, out)
    else if (ev === 'PreToolUse' && CODING_TOOLS.includes(e.tool_name)) markCodingActivity(e)
    else if (ev === 'PostToolUse' && e.tool_name === 'Read') recordRead(e)
    else if (ev === 'PostToolUse' && (e.tool_name === 'Bash' || e.tool_name === 'PowerShell')) trimOutput(e, out)
    else { // 形态判定兜底(hook_event_name 缺失的环境)
      const isSessionStart = e.tool_name === undefined && e.tool_input === undefined
      const isPre = e.tool_name !== undefined && e.tool_response === undefined
      const isPost = e.tool_name !== undefined && e.tool_response !== undefined
      if (isPre && e.tool_name === 'Read') readDedup(e, out)
      else if (isPre && CODING_TOOLS.includes(e.tool_name)) markCodingActivity(e)
      else if (isPost && e.tool_name === 'Read') recordRead(e)
      else if (isPost && (e.tool_name === 'Bash' || e.tool_name === 'PowerShell')) trimOutput(e, out)
      else if (isSessionStart) coldStartGuard(e)
    }
  } catch { /* fail-open */ }
  if (Object.keys(out).length > 0) console.log(JSON.stringify(out))
}
main()

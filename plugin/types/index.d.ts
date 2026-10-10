// cc-token-optimizer 的 $.state 类型契约。
// 每项值都声明在 PluginState 下,claude plugin validate 按此核对模块里的 $.state 键。

/** 单次插件加载的刻度(诊断用):那一刻 + 当时累计轮数/无 usage 轮数。 */
export type LoadMark = { at: number; turns: number; noUsage: number }

/** 单会话用量账本:热重载不清零,按会话 startedAt 分格。 */
export type UsageTotals = {
  /** 会话标识($.session.usage().startedAt):变了就是新会话,开新格。 */
  startedAt: number | null
  /** 写入者加载时刻 —— 更晚的实例接管本格,旧实例不得覆盖新实例。 */
  loadAt: number
  /** 已计轮次(仅主会话、带 usage)。 */
  turns: number
  /** 主会话里 usage 缺失的轮次(中断/API 错误):诊断口径用,不计价。 */
  turnsNoUsage: number
  /** 子代理轮次:单独计数,不计价。 */
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
  /** 由 Pro 档作答的主会话轮次。 */
  proTurns: number
  /** 本会话首轮计数时刻(ms)。 */
  firstAt: number | null
  /** 最近一轮计数时刻(ms)。 */
  lastAt: number | null
  /** 诊断刻度:每次 register() 一行。 */
  loads: LoadMark[]
}

/** 账本:key = String(startedAt) —— 多窗口并发各记各的,互不覆盖。 */
export type UsageBook = Record<string, UsageTotals>

/**
 * 单个会话桶:动态键是文件绝对路径 → 读记录(tokenGuard 用),`_` 前缀是元字段。
 * 与旧 state.json 同构,但宿主管生命周期 ⇒ 无需文件锁/原子写/LRU。
 */
export type GuardBucket = {
  /** 最近活动时刻(修剪用)。 */
  _at?: number
  /** 最近改过代码的时刻(升档粘性窗口用)。 */
  _codingAt?: number
  /** 上次观测到的模型名(**会话基础档**;技能的回合级切档看不见)。 */
  _model?: string
  /** 回合边界计数(2026-10-11):**只由 turn.complete 自增**(register.tsx 代 hooks 层落笔)。
   *  硬升档闸按它判断"本回合是否已升过档 / 已强制过"。
   *  ⚠ 别拿 UserPromptSubmit 的计数当回合标识:同一回合内会**再次触发它**(实测:子 agent 的
   *  hand-back 以 user 角色消息注入),序号被顶高 ⇒ 已升档的回合仍被白拦一次(2026-10-11 现场复现)。 */
  _epoch?: number
  /** 升档时刻(2026-10-10):`classic.PostToolUse(Skill)` 从引擎报的解析模型确认"本回合走了强档"。
   *  账本(register.tsx guardProHit)按**时间窗**归属;闸看的是同一刻的 `_proEpoch`。 */
  _proAt?: number
  /** 升档时 `_epoch` 的值 ⇒ `_proEpoch === _epoch` 即"本回合已升过档"(闸据此放行)。 */
  _proEpoch?: number
  /** 上次向用户发升档提醒的时刻(冷却用;只压提醒,不压 `_proAt` 的记账)。 */
  _proNoticeAt?: number
  /** 硬升档闸上次强制发生的 `_epoch` ⇒ `=== _epoch` 即"本回合已强制过"(每回合最多拦一次)。 */
  _forcedEpoch?: number
} & Record<string, unknown>

/**
 * settings-hook 层六模块的持久状态:存宿主插件 KV 的 'guard-state' 键(`$.store`)。
 * ⚠ 不是 `$.state` —— 那是会话级内存(会话结束即失);跨会话的统计/已读记录/粘性窗口必须走 store。
 *   落点:`<配置目录>/plugins/store/cc-token-optimizer*.json`。
 */
export type GuardState = {
  /** 同文件连续拦截计数(逃生,防"内容不在却报已在"的死锁)。 */
  _strikes?: Record<string, Record<string, number>>
  /** 每会话的拦截/裁剪/折叠计数。 */
  _stats?: Record<string, { denies: number; trims: number; trimmedChars: number; collapsedLines: number }>
} & Record<string, GuardBucket | unknown>

declare module 'claude-code' {
  interface PluginState {
    'cc-token-optimizer': {
      // 只剩悬浮条账本;tokenGuard 的 guard-state 已改挂 $.store,不再经 PluginState
      'usage-totals': UsageBook
    }
  }
}

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
  /** 上次观测到的模型名。 */
  _model?: string
  /** 上次向用户发升档提醒的时刻(冷却用)。 */
  _upgradeSugAt?: number
  /** 本会话的回合序号(每次用户发言 +1);硬升档闸据此保证每回合最多强制一次。 */
  _turn?: number
  /** 上次"硬升档闸"强制发生在哪一回合(与 _turn 比对;相等=本回合已强制过)。 */
  _forcedTurn?: number
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

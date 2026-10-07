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

declare module 'claude-code' {
  interface PluginState {
    'cc-token-optimizer': {
      'usage-totals': UsageBook
    }
  }
}

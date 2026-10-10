// cc-token-optimizer(CC mods 层)引擎级测试。
// 插件 hook 只依赖 $.command.register / $.session.usage / $.ui.resolve,
// 其余沿链下到本文件的 bottom hooks(它们"代表引擎"):注册表 + 固定 usage 快照 +
// 各事件的最小合法结果形态(turn.complete 事件需带 answer;结果需带 text)。
// ui.resolve 不设 bottom:测试框架自带真实元素实现。
// 可观测面:聚合结果经 /token-status 命令输出断言;悬浮条断言"0 轮透传 / 有数据画树"。

import { test, expect } from 'claude-code/testing'
import { isPeakAt } from './register'

// CC 2.1.293:testing 侧把 $.command.run 收窄为 CommandRunInput(要求 origin/presentation
// 这两个只有引擎才设置的字段),而插件侧签名是 CommandRunArgs(只要 command,args 可选)。
// 插件代码本身没问题 —— 这里统一走 runCmd 绕开该不一致。
const runCmd = ($: any, command: string): Promise<{ text: string }> => $.command.run({ command })

const setup = (on: any) => {
  const registered: string[] = []
  on('command.register', (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { command: e.command } }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 50000, window: 200000, percent: 25 },
      rateLimits: [],
      cost: null,
    },
  }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'ok' }))
  // 事实式升档提醒的判据与出口:会话档位($.session.model —— 实测=会话基础档)+ 给用户的提示
  const toasts: string[] = []
  let sessionModel: string | null = 'deepseek-v4-flash'
  on('session.model', () => ({ value: sessionModel }))
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(typeof e === 'string' ? e : String(e?.text ?? ''))
    return { value: undefined }
  })
  // guard-state(hooks 层落的升档事实 `_proAt`;$.store 是**裸字符串键**,与 tokenGuard 同源)+ 真会话 id
  const guardStore = new Map<string, unknown>()
  on('store.get', (_$: any, e: any) => ({ value: guardStore.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    guardStore.set(e.key, e.value)
    return { value: undefined }
  })
  let sessionId = 'sess-A'
  on('session.id', () => ({ value: sessionId }))
  // 虚拟 state(账本持久化的落点):Map 实现;插件的 $.state.get/set 沿链下到这里
  // (与 behavior-enhancer 测试同款形状:get 回 { value, version },set 回 { isSet, version })
  const state = new Map<string, unknown>()
  let version = 0
  on('state.get', (_$: any, e: any) => ({ value: { value: state.get(`${e.plugin}:${e.key}`), version } }))
  on('state.set', (_$: any, e: any) => {
    if (typeof e.ifVersion === 'number' && e.ifVersion !== version) return { value: { isSet: false, version } }
    state.set(`${e.plugin}:${e.key}`, e.value)
    version += 1
    return { value: { isSet: true, version } }
  })
  return { registered, state, toasts, guardStore, setSessionId: (s: string) => { sessionId = s }, setModel: (m: string | null) => { sessionModel = m } }
}

const start = async ($: any) => {
  await $.session.start({ cwd: '/pkg', surface: 'terminal', isInteractive: true })
}
const turn = async ($: any, usage: any, agentId: string | undefined, durationMs?: number) => {
  await $.turn.complete({ answer: 'ok', usage, agentId, durationMs })
}

test('turn.complete 聚合主会话 usage,subagent 轮次不计入', async ($, on) => {
  const b = setup(on)
  await start($)
  await turn($, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, undefined)
  await turn($, { input_tokens: 0, output_tokens: 999, cache_read_input_tokens: 9900, cache_creation_input_tokens: 0 }, 'sub-1')
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/轮次: 1/)
  expect(out.text).toMatch(/输入 1k/)
  expect(out.text).toMatch(/缓存读 9k/)
  expect(out.text).toMatch(/输出 500/)
  expect(b.registered).toContain('token-status')
})

test('缓存命中率 = 缓存读 / 总输入(DeepSeek 语义:input 不含缓存读)', async ($, on) => {
  setup(on)
  await start($)
  // 100 + 400 + 500 = 1000 总输入,命中 400 → 40.0%
  await turn($, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 500 }, undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/命中率: 40\.0%/)
})

test('usage 字段缺失不崩溃(防御性聚合)', async ($, on) => {
  setup(on)
  await start($)
  await turn($, null, undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/轮次: 0/)
  expect(out.text).toMatch(/命中率: 暂无数据/)
})
test('B:账本跨热重载接续 —— 预置同会话账本 → 接着累加,不再从零', async ($, on) => {
  const b = setup(on)
  // 模拟"上一实例已经计了 2 轮"(startedAt 与 mock 的 session.usage 一致 = 0)
  b.state.set('cc-token-optimizer:usage-totals', {
    '0': {
      startedAt: 0, loadAt: 1, turns: 2, turnsNoUsage: 0, subagentTurns: 0,
      input: 500, output: 200, cacheRead: 5000, cacheCreation: 0,
      firstAt: 1, lastAt: 2, loads: [{ at: 1, turns: 0, noUsage: 0 }],
    },
  })
  await start($)
  await turn($, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/轮次: 3/) // 2(上一实例) + 1(本轮) —— 修复前这里会是 1
  expect(out.text).toMatch(/缓存读 14k/) // 5000 + 9000
  expect(out.text).toMatch(/register 加载 2 次\(热重载过 → 已续计,未丢轮次\)/)
})

test('B:账本属于别的会话(startedAt 不同)→ 开新账,不串数', async ($, on) => {
  const b = setup(on)
  b.state.set('cc-token-optimizer:usage-totals', {
    '999': {
      startedAt: 999, loadAt: 1, turns: 42, turnsNoUsage: 0, subagentTurns: 0,
      input: 1, output: 1, cacheRead: 1, cacheCreation: 0, firstAt: 1, lastAt: 2, loads: [],
    },
  })
  await start($)
  await turn($, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/轮次: 1/) // 不是 43
  expect(out.text).toMatch(/register 加载 1 次\(未重载\)/)
})

test('usage 缺失的轮次单独计数(诊断口径:区分"没收到事件"与"CC 没给 usage")', async ($, on) => {
  setup(on)
  await start($)
  await turn($, null, undefined)
  await turn($, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 }, undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/轮次: 1\(另有 usage 缺失 1 轮、子代理 0 轮,未计价\)/)
})

// —— 档位归属(2026-10-10 重做):直连 DeepSeek 时 `usage.model` 报的是**会话档位**
//    (实测:真跑在 Pro 上却报 0 轮;近 24h 共 548 条日志零条 pro)⇒ 判据换成 hooks 层落的机械事实
//    `_proAt`(Skill 工具结果里引擎报的解析模型,见 tokenGuard.ts 的 markSkillUpgrade);
//    `usage.model` 退为 OR 兜底(官方 Anthropic 等会如实报的宿主)。用户侧提醒已移到 hooks 层 —— 升档当场弹。
const proTurnUsage = (model: string) => ({
  model, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
})
// 预置 hooks 层落的升档标记(会话桶 'sess-A' 与 setup 里 $.session.id() 的默认值一致)
const proMark = (b: any, at: number) => b.guardStore.set('guard-state', { 'sess-A': { _proAt: at, _at: at } })

test('档位归属:usage.model 报基础档、但本回合有升档标记 → 记 Pro 轮(0.2.5 在这里恒记基础档)', async ($, on) => {
  const b = setup(on)
  await start($)
  proMark(b, Date.now())
  await turn($, proTurnUsage('deepseek-v4-flash'), undefined, 30000)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/Pro ¥[\d.]+\(1 轮\)/) // 100 输入 + 10 输出都归 Pro 桶(金额四舍五入后 ≈¥0.001)
  expect(out.text).not.toMatch(/本会话未升过档/)
})

test('档位归属:升档标记落在本回合时间窗之外 → 不记 Pro(Pro 之后的续接回合不被误记)', async ($, on) => {
  const b = setup(on)
  await start($)
  proMark(b, Date.now() - 60_000) // 一分钟前的升档:不属于本回合
  await turn($, proTurnUsage('deepseek-v4-flash'), undefined, 5_000) // 本回合只有 5 秒
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/档位构成: Pro ¥0\.000\(0 轮\)/)
})

test('档位归属:标记属于别的会话 → 不串账', async ($, on) => {
  const b = setup(on)
  await start($)
  b.guardStore.set('guard-state', { 'sess-OTHER': { _proAt: Date.now(), _at: Date.now() } })
  await turn($, proTurnUsage('deepseek-v4-flash'), undefined, 30000)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/档位构成: Pro ¥0\.000\(0 轮\)/)
})

test('档位归属:usage.model 自己就报 Pro → 记 Pro(不依赖标记;如实报模型的宿主走这条)', async ($, on) => {
  const b = setup(on)
  await start($)
  await turn($, proTurnUsage('deepseek-v4-pro[1m]'), undefined, 30000)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/Pro ¥[\d.]+\(1 轮\)/)
})

test('档位归属:子代理轮次不进账本(它按设计走基础档)', async ($, on) => {
  const b = setup(on)
  await start($)
  proMark(b, Date.now())
  await turn($, proTurnUsage('deepseek-v4-flash'), 'sub-1', 30000)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/轮次: 0/)
})

// —— 分账计价(2026-10-10):每轮按引擎报的**作答模型**归账,Pro 部分走 Pro 价目 ——
//    此前是"整段会话按当前档位计价",于是升过档的日子成本显示偏低 ——
const turnUsage = (model: string | undefined, input: number, output = 0) => ({
  ...(model === undefined ? {} : { model }),
  input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
})

test('分账计价:一轮基础档 + 一轮 Pro 档 → 各归各账,Pro 部分走 Pro 价', async ($, on) => {
  const b = setup(on)
  await start($)
  await turn($, turnUsage('deepseek-v4-flash', 1_000_000), undefined)
  await turn($, turnUsage('deepseek-v4-pro[1m]', 1_000_000), undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/档位构成: Pro ¥[1-9]/) // Pro 那轮按 Pro 价(空闲 4.5 / 高峰 9,故只断言"非零")
  expect(out.text).toMatch(/Pro ¥[\d.]+\(1 轮\)/)
  expect(out.text).toMatch(/基础档 ¥[1-9]/)
  expect(out.text).toMatch(/基础档 ¥[\d.]+\(1 轮\)/)
})

test('分账计价:全基础档会话 → Pro 部分为 0 并标注「未升过档」', async ($, on) => {
  const b = setup(on)
  await start($)
  await turn($, turnUsage('deepseek-v4-flash', 1_000_000, 500), undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/档位构成: Pro ¥0\.000\(0 轮\)/)
  expect(out.text).toMatch(/本会话未升过档/)
})

test('分账计价:引擎没报模型 → 退回会话档位归账(fail-safe)', async ($, on) => {
  const b = setup(on)
  b.setModel('deepseek-v4-pro[1m]') // 会话档位本身是 Pro
  await start($)
  await turn($, turnUsage(undefined, 1_000_000), undefined)
  const out = await runCmd($, 'token-status')
  expect(out.text).toMatch(/Pro ¥[1-9]/)
})

// 悬浮条(AbovePrompt)不做单元断言:测试框架要求 ui.render 的 bottom 返回真实树元素,
// 而元素构造器只存在于引擎内部,测试 bottom 拿不到。其验证由三层兜底:
// engine validate(API 形状)+ 热重载零失败(引擎加载)+ /token-status(数据路径)+ 用户肉眼(输入框上方)。

// 高峰判定:固定按 UTC+8(北京),与本机时区无关。
// ⚠ 旧实现用 getHours()/getDay() = 本机本地时区,而价目表与 holidays 都是北京口径
// ⇒ 非中国时区的机器会静默错价(2026-10-11 修)。用固定时刻打靶(北京时间 = UTC+8)。
test('高峰判定按北京时间(UTC+8)算,与本机时区无关', () => {
  // 2026-10-12 是周一:UTC 01:00 = 北京 09:00(高峰起点),UTC 00:59 = 北京 08:59(还空闲)
  expect(isPeakAt([], Date.parse('2026-10-12T01:00:00Z'))).toBe(true)
  expect(isPeakAt([], Date.parse('2026-10-12T00:59:00Z'))).toBe(false)
  // 午休空档:北京 12:00 与 13:59 空闲,14:00 起再高峰
  expect(isPeakAt([], Date.parse('2026-10-12T04:00:00Z'))).toBe(false)
  expect(isPeakAt([], Date.parse('2026-10-12T05:59:00Z'))).toBe(false)
  expect(isPeakAt([], Date.parse('2026-10-12T06:00:00Z'))).toBe(true)
  // 北京 18:00 收工
  expect(isPeakAt([], Date.parse('2026-10-12T10:00:00Z'))).toBe(false)
  // 周末(北京周六 10:00)全天空闲
  expect(isPeakAt([], Date.parse('2026-10-17T02:00:00Z'))).toBe(false)
  // 节假日按**北京日期**比:同一 UTC 时刻落在北京 10-12 ⇒ 命中 holidays
  expect(isPeakAt(['2026-10-12'], Date.parse('2026-10-12T02:00:00Z'))).toBe(false)
})

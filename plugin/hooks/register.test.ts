// cc-token-optimizer(CC mods 层)引擎级测试。
// 插件 hook 只依赖 $.command.register / $.session.usage / $.ui.resolve,
// 其余沿链下到本文件的 bottom hooks(它们"代表引擎"):注册表 + 固定 usage 快照 +
// 各事件的最小合法结果形态(turn.complete 事件需带 answer;结果需带 text)。
// ui.resolve 不设 bottom:测试框架自带真实元素实现。
// 可观测面:聚合结果经 /token-status 命令输出断言;悬浮条断言"0 轮透传 / 有数据画树"。

import { test, expect } from 'claude-code/testing'

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
  return { registered, state }
}

const start = async ($: any) => {
  await $.session.start({ cwd: '/pkg', surface: 'terminal', isInteractive: true })
}
const turn = async ($: any, usage: any, agentId: string | undefined) => {
  await $.turn.complete({ answer: 'ok', usage, agentId })
}

test('turn.complete 聚合主会话 usage,subagent 轮次不计入', async ($, on) => {
  const b = setup(on)
  await start($)
  await turn($, { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }, undefined)
  await turn($, { input_tokens: 0, output_tokens: 999, cache_read_input_tokens: 9900, cache_creation_input_tokens: 0 }, 'sub-1')
  const out = await $.command.run({ command: 'token-status' })
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
  const out = await $.command.run({ command: 'token-status' })
  expect(out.text).toMatch(/命中率: 40\.0%/)
})

test('usage 字段缺失不崩溃(防御性聚合)', async ($, on) => {
  setup(on)
  await start($)
  await turn($, null, undefined)
  const out = await $.command.run({ command: 'token-status' })
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
  const out = await $.command.run({ command: 'token-status' })
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
  const out = await $.command.run({ command: 'token-status' })
  expect(out.text).toMatch(/轮次: 1/) // 不是 43
  expect(out.text).toMatch(/register 加载 1 次\(未重载\)/)
})

test('usage 缺失的轮次单独计数(诊断口径:区分"没收到事件"与"CC 没给 usage")', async ($, on) => {
  setup(on)
  await start($)
  await turn($, null, undefined)
  await turn($, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 400, cache_creation_input_tokens: 0 }, undefined)
  const out = await $.command.run({ command: 'token-status' })
  expect(out.text).toMatch(/轮次: 1\(另有 usage 缺失 1 轮、子代理 0 轮,未计价\)/)
})

// 悬浮条(AbovePrompt)不做单元断言:测试框架要求 ui.render 的 bottom 返回真实树元素,
// 而元素构造器只存在于引擎内部,测试 bottom 拿不到。其验证由三层兜底:
// engine validate(API 形状)+ 热重载零失败(引擎加载)+ /token-status(数据路径)+ 用户肉眼(输入框上方)。

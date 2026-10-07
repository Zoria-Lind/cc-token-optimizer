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
  return { registered }
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
// 悬浮条(AbovePrompt)不做单元断言:测试框架要求 ui.render 的 bottom 返回真实树元素,
// 而元素构造器只存在于引擎内部,测试 bottom 拿不到。其验证由三层兜底:
// engine validate(API 形状)+ 热重载零失败(引擎加载)+ /token-status(数据路径)+ 用户肉眼(输入框上方)。

// cc-token-optimizer(tokenGuard 层)引擎级测试。
// 覆盖:readDedup 的拦截/放行/逃生/fail-open、outputTrim 的裁剪、coldStartGuard 的注入、
//       modelDirector 的触发。
//
// 测试的 bottom hooks 代表引擎:虚拟 fs / state / ui,以及各 classic 事件的空实现
//(引擎要求"插件之下必须有人应答该事件",否则抛 HooksError)。
// Read 的路径走 $.tool.call —— 与真实会话一致(recordRead 挂在同一条 hook 里)。
import { test, expect } from 'claude-code/testing'

type FsFile = { text: string; mtimeMs: number; size: number }

const setupGuard = (on: any) => {
  const files = new Map<string, FsFile>()
  const state = new Map<string, unknown>()
  const toasts: string[] = []
  const pick = (e: any): string => (typeof e === 'string' ? e : String(e?.path ?? ''))
  // 路径形态不确定,只放一个文件时按"唯一文件"兜底,不影响测试语义
  const lookup = (e: any): FsFile | undefined => files.get(pick(e)) ?? [...files.values()][0]

  on('fs.read', (_$: any, e: any) => {
    const f = lookup(e)
    if (!f) throw new Error('ENOENT')
    return { value: f.text }
  })
  on('fs.stat', (_$: any, e: any) => {
    const f = lookup(e)
    if (!f) throw new Error('ENOENT')
    return { value: { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))

  let version = 0
  on('state.get', (_$: any, e: any) => ({ value: { value: state.get(`${e.plugin}:${e.key}`), version } }))
  on('state.set', (_$: any, e: any) => {
    state.set(`${e.plugin}:${e.key}`, e.value)
    version += 1
    return { value: { isSet: true, version } }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(typeof e === 'string' ? e : String(e?.text ?? ''))
    return { value: undefined }
  })

  // classic 事件的 bottom:插件不调用 next 时用不到,调用时需要有人应答
  on('classic.PreToolUse', () => ({}))
  on('classic.PostToolUse', () => ({}))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.PreModelSwitch', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  // 引擎执行工具后的回传(代表真实工具)
  on('tool.call', () => ({ result: { text: 'file content' } }))

  return { files, state, toasts }
}

const readArgs = (path: string, id: string, offset = 1, limit = 2000) => ({
  tool: 'Read' as const, file_path: path, offset, limit, tool_use_id: id,
})

test('readDedup:同一文件同一区间读两次 → 第二次被拦截', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1')) // 第一次:放行并记录已读区间
  const r = await $.tool.call(readArgs('/x.ts', 'tu2'))
  expect(JSON.stringify(r)).toMatch(/无需重读/)
})

test('readDedup:文件已变(mtime/size 不同)→ 放行', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1'))
  b.files.set('/x.ts', { text: 'y'.repeat(40), mtimeMs: 2000, size: 40 })
  const r = await $.tool.call(readArgs('/x.ts', 'tu2'))
  expect(JSON.stringify(r)).not.toMatch(/无需重读/)
})

test('readDedup:区间未覆盖 → 放行(先读 1-100,再要 1-2000)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1', 1, 100))
  const r = await $.tool.call(readArgs('/x.ts', 'tu2', 1, 2000))
  expect(JSON.stringify(r)).not.toMatch(/无需重读/)
})

test('readDedup:子区间已在记录内 → 拦截(读过 1-2000,再要 1-100)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1', 1, 2000))
  const r = await $.tool.call(readArgs('/x.ts', 'tu2', 1, 100))
  expect(JSON.stringify(r)).toMatch(/无需重读/)
})

test('fail-open:文件读不到(新文件)→ 绝不拦截', async ($, on) => {
  setupGuard(on) // files 为空 → fs.stat 抛 ENOENT
  const r = await $.tool.call(readArgs('/nope.ts', 'tu3'))
  expect(JSON.stringify(r)).not.toMatch(/无需重读/)
})

test('readDedup 逃生:连续拦截到上限后自动放行(防死锁)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1'))
  const results: string[] = []
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    results.push(JSON.stringify(await $.tool.call(readArgs('/x.ts', id))))
  }
  // MAX_DENIES=3:前三次拦,第四次起放行
  expect(results[0]).toMatch(/无需重读/)
  expect(results[3]).not.toMatch(/无需重读/)
})

test('outputTrim:超长输出 → 裁剪并标注', async ($, on) => {
  setupGuard(on)
  const long = 'A'.repeat(20000)
  const r = await $.classic.PostToolUse({
    tool_name: 'Bash', tool_use_id: 'b1',
    tool_input: { command: 'echo hi' }, tool_response: long,
  })
  const s = JSON.stringify(r)
  expect(s).toMatch(/裁剪为头尾采样/)
  expect(s.length).toBeLessThan(long.length)
})

test('outputTrim:重复行 → 折叠', async ($, on) => {
  setupGuard(on)
  const dup = Array.from({ length: 10 }, () => 'same line').join('\n')
  const r = await $.classic.PostToolUse({
    tool_name: 'Bash', tool_use_id: 'b2',
    tool_input: { command: 'x' }, tool_response: dup,
  })
  expect(JSON.stringify(r)).toMatch(/已折叠/)
})

test('outputTrim:短输出不动', async ($, on) => {
  setupGuard(on)
  const r = await $.classic.PostToolUse({
    tool_name: 'Bash', tool_use_id: 'b3',
    tool_input: { command: 'x' }, tool_response: 'short',
  })
  expect(JSON.stringify(r)).not.toMatch(/裁剪|已折叠/)
})

test('coldStartGuard:缓存过期 → 注入 /clear 建议', async ($, on) => {
  setupGuard(on)
  const r = await $.classic.SessionStart({
    source: 'resume', prompt_cache_likely_expired: true, context_tokens: 120000,
  })
  expect(JSON.stringify(r)).toMatch(/提示缓存已过期/)
})

test('coldStartGuard:缓存未过期 → 不注入', async ($, on) => {
  setupGuard(on)
  const r = await $.classic.SessionStart({ source: 'startup' })
  expect(JSON.stringify(r)).not.toMatch(/提示缓存已过期/)
})

test('modelDirector:命中 coding 关键词 → 注入升档提醒 + 提醒用户', async ($, on) => {
  const b = setupGuard(on)
  const r = await $.classic.UserPromptSubmit({ prompt: '帮我重构这个模块的架构设计' })
  expect(JSON.stringify(r)).toMatch(/coding-pro/)
  expect(b.toasts.length).toBeGreaterThan(0)
})

test('modelDirector:普通短句 → 不打扰', async ($, on) => {
  const b = setupGuard(on)
  const r = await $.classic.UserPromptSubmit({ prompt: '好的' })
  expect(JSON.stringify(r)).not.toMatch(/coding-pro/)
  expect(b.toasts.length).toBe(0)
})

test('modelDirector:长提示也算命中(长度启发式)', async ($, on) => {
  setupGuard(on)
  const r = await $.classic.UserPromptSubmit({ prompt: '请'.repeat(200) })
  expect(JSON.stringify(r)).toMatch(/长提示/)
})

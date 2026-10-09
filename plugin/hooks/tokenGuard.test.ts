// cc-token-optimizer(tokenGuard 层)引擎级测试。
// 覆盖:readDedup 的拦截/放行/逃生/fail-open、outputTrim 的裁剪、coldStartGuard 的注入、
//       modelDirector 的触发。
//
// 测试的 bottom hooks 代表引擎:虚拟 fs / store / session / ui,以及各 classic 事件的空实现
//(引擎要求"插件之下必须有人应答该事件",否则抛 HooksError)。
// Read 的路径走 $.tool.call —— 与真实会话一致(recordRead 挂在同一条 hook 里)。
import { test, expect } from 'claude-code/testing'

type FsFile = { text: string; mtimeMs: number; size: number }

const setupGuard = (on: any) => {
  const files = new Map<string, FsFile>()
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  let session = 'sess-1' // 可切换:用来验证跨会话分桶
  let liveModel: string | null = 'deepseek-flash[1m]' // 实时档位,硬升档闸的判据
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

  // 状态走 $.store(跨会话 KV)。引擎约定:bottom 返回 { value: X } ⇒ API 返回 X。
  on('store.get', (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  // 会话 id:mod 的 tool.call 载荷不带 session_id,插件必须从 $.session.id() 取(见 sessionId())
  on('session.id', () => ({ value: session }))
  on('session.model', () => ({ value: liveModel })) // 硬升档闸读实时档位
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

  return { files, store, toasts, setSession: (s: string) => { session = s }, setModel: (m: string | null) => { liveModel = m } }
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
  // 没有 config.json ⇒ 内置默认 skillName 为空 ⇒ 通用措辞:只建议 /model 切档,不点名技能
  expect(JSON.stringify(r)).toMatch(/\/model deepseek-v4-pro/)
  expect(JSON.stringify(r)).not.toMatch(/Skill/)
  expect(b.toasts.length).toBeGreaterThan(0)
})

test('modelDirector:普通短句 → 不打扰', async ($, on) => {
  const b = setupGuard(on)
  const r = await $.classic.UserPromptSubmit({ prompt: '好的' })
  expect(JSON.stringify(r)).not.toMatch(/Skill|\/model deepseek/)
  expect(b.toasts.length).toBe(0)
})

test('modelDirector:config 配了 skillName → 升档建议点名该技能', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', {
    text: JSON.stringify({ upgrade: { skillName: 'my-upgrade-skill' } }),
    mtimeMs: 1, size: 40,
  })
  const r = await $.classic.UserPromptSubmit({ prompt: '帮我重构这个模块的架构设计' })
  expect(JSON.stringify(r)).toMatch(/my-upgrade-skill/)
})

test('money:config 里的 currency 前缀会用在切换成本估算上', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: JSON.stringify({ currency: '$' }), mtimeMs: 1, size: 16 })
  await $.classic.PreModelSwitch({ from_model: 'cheap-x', to_model: 'pro-y', context_tokens: 80000 })
  // 80k × 4.5 元/M = 0.36,前缀换成 $ 后同额
  expect(b.toasts.join(' ')).toMatch(/重缓存约 \$0\.36/)
})

// —— 硬升档闸:模型决定改代码 = 事实上的 coding 判定,插件据此把它当轮推到强档 ——
const editArgs = (p: string, id: string) => ({
  tool: 'Edit' as const, file_path: p, old_string: 'a', new_string: 'b', tool_use_id: id,
})
const skillCfg = JSON.stringify({ upgrade: { skillName: 'my-upgrade-skill' } })

test('硬升档闸:基础档 + 配了技能 → 拦首次改动,要求先激活技能再重试', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  const r = await $.tool.call(editArgs('/x.ts', 'ed1'))
  expect(JSON.stringify(r)).toMatch(/my-upgrade-skill/)
  expect(JSON.stringify(r)).toMatch(/重试/)
})

test('硬升档闸:同一回合内第二次改动不再拦(防"拦→重试→再拦"死循环)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  await $.classic.UserPromptSubmit({ prompt: '帮我改个东西' }) // 回合标记
  await $.tool.call(editArgs('/x.ts', 'ed1'))
  const r2 = await $.tool.call(editArgs('/x.ts', 'ed2'))
  expect(JSON.stringify(r2)).not.toMatch(/my-upgrade-skill/)
})

test('硬升档闸:新回合的首次改动会再拦一次(每回合最多一次)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  await $.classic.UserPromptSubmit({ prompt: '帮我改个东西' })
  const r1 = await $.tool.call(editArgs('/x.ts', 'ed1'))
  expect(JSON.stringify(r1)).toMatch(/my-upgrade-skill/)
  await $.classic.UserPromptSubmit({ prompt: '继续改' }) // 新回合
  const r2 = await $.tool.call(editArgs('/x.ts', 'ed2'))
  expect(JSON.stringify(r2)).toMatch(/my-upgrade-skill/)
})

test('硬升档闸:实时档位已是 Pro → 不拦(技能切档不走 PostModelSwitch,必须读实时值)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  b.setModel('deepseek-v4-pro[1m]')
  const r = await $.tool.call(editArgs('/x.ts', 'ed1'))
  expect(JSON.stringify(r)).not.toMatch(/my-upgrade-skill/)
})

test('硬升档闸:没配 skillName → 不拦,但粘性窗口照记', async ($, on) => {
  const b = setupGuard(on)
  const r = await $.tool.call(editArgs('/x.ts', 'ed1'))
  expect(JSON.stringify(r)).not.toMatch(/Skill/)
  const held = b.store.get('guard-state') as any
  expect(JSON.stringify(held)).toMatch(/_codingAt/)
})

test('硬升档闸:改文档(.md)不拦,无扩展名的代码文件(Dockerfile)按 basename 判', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  const r1 = await $.tool.call({ tool: 'Edit', file_path: '/notes.md', old_string: 'a', new_string: 'b', tool_use_id: 'md1' })
  expect(JSON.stringify(r1)).not.toMatch(/my-upgrade-skill/)
  const r2 = await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\Dockerfile', old_string: 'a', new_string: 'b', tool_use_id: 'dk1' })
  expect(JSON.stringify(r2)).toMatch(/my-upgrade-skill/)
})

test('modelDirector:长文本但无关键词、近期无改动 → 不打扰(长度不再单独触发)', async ($, on) => {
  const b = setupGuard(on)
  const r = await $.classic.UserPromptSubmit({ prompt: '请'.repeat(200) })
  expect(JSON.stringify(r)).not.toMatch(/Skill|\/model deepseek/)
  expect(b.toasts.length).toBe(0)
})

// —— 状态迁移回归:必须落 $.store(跨会话),不能再退回会话级 $.state ——
test('state:已读记录写进 $.store 的 guard-state', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1'))
  const held = b.store.get('guard-state') as any
  expect(held).toBeTruthy()
  expect(JSON.stringify(held)).toMatch(/\/x\.ts/)
})

test('state:不同会话互不污染(会话桶按 $.session.id() 分)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/x.ts', 'tu1')) // sess-1 读过
  b.setSession('sess-2') // 换会话:新上下文里并没有这份内容,不该拦
  const r = await $.tool.call(readArgs('/x.ts', 'tu2'))
  expect(JSON.stringify(r)).not.toMatch(/无需重读/)
})

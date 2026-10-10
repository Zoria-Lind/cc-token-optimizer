// cc-token-optimizer(tokenGuard 层)引擎级测试。
// 覆盖:readDedup 的拦截/放行/逃生/fail-open、outputTrim 的裁剪、coldStartGuard 的注入、
//       modelDirector 的触发。
//
// 测试的 bottom hooks 代表引擎:虚拟 fs / store / session / ui,以及各 classic 事件的空实现
//(引擎要求"插件之下必须有人应答该事件",否则抛 HooksError)。
// Read 的路径走 $.tool.call —— 与真实会话一致(recordRead 挂在同一条 hook 里)。
import { test, expect } from 'claude-code/testing'

type FsFile = { text: string; mtimeMs: number; size: number }

const setupGuard = (on: any, readResult?: unknown) => {
  const files = new Map<string, FsFile>()
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const realPaths = new Map<string, string>() // 字面拼写 → 真身(模拟 fs.stat 的 {resolve:true}.realPath)
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
    const real = realPaths.get(pick(e)) // 用来验证"按解析后路径归一"(见 setRealPath)
    return { value: { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false, ...(real ? { realPath: real } : {}) } }
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
  // 引擎执行工具后的回传(代表真实工具)。readResult 可注入:用来模拟"实际只返回了前 N 行"(被 token 上限截断)
  on('tool.call', () => ({ result: readResult ?? { text: 'file content' } }))
  // turn.complete 的 bottom(账本聚合在 register.tsx;升档判据已移到 Skill 的 PostToolUse,见文末用例)
  on('turn.complete', () => ({ text: 'ok' }))
  // session.compact 的 bottom:压缩点作废读记录(见 tokenGuard.ts 的 compactReset)。
  // ⚠ 必须回 `{ messages }` 或 `{ skip }`(回 `{}` 引擎会判该 hook 被跳过,且 messages 不能为空)
  on('session.compact', (_$: any, e: any) => ({ messages: e.messages }))

  return {
    files, store, toasts,
    setSession: (s: string) => { session = s },
    setModel: (m: string | null) => { liveModel = m },
    setRealPath: (from: string, to: string) => { realPaths.set(from, to) },
  }
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

test('modelDirector:命中 coding 关键词 → 只静默提醒模型,不再给用户发预测式提示', async ($, on) => {
  const b = setupGuard(on)
  const r = await $.classic.UserPromptSubmit({ prompt: '帮我重构这个模块的架构设计' })
  // 没有 config.json ⇒ 内置默认 skillName 为空 ⇒ 通用措辞:只建议 /model 切档,不点名技能
  expect(JSON.stringify(r)).toMatch(/\/model deepseek-v4-pro/)
  expect(JSON.stringify(r)).not.toMatch(/Skill/)
  // 2026-10-10:旧的用户侧提示既误报(口语词命中)又误述(那一刻并没切档,切档得靠模型真去调技能),
  // 用户反馈"搞得人心里很紧张" ⇒ 已删;用户侧提醒改成"升档当场弹"(见文末 Skill 用例)
  expect(b.toasts.length).toBe(0)
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

test('硬升档闸:新回合的首次改动会再拦一次(每回合最多一次;回合边界 = turn.complete)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  const r1 = await $.tool.call(editArgs('/x.ts', 'ed1'))
  expect(JSON.stringify(r1)).toMatch(/my-upgrade-skill/)
  await $.turn.complete({ answer: 'ok' }) // 回合结束 ⇒ `_epoch` 前进(边界只由它定义)
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

test('升档粘性窗口:改文档(.md)不落 _codingAt —— 纯文档轮不该被判成 coding 流', async ($, on) => {
  const b = setupGuard(on)
  await $.tool.call({ tool: 'Edit', file_path: '/notes.md', old_string: 'a', new_string: 'b', tool_use_id: 'md-sticky' })
  const held = b.store.get('guard-state') as any
  expect(JSON.stringify(held)).not.toMatch(/_codingAt/)
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

test('关键词表:日常口语词不再触发,高精度词仍触发(2026-10-10 由 43 项收紧到 19 项)', async ($, on) => {
  const b = setupGuard(on)
  // 这几个词在"讨论插件/方案"时天天出现,旧表把它们当 coding 信号 ⇒ 纯讨论轮被误判
  const r1 = await $.classic.UserPromptSubmit({ prompt: '我们讨论一下这个方案和接口的设计,还有模块依赖' })
  expect(JSON.stringify(r1)).not.toMatch(/coding 信号|coding 流/)
  expect(b.toasts.length).toBe(0)
  // 高精度信号(几乎只出现在 coding 语境)仍应触发
  const r2 = await $.classic.UserPromptSubmit({ prompt: '这里报错了,帮我调试一下' })
  expect(JSON.stringify(r2)).toMatch(/coding 信号/)
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

// —— 升档事实(2026-10-10 重做):判据 = **Skill 工具结果里引擎报的解析模型** ——
// 类型原话:"Resolved model the skill turn runs on when a frontmatter model override took effect; omitted otherwise"
// 会话日志实测:toolUseResult = {"success":true,"commandName":"coding-pro","model":"deepseek-v4-pro[1m]"}
// 为什么不用 usage.model:直连 DeepSeek 时它报的是**会话档位**(近 24h 548 条日志零条 pro),判据恒为假。
const skillArgs = (id: string, resp: unknown, skill = 'coding-pro') => ({
  tool_name: 'Skill', tool_use_id: id, tool_input: { skill, args: '' }, tool_response: resp,
})
const inlinePro = { success: true, commandName: 'coding-pro', model: 'deepseek-v4-pro[1m]' }
const namedSkill = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  skillArgs(id, { success: true, commandName: name, ...extra }, name)

test('升档事实:Skill 结果里引擎报 Pro → 落 _proAt 并当场提醒', async ($, on) => {
  const b = setupGuard(on)
  await $.classic.UserPromptSubmit({ prompt: '改一下这个函数' }) // 用户发言不再推进回合边界,只验证它不该打断判据
  await $.classic.PostToolUse(skillArgs('sk1', inlinePro))
  expect(JSON.stringify(b.store.get('guard-state'))).toMatch(/_proAt/)
  expect(b.toasts.join(' ')).toMatch(/已升到 Pro 档/)
  expect(b.toasts.join(' ')).toMatch(/deepseek-v4-pro/)
})

test('升档事实:技能没有 model 头、名字也不是配置的强档技能 → 不标记不提醒', async ($, on) => {
  const b = setupGuard(on)
  await $.classic.PostToolUse(namedSkill('sk2', 'dataviz'))
  expect(JSON.stringify(b.store.get('guard-state'))).not.toMatch(/_proAt/)
  expect(b.toasts.length).toBe(0)
})

test('升档事实:引擎没报 model → 退化为按技能名判定,文案如实标注判据', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  await $.classic.PostToolUse(namedSkill('sk3', 'my-upgrade-skill'))
  expect(JSON.stringify(b.store.get('guard-state'))).toMatch(/_proAt/)
  expect(b.toasts.join(' ')).toMatch(/按技能名判定/)
})

test('升档事实:fork 形态(status=forked,无 model)→ 不标记(干活的是子 agent,主循环没升档)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  await $.classic.PostToolUse(namedSkill('sk4', 'my-upgrade-skill', { status: 'forked', agentId: 'a1' }))
  expect(JSON.stringify(b.store.get('guard-state'))).not.toMatch(/_proAt/)
  expect(b.toasts.length).toBe(0)
})

test('升档事实:子 agent 里调用技能 → 不标记不提醒', async ($, on) => {
  const b = setupGuard(on)
  await $.classic.PostToolUse({ ...skillArgs('sk5', inlinePro), agent_id: 'sub-1' })
  expect(JSON.stringify(b.store.get('guard-state'))).not.toMatch(/_proAt/)
  expect(b.toasts.length).toBe(0)
})

test('升档事实:会话本来就常驻 Pro → 不提醒(没有"升"发生)', async ($, on) => {
  const b = setupGuard(on)
  b.setModel('deepseek-v4-pro[1m]')
  await $.classic.PostToolUse(skillArgs('sk6', inlinePro))
  expect(b.toasts.length).toBe(0)
})

test('升档事实:冷却窗口内第二次升档 → 不重复提醒,但记账照落(冷却只压提醒)', async ($, on) => {
  const b = setupGuard(on)
  await $.classic.PostToolUse(skillArgs('sk7', inlinePro))
  const first = (b.store.get('guard-state') as any)['sess-1']._proAt
  await $.classic.PostToolUse(skillArgs('sk8', inlinePro))
  expect(b.toasts.length).toBe(1)
  expect((b.store.get('guard-state') as any)['sess-1']._proAt).toBeGreaterThanOrEqual(first)
})

test('硬升档闸:本回合已升过档 → 不再白拦一次(实现本次修复时被旧逻辑拦过一次)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  await $.classic.UserPromptSubmit({ prompt: '帮我改个东西' }) // (升档事实落在 epoch 0)
  await $.classic.PostToolUse(namedSkill('sk9', 'my-upgrade-skill', { model: 'deepseek-v4-pro[1m]' }))
  const r = await $.tool.call(editArgs('/x.ts', 'ed-pro'))
  expect(JSON.stringify(r)).not.toMatch(/my-upgrade-skill/)
})

// —— 关键词边界(2026-10-10):旧的子串匹配让 `.json` 命中 `.js`(用户贴的 /token-status 输出里就有
//    `cc-token-optimizer*.json`,于是模型侧白收一条 coding 指令 = 白升 Pro 的钱从这里漏)——
test('关键词边界:.json 不再命中 .js;真扩展名(.ts)仍命中', async ($, on) => {
  const b = setupGuard(on)
  const r1 = await $.classic.UserPromptSubmit({ prompt: '看下 plugins/store/cc-token-optimizer.json 里的 guard-state' })
  expect(JSON.stringify(r1)).not.toMatch(/coding 信号|coding 流/)
  const r2 = await $.classic.UserPromptSubmit({ prompt: '改一下 tokenGuard.ts 里的判据' })
  expect(JSON.stringify(r2)).toMatch(/coding 信号/)
})

// ============ 2026-10-11 审查修复的回归用例 ============

// ① PDF 分页读:pages 与行区间没有可比性 ⇒ 既不参与去重也不记账。
// 旧实现读的是 classic 信封里的 `e.tool_input.pages`,而 readDedup 只跑在展平的 tool.call 载荷上
// (`e.pages`)⇒ 守卫恒不成立,分页读被当行区间处理。
test('readDedup:PDF 分页读(pages)不参与行区间去重,也不落记录', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/doc.pdf', { text: 'p'.repeat(20), mtimeMs: 1000, size: 20 })
  const pagesRead = (pages: string, id: string) => ({ tool: 'Read' as const, file_path: '/doc.pdf', pages, tool_use_id: id })
  await $.tool.call(pagesRead('1-5', 'pg1')) // 分页读:不记账
  const r1 = await $.tool.call(readArgs('/doc.pdf', 'pg2')) // 随后整文件读必须放行(旧实现被分页读记的 [1,2000] 拦掉)
  expect(JSON.stringify(r1)).not.toMatch(/无需重读/)
  const r2 = await $.tool.call(pagesRead('6-10', 'pg3')) // 已有记录后换页再读,也必须放行
  expect(JSON.stringify(r2)).not.toMatch(/无需重读/)
})

// ② 记账用**实际返回区间**:大文件被 token 上限自动分页时模型只拿到首页,却记成请求的 1-2000
// ⇒ 之后为拿剩余部分重读 1-2000 被误拦("已在上下文中"是假的)。
test('readDedup:按实际返回区间记账(截断读)⇒ 为拿剩余部分重读不被误拦', async ($, on) => {
  const b = setupGuard(on, { type: 'text', file: { filePath: '/big.ts', content: 'b', numLines: 800, startLine: 1 } })
  b.files.set('/big.ts', { text: 'b'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.tool.call(readArgs('/big.ts', 'bg1', 1, 2000))
  const held = b.store.get('guard-state') as any
  expect(held['sess-1']['/big.ts'].ranges).toEqual([[1, 800]]) // 旧实现会记成 [[1,2000]]
  const r = await $.tool.call(readArgs('/big.ts', 'bg2', 1, 2000))
  expect(JSON.stringify(r)).not.toMatch(/无需重读/)
})

// ③ 压缩点:旧工具输出已被清出上下文 ⇒ 读记录必须作废(否则重读被拦,且文案谎称"已在上下文中");
// 但 trigger='precompute' 是**不落地**的那种(上下文没变)⇒ 记录必须留着,否则白白废掉去重。
test('compactReset:真压缩作废读记录(重读放行),precompute 不动记录,回合态保留', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  await $.turn.complete({ answer: 'ok' }) // 先建起回合边界态(register.tsx 的 noteTurnEnd 写 _epoch)
  // 引擎要求 messages 非空(a compaction leaves at least one)
  const msgs = [{ role: 'user' as const, text: 'hi', toolUses: [], handle: 'm1' }]
  await $.tool.call(readArgs('/x.ts', 'cp1'))
  expect(JSON.stringify(await $.tool.call(readArgs('/x.ts', 'cp2')))).toMatch(/无需重读/) // 正常情况下会被拦
  await $.session.compact({ trigger: 'precompute', messages: msgs }) // 预计算:上下文没变
  expect(JSON.stringify(await $.tool.call(readArgs('/x.ts', 'cp3')))).toMatch(/无需重读/) // 记录仍有效
  await $.session.compact({ trigger: 'manual', messages: msgs }) // 真压缩
  const mid = b.store.get('guard-state') as any // ⚠ 断言必须在下次读之前:读成功会重新记账
  expect(Object.keys(mid['sess-1']).filter((k) => !k.startsWith('_'))).toEqual([]) // 文件记录清空
  expect(mid['sess-1']._epoch).toBeDefined() // 回合态保留(连它一起清会让硬升档闸在同一回合重复拦)
  const r = await $.tool.call(readArgs('/x.ts', 'cp4'))
  expect(JSON.stringify(r)).not.toMatch(/无需重读/) // 作废后必须放行
})

// ④ 读记录按**解析后路径**归一:同一文件用两种拼写读,不该记成两条(实测子 agent 桶里真出现过双份)
// —— 双份会白白丢掉去重机会,还占掉每会话 200 条的上限。
test('readDedup:记录键用解析后路径 —— 同一文件的两种拼写算同一条', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('D:/x.ts', { text: 'x'.repeat(20), mtimeMs: 1000, size: 20 })
  b.setRealPath('D:\\x.ts', 'D:/x.ts') // 反斜杠那种拼写解析到同一个真身
  await $.tool.call(readArgs('D:\\x.ts', 'nm1', 1, 100))
  const held = b.store.get('guard-state') as any
  expect(Object.keys(held['sess-1'])).toContain('D:/x.ts')
  expect(Object.keys(held['sess-1'])).not.toContain('D:\\x.ts')
  const r = await $.tool.call(readArgs('D:/x.ts', 'nm2', 1, 100)) // 换拼写读同一区间 → 仍应被拦
  expect(JSON.stringify(r)).toMatch(/无需重读/)
})

// ⑤ 硬升档闸的"本回合"判据:2026-10-11 现场复现的回归 —— 同一回合内**再触发一次 UserPromptSubmit**
// (子 agent 的 hand-back 以 user 角色消息注入就会这样)不该让已升档的回合被白拦。
test('硬升档闸:同一回合内再触发 UserPromptSubmit 后,已升档的回合仍不被白拦(2026-10-11 回归)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  await $.classic.PostToolUse(namedSkill('sk-mid', 'my-upgrade-skill', { model: 'deepseek-v4-pro[1m]' })) // 本回合已升档
  await $.classic.UserPromptSubmit({ prompt: '子 agent 的 hand-back 混进来了' }) // 旧实现:_turn 被顶高 ⇒ 判据失效
  const r = await $.tool.call(editArgs('/x.ts', 'ed-mid'))
  expect(JSON.stringify(r)).not.toMatch(/my-upgrade-skill/)
})

// ⑥ 子 agent 的改动不拦(2026-10-11 发布前复核抓出):子 agent 跑在子代理档上,技能的回合级切档
// 切不到它 ⇒ "先调技能再重试"这条建议它执行不了,拦下来纯白丢一轮。
test('硬升档闸:子 agent 改代码文件 → 不拦(它切不动档,叫它调技能是空转)', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  const r = await $.tool.call({ ...editArgs('/x.ts', 'sub-1'), agentId: 'agent-1' })
  expect(JSON.stringify(r)).not.toMatch(/my-upgrade-skill/)
})

test('硬升档闸:子 agent 的改动不占本回合的名额 —— 主线程自己首次改代码仍要拦', async ($, on) => {
  const b = setupGuard(on)
  b.files.set('/plugin/config.json', { text: skillCfg, mtimeMs: 1, size: 40 })
  const sub = await $.tool.call({ ...editArgs('/x.ts', 'sub-2'), agentId: 'agent-1' })
  expect(JSON.stringify(sub)).not.toMatch(/my-upgrade-skill/)
  const main = await $.tool.call(editArgs('/x.ts', 'main-2'))
  expect(JSON.stringify(main)).toMatch(/my-upgrade-skill/)
})

test('硬升档闸:子 agent 的改动照旧落 _codingAt(粘性窗口口径不变)', async ($, on) => {
  const b = setupGuard(on)
  await $.tool.call({ ...editArgs('/x.ts', 'sub-3'), agentId: 'agent-1' }) // 未配技能 ⇒ 闸本身是关的
  expect(JSON.stringify(b.store.get('guard-state'))).toMatch(/_codingAt/)
})

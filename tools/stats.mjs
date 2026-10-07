#!/usr/bin/env node
// stats — 汇总 <CLAUDE_CONFIG_DIR>/token-optimizer/state.json 的 _stats(各会话拦截/裁剪/折叠计数)
// 与 archive 存档体积,估算累计省下的 token。零依赖、只读、fail-open。
// 用法:
//   node stats.mjs          人类可读汇总(每会话一行 + 总计)
//   node stats.mjs --json   原样输出汇总对象(供脚本消费)
// 口径: trimmedChars 为"折叠+头尾裁剪"从上下文中实际移除的字符总量(不与 collapsedLines 重复计);
// token 估算按 1.5~4 字符/token(中文密集 ~1.5,纯 ASCII ~4,实际多在中间)。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 与 hook 同规则:跟随 CLAUDE_CONFIG_DIR,未设时回退 ~/.claude
const STATE_DIR = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'token-optimizer')
const STATE_FILE = join(STATE_DIR, 'state.json')

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}
function archiveBytes(session) {
  const dir = join(STATE_DIR, 'archive', String(session).replace(/[^\w-]/g, ''))
  let bytes = 0
  let files = 0
  try {
    for (const f of readdirSync(dir)) {
      const st = statSync(join(dir, f))
      if (st.isFile()) { bytes += st.size; files += 1 }
    }
  } catch { /* 无存档目录 */ }
  return { bytes, files }
}

function main() {
  const state = loadState()
  if (!state) { console.error('state.json 不存在或解析失败:' + STATE_FILE); process.exit(1) }
  const stats = state._stats ?? {}
  const sessions = Object.keys(stats).sort()
  const rows = sessions.map((s) => {
    const st = stats[s]
    const arch = archiveBytes(s)
    return { session: s.slice(0, 8), ...st, archiveBytes: arch.bytes, archiveFiles: arch.files }
  })
  const total = rows.reduce((t, r) => ({
    denies: t.denies + r.denies,
    trims: t.trims + r.trims,
    trimmedChars: t.trimmedChars + r.trimmedChars,
    collapsedLines: t.collapsedLines + r.collapsedLines,
    archiveBytes: t.archiveBytes + r.archiveBytes,
  }), { denies: 0, trims: 0, trimmedChars: 0, collapsedLines: 0, archiveBytes: 0 })
  // 省 token 估算:上下界(中文密集 / 纯 ASCII),真实混合内容落在中间
  total.estTokensLo = Math.round(total.trimmedChars / 4)
  total.estTokensHi = Math.round(total.trimmedChars / 1.5)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ sessions: rows, total }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('尚无 _stats 数据(hooks 层还没发生过拦截/裁剪)。')
    return
  }
  console.log('会话      denies  trims  chars 折叠行  存档')
  for (const r of rows) {
    const kb = r.archiveBytes > 0 ? `${(r.archiveBytes / 1024).toFixed(1)}k` : '-'
    console.log(`${r.session}  ${String(r.denies).padStart(4)}  ${String(r.trims).padStart(5)}  ${String(r.trimmedChars).padStart(5)}  ${String(r.collapsedLines).padStart(4)}  ${kb}`)
  }
  console.log('合计      ' +
    `${String(total.denies).padStart(4)}  ${String(total.trims).padStart(5)}  ${String(total.trimmedChars).padStart(5)}  ${String(total.collapsedLines).padStart(4)}  ${(total.archiveBytes / 1024).toFixed(1)}k`)
  console.log(`\n省下约 ${total.estTokensLo}~${total.estTokensHi} token(trimmedChars ${total.trimmedChars} 按 1.5~4 字符/token 折算)` +
    `;readDedup 拦截 ${total.denies} 次;archive 存档 ${total.archiveBytes} 字节未注入上下文。`)
  if (total.denies === 0) console.log('注:denies=0 正常——harness 原生去重已挡掉整文件重读,readDedup 只剩部分重叠区间的活。')
}

main()

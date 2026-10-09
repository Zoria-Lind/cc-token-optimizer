#!/usr/bin/env node
// stats — 汇总 token 优化器的跨会话计数与存档体积,估算累计省下的 token。零依赖、只读、fail-open。
//
// 数据源(v0.2.0 起状态随插件走,不再只写 <配置目录>/token-optimizer/state.json):
//   现役  <配置目录>/plugins/store/cc-token-optimizer*.json 的 'guard-state'(宿主的插件 KV,跨会话)
//   历史  <配置目录>/token-optimizer/state.json(Node 版时代遗留,一并读入)
// 存档体积(两处都算):
//   现役  <插件根>/.archive/<会话>/  历史  <配置目录>/token-optimizer/archive/<会话>/
//
// 用法:
//   node stats.mjs          人类可读汇总(每会话一行 + 总计)
//   node stats.mjs --json   原样输出汇总对象(供脚本消费)
// 口径: trimmedChars 为"折叠+头尾裁剪"从上下文中实际移除的字符总量(不与 collapsedLines 重复计);
// token 估算按 1.5~4 字符/token(中文密集 ~1.5,纯 ASCII ~4,实际多在中间)。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CFG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const LEGACY_STATE = join(CFG_DIR, 'token-optimizer', 'state.json')
const STORE_DIR = join(CFG_DIR, 'plugins', 'store')
const ARCHIVE_DIRS = [
  join(CFG_DIR, 'token-optimizer', 'archive'), // 历史(Node 版)
  fileURLToPath(new URL('../plugin/.archive', import.meta.url)), // 现役(插件目录内)
]
const COUNTERS = ['denies', 'trims', 'trimmedChars', 'collapsedLines']

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

// 把一处 _stats 并入 dst;同一会话出现在多源时计数相加(正常只会有其中一处)
function addStats(dst, src) {
  if (!isObj(src)) return dst
  for (const [session, v] of Object.entries(src)) {
    const cur = dst[session] ?? (dst[session] = { denies: 0, trims: 0, trimmedChars: 0, collapsedLines: 0 })
    for (const k of COUNTERS) cur[k] = (cur[k] ?? 0) + (Number(v?.[k]) || 0)
    if (Number(v?._at)) cur._at = Math.max(cur._at ?? 0, Number(v._at))
  }
  return dst
}

// mod 版状态:宿主的插件 KV 文件,文件名带实例 hash ⇒ 通配匹配;内容是 { key: value } 的 map
function fromStore(dst) {
  let files = []
  try {
    files = readdirSync(STORE_DIR).filter((f) => f.startsWith('cc-token-optimizer') && f.endsWith('.json'))
  } catch { return dst /* 目录还不存在 */ }
  for (const f of files) addStats(dst, readJson(join(STORE_DIR, f))?.['guard-state']?._stats)
  return dst
}

// 存档体积:两处目录按会话 id 累加
function archiveSizes() {
  const out = new Map()
  for (const base of ARCHIVE_DIRS) {
    let dirs = []
    try { dirs = readdirSync(base) } catch { continue }
    for (const d of dirs) {
      let bytes = 0
      try {
        for (const f of readdirSync(join(base, d))) {
          const st = statSync(join(base, d, f))
          if (st.isFile()) bytes += st.size
        }
      } catch { /* 单个会话目录读不动就跳过 */ }
      out.set(d, (out.get(d) ?? 0) + bytes)
    }
  }
  return out
}

function main() {
  const stats = fromStore({})
  addStats(stats, readJson(LEGACY_STATE)?._stats)
  const sizes = archiveSizes()
  const sessions = Object.keys(stats).sort()
  const rows = sessions.map((s) => ({ session: s.slice(0, 8), ...stats[s], archiveBytes: sizes.get(s) ?? 0 }))
  const total = rows.reduce((t, r) => ({
    denies: t.denies + (r.denies ?? 0),
    trims: t.trims + (r.trims ?? 0),
    trimmedChars: t.trimmedChars + (r.trimmedChars ?? 0),
    collapsedLines: t.collapsedLines + (r.collapsedLines ?? 0),
    archiveBytes: t.archiveBytes + (r.archiveBytes ?? 0),
  }), { denies: 0, trims: 0, trimmedChars: 0, collapsedLines: 0, archiveBytes: 0 })
  // 省 token 估算:上下界(中文密集 / 纯 ASCII),真实混合内容落在中间
  total.estTokensLo = Math.round(total.trimmedChars / 4)
  total.estTokensHi = Math.round(total.trimmedChars / 1.5)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      sources: { store: join(STORE_DIR, 'cc-token-optimizer*.json'), legacy: LEGACY_STATE, archives: ARCHIVE_DIRS },
      sessions: rows,
      total,
    }, null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('尚无 _stats 数据(hooks 层还没发生过拦截/裁剪)。\n' +
      `  现役:${
        join(STORE_DIR, 'cc-token-optimizer*.json')} 的 guard-state\n` +
      `  历史:${LEGACY_STATE}`)
    return
  }
  console.log('会话      denies  trims  chars 折叠行  存档')
  for (const r of rows) {
    const kb = r.archiveBytes > 0 ? `${(r.archiveBytes / 1024).toFixed(1)}k` : '-'
    console.log(`${r.session}  ${
      String(r.denies ?? 0).padStart(4)}  ${
      String(r.trims ?? 0).padStart(5)}  ${
      String(r.trimmedChars ?? 0).padStart(5)}  ${
      String(r.collapsedLines ?? 0).padStart(4)}  ${kb}`)
  }
  console.log('合计      ' +
    `${String(total.denies).padStart(4)}  ${String(total.trims).padStart(5)}  ${String(total.trimmedChars).padStart(5)}  ${String(total.collapsedLines).padStart(4)}  ${(total.archiveBytes / 1024).toFixed(1)}k`)
  console.log(`\n省下约 ${total.estTokensLo}~${total.estTokensHi} token(trimmedChars ${total.trimmedChars} 按 1.5~4 字符/token 折算)` +
    `;readDedup 拦截 ${total.denies} 次;archive 存档 ${total.archiveBytes} 字节未注入上下文。`)
  if (total.denies === 0) console.log('注:denies=0 正常——harness 原生去重已挡掉整文件重读,readDedup 只剩部分重叠区间的活。')
}

main()

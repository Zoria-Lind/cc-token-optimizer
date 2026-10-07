#!/usr/bin/env node
// tool-gate — 两档工具裁剪(名单归用户,改 tiers.json):
//   tier1_remove  确认不用的 → 直接移除
//   tier2_hide    偶尔用的 → 移出调用范围,但保留在名单里,enable 一条命令召回
// 两档落点都是 settings.json 的 tools.disabled(CC 没有原生"隐藏组"概念),改完需重启会话生效。
// 用法:
//   node tool-gate.mjs list              只读:两档名单 vs 当前 disabled
//   node tool-gate.mjs apply             两档合并写入 tools.disabled(写前自动备份 settings)
//   node tool-gate.mjs enable <tool...>  召回:移出 disabled(仍需重启)
//   node tool-gate.mjs hide <tool...>    加入 disabled 并记入 tier2
// 铁律:settings.json 解析失败不写;任何写操作先备份(保留最近 3 份)。

import { readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const TIERS_FILE = join(HERE, 'tiers.json')
const SETTINGS_FILE = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
const BACKUP_KEEP = 3

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function backup() {
  try {
    const dir = dirname(SETTINGS_FILE)
    const baks = readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).sort()
    while (baks.length >= BACKUP_KEEP) {
      try { unlinkSync(join(dir, baks.shift())) } catch { break }
    }
    copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak-${Date.now()}`)
    return true
  } catch { return false }
}
function writeSettings(settings) {
  if (!backup()) { console.error('备份 settings.json 失败,不写'); return false }
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
    return true
  } catch { console.error('写 settings.json 失败'); return false }
}

function cmdList() {
  const tiers = readJson(TIERS_FILE) ?? {}
  const settings = readJson(SETTINGS_FILE) ?? {}
  const disabled = settings?.tools?.disabled ?? []
  const tier1 = tiers.tier1_remove ?? []
  const tier2 = tiers.tier2_hide ?? []
  console.log('tier1(移除):', tier1.join(', ') || '(空)')
  console.log('tier2(隐藏,可 enable 召回):', tier2.join(', ') || '(空)')
  console.log('当前 tools.disabled:', disabled.join(', ') || '(空)')
  const pending = [...tier1, ...tier2].filter((t) => !disabled.includes(t))
  console.log(pending.length ? `名单里尚未生效(跑 apply 后重启):${pending.join(', ')}` : '两档名单已全部生效')
}
function cmdApply() {
  const tiers = readJson(TIERS_FILE)
  if (!tiers) { console.error('tiers.json 缺失或解析失败'); process.exit(1) }
  const settings = readJson(SETTINGS_FILE)
  if (!settings) { console.error('settings.json 解析失败,不写'); process.exit(1) }
  settings.tools = settings.tools ?? {}
  const disabled = new Set(settings.tools.disabled ?? [])
  for (const t of [...(tiers.tier1_remove ?? []), ...(tiers.tier2_hide ?? [])]) disabled.add(t)
  settings.tools.disabled = [...disabled].sort()
  if (!writeSettings(settings)) process.exit(1)
  console.log(`已写入 ${settings.tools.disabled.length} 个禁用工具(含原有)。重启会话后生效。`)
}
function cmdEnable(tools) {
  const settings = readJson(SETTINGS_FILE)
  if (!settings) { console.error('settings.json 解析失败,不写'); process.exit(1) }
  settings.tools = settings.tools ?? {}
  const disabled = new Set(settings.tools.disabled ?? [])
  const done = tools.filter((t) => disabled.delete(t))
  if (!done.length) { console.log('这些工具本就不在 disabled 里'); return }
  settings.tools.disabled = [...disabled].sort()
  if (!writeSettings(settings)) process.exit(1)
  console.log(`已召回:${done.join(', ')}。重启会话后生效。`)
}
function cmdHide(tools) {
  const tiers = readJson(TIERS_FILE)
  if (!tiers) { console.error('tiers.json 缺失或解析失败'); process.exit(1) }
  tiers.tier2_hide = [...new Set([...(tiers.tier2_hide ?? []), ...tools])]
  try { writeFileSync(TIERS_FILE, JSON.stringify(tiers, null, 2) + '\n') } catch { console.error('写 tiers.json 失败'); process.exit(1) }
  cmdApply()
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'list') cmdList()
else if (cmd === 'apply') cmdApply()
else if (cmd === 'enable') cmdEnable(rest)
else if (cmd === 'hide') cmdHide(rest)
else console.log('用法: node tool-gate.mjs [list|apply|enable <tool...>|hide <tool...>]')

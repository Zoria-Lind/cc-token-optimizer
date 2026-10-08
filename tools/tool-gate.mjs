#!/usr/bin/env node
// tool-gate — 两档工具裁剪(名单归用户,改 tiers.json):
//   tier1_remove  确认不用的 → 移除
//   tier2_hide    偶尔用的 → 同样移出调用范围,但保留在名单里,enable 一条命令召回
// 机制(2026-10-08 实测定型,取代已证实失效的 settings tools.disabled):
//   落点1 <配置目录>/agents/tool-gate.md 的 disallowedTools —— 主线程工具真实移除(CC 2.1.292 实测)
//   落点2 settings.json 的 "agent": "tool-gate" —— 裸启动/任意目录自动生效,无需改启动方式
//   ⚠ 该 agent 文件由本工具生成,body 必须保持空!非空 prompt 会整个替换默认系统提示(实测)。
//   改完需重启会话生效(agent 于会话启动时解析)。CC 升级后建议用探针复验。
// 用法:
//   node tool-gate.mjs list              只读:两档名单 vs agent 文件 vs settings
//   node tool-gate.mjs apply             两档合并写入 agent 文件 + 确保 settings 的 agent 键 + 清死配置(均先备份)
//   node tool-gate.mjs enable <tool...>  召回:从两档名单与 agent 文件移除(仍需重启)
//   node tool-gate.mjs hide <tool...>    加入 tier2 并生效
// 铁律:任何解析失败不写;写前备份(settings 与 agent 各留最近 3 份)。

import { readFileSync, writeFileSync, copyFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const TIERS_FILE = join(HERE, 'tiers.json')
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')
const AGENT_FILE = join(CONFIG_DIR, 'agents', 'tool-gate.md')
const AGENT_NAME = 'tool-gate'
const BACKUP_KEEP = 3

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}
function backupFile(file) {
  try {
    const dir = dirname(file)
    const base = basename(file)
    const baks = readdirSync(dir).filter((f) => f.startsWith(base + '.bak-')).sort()
    while (baks.length >= BACKUP_KEEP) {
      try { unlinkSync(join(dir, baks.shift())) } catch { break }
    }
    copyFileSync(file, `${file}.bak-${Date.now()}`)
    return true
  } catch { return false }
}
function writeSettings(settings) {
  if (!backupFile(SETTINGS_FILE)) { console.error('备份 settings.json 失败,不写'); return false }
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n')
    return true
  } catch { console.error('写 settings.json 失败'); return false }
}
// agent 文件读写:格式固定生成,body 恒为空
function readAgentTools() {
  try {
    const m = readFileSync(AGENT_FILE, 'utf8').match(/disallowedTools:\s*\[([^\]]*)\]/)
    if (!m) return null
    return m[1].split(',').map((s) => s.trim()).filter(Boolean)
  } catch { return null }
}
function writeAgent(tools) {
  const dir = dirname(AGENT_FILE)
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { console.error(`无法创建 ${dir}`); return false }
  if (existsSync(AGENT_FILE) && !backupFile(AGENT_FILE)) { console.error('备份 agent 文件失败,不写'); return false }
  const body = [
    '---',
    `name: ${AGENT_NAME}`,
    'description: "Tool-gate 工具裁剪:主线程移除所列工具。body 保持空,勿填 prompt(非空会替换默认系统提示)"',
    `disallowedTools: [${tools.join(', ')}]`,
    '---',
    '',
  ].join('\n')
  try { writeFileSync(AGENT_FILE, body); return true } catch { console.error('写 agent 文件失败'); return false }
}
function mergedList(tiers) {
  return [...new Set([...(tiers.tier1_remove ?? []), ...(tiers.tier2_hide ?? [])])].sort()
}

function cmdList() {
  const tiers = readJson(TIERS_FILE) ?? {}
  const settings = readJson(SETTINGS_FILE) ?? {}
  const onDisk = readAgentTools()
  const t1 = tiers.tier1_remove ?? []
  const t2 = tiers.tier2_hide ?? []
  console.log('tier1(移除):', t1.join(', ') || '(空)')
  console.log('tier2(隐藏,可 enable 召回):', t2.join(', ') || '(空)')
  console.log('agent 文件:', onDisk === null ? '(缺失/解析失败)' : onDisk.join(', ') || '(空)')
  console.log('settings.agent:', settings.agent ?? '(未设置)')
  const want = mergedList(tiers)
  const ok = onDisk !== null && want.join() === [...onDisk].sort().join() && settings.agent === AGENT_NAME
  console.log(ok ? '名单已全部生效(改动仍需重启才进会话)' : '⚠ 有漂移:跑 apply 对齐')
}
function cmdApply() {
  const tiers = readJson(TIERS_FILE)
  if (!tiers) { console.error('tiers.json 缺失或解析失败'); process.exit(1) }
  const settings = readJson(SETTINGS_FILE)
  if (!settings) { console.error('settings.json 解析失败,不写'); process.exit(1) }
  const tools = mergedList(tiers)
  if (!writeAgent(tools)) process.exit(1)
  const changed = []
  if (settings.agent !== AGENT_NAME) { settings.agent = AGENT_NAME; changed.push(`agent -> ${AGENT_NAME}`) }
  if (settings.tools?.disabled) {
    const n = settings.tools.disabled.length
    delete settings.tools.disabled
    if (!Object.keys(settings.tools).length) delete settings.tools
    changed.push(`清除失效的 tools.disabled(${n} 条)`)
  }
  if (changed.length) {
    if (!writeSettings(settings)) process.exit(1)
    console.log('settings.json:', changed.join(';'))
  } else {
    console.log('settings.json 无需改动')
  }
  console.log(`agent 文件已写入 ${tools.length} 个工具:${tools.join(', ')}`)
  console.log('重启会话后生效。')
}
function cmdEnable(tools) {
  const tiers = readJson(TIERS_FILE)
  if (!tiers) { console.error('tiers.json 缺失或解析失败'); process.exit(1) }
  const before = [...(tiers.tier1_remove ?? []), ...(tiers.tier2_hide ?? [])]
  const hit = tools.filter((t) => before.includes(t))
  if (!hit.length) { console.log('这些工具本就不在名单里'); return }
  tiers.tier1_remove = (tiers.tier1_remove ?? []).filter((t) => !tools.includes(t))
  tiers.tier2_hide = (tiers.tier2_hide ?? []).filter((t) => !tools.includes(t))
  try { writeFileSync(TIERS_FILE, JSON.stringify(tiers, null, 2) + '\n') } catch { console.error('写 tiers.json 失败'); process.exit(1) }
  console.log(`已召回(移出名单):${hit.join(', ')}`)
  cmdApply()
}
function cmdHide(tools) {
  const tiers = readJson(TIERS_FILE)
  if (!tiers) { console.error('tiers.json 缺失或解析失败'); process.exit(1) }
  tiers.tier1_remove = (tiers.tier1_remove ?? []).filter((t) => !tools.includes(t))
  tiers.tier2_hide = [...new Set([...(tiers.tier2_hide ?? []).filter((t) => !tools.includes(t)), ...tools])]
  try { writeFileSync(TIERS_FILE, JSON.stringify(tiers, null, 2) + '\n') } catch { console.error('写 tiers.json 失败'); process.exit(1) }
  cmdApply()
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'list') cmdList()
else if (cmd === 'apply') cmdApply()
else if (cmd === 'enable') cmdEnable(rest)
else if (cmd === 'hide') cmdHide(rest)
else console.log('用法: node tool-gate.mjs [list|apply|enable <tool...>|hide <tool...>]')

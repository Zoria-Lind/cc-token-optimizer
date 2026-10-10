# cc-token-optimizer

**English** · [中文](README.zh-CN.md)

A Claude Code plugin that cuts what a session actually costs — read de-duplication, output trimming, cache-stall nudges, and a live cost / cache-hit bar above the prompt.

```
/plugin install cc-token-optimizer --marketplace Zoria-Lind/cc-token-optimizer
```

One command to install: no `settings.json` edits, no Node. Claude Code 2.1.275+.

## Modules

| Module | Hook point | What it does |
|---|---|---|
| **readDedup** | `tool.call` Read | Denies a re-read when the file is unchanged (mtime + size) and the requested range is **already fully** in context. Partial overlap **passes** and is merged into the record. Three denials in a row on the same file → always passes (escape hatch). Two things it deliberately does **not** dedup: PDF page-range reads (`pages` says nothing about line ranges) and anything after a compaction (see compactReset). |
| **recordRead** | after that same Read | Stores mtime/size + read ranges (v2 format, bucketed per session / sub-agent, LRU-pruned), keyed by the file's **resolved** path (so `D:\a\b.ts` and `D:/a/b.ts` are one record) and holding the range the tool **actually returned** — a token-capped read is recorded as the page the model really saw, not as what was asked for. |
| **outputTrim** | `PostToolUse` Bash/PowerShell | Folds runs of ≥3 identical lines; if the output is still over 5000 chars, head/tail samples are injected (1500+1500; 800+800 when the command failed). **Whenever anything is folded or trimmed, the full original is archived to disk first** and the archive path is appended to what the model sees. (Archive writes go through the host's `fs.write`, which refuses anything over 4 MiB — a larger output gets trimmed with no archive path.) |
| **coldStartGuard** | `SessionStart` | A resumed session whose prompt cache has expired gets one line: context size, estimated re-cache cost, and "consider `/clear`". |
| **modelDirector** | `SessionStart` · `UserPromptSubmit` · `tool.call` Edit/Write/NotebookEdit · `PreModelSwitch` · `PostModelSwitch` | Tier discipline: mechanical upgrade nudges + an **optional hard gate** + transparent switch cost (see below). |
| **tierFact** | `PostToolUse` Skill | Reads the resolved model out of the Skill tool's own result — the only trustworthy escalation signal against a direct DeepSeek endpoint — and when it is a Pro model records the fact (`_proAt` / `_proEpoch`) and toasts you **at the moment it happens**. Both the cost split and the hard gate read that fact. |
| **compactReset** | `session.compact` | Drops the session's read records at a compaction: the harness clears old tool output out of context when it compacts, so every "you already read this" record is stale from that point on. `trigger: "precompute"` is skipped — it is the one dispatch that installs nothing. |
| **status bar** · `/token-status` | AbovePrompt · slash command | rounds, context size, input + cache read/write, output, cache-hit rate, **cost (peak/off-peak, priced per turn by the model that actually answered — a mixed tier is marked with the Pro portion)**; the command adds a three-way cost breakdown and a per-tier split. |
| **`tools/stats.mjs`** | manual | Sums denials, trims, folded lines and archive size across sessions, and estimates tokens saved. |

## Install

```
/plugin install cc-token-optimizer --marketplace Zoria-Lind/cc-token-optimizer
```

Claude Code 2.1.275+. It asks whether to add the marketplace (`y`), then for a scope — `user` applies it to every session. Nothing else to set up:

- The eight hook modules live in the plugin itself (`plugin/hooks/tokenGuard.ts`) and load with it.
- There are **two** stores, with different lifetimes:
  - The hook layer's `guard-state` (read records, trim counters, tier facts) lives in the host's plugin KV — `<config dir>/plugins/store/cc-token-optimizer*.json` — so it survives across sessions and hot reloads. It is **not** `$.state` (v0.2.0 shipped that mistake; fixed in 0.2.1).
  - The **cost ledger** behind the status bar and `/token-status` (rounds, tokens, the per-tier cost split) lives in `$.state`, which is session-scoped by design: it survives a hot reload, but a new session or `/clear` starts from zero. "¥0.40" means *this session*, not a lifetime total.
- Config is read from the plugin's own `config.json`; a missing or corrupt file falls back to built-in defaults instead of erroring.

Update:

```
/plugin marketplace update zoria-plugins
/plugin update cc-token-optimizer@zoria-plugins
```

## modelDirector: the tier director

The resident tier comes from `defaultTier` in `plugin/config.json`, and the discipline text flips with it:

- **`cheap` (shipped default)**: starts on the cheap model every session; you upgrade when needed and the next session falls back automatically. **The upgrade trigger is deliberately human by default** — if you let the cheap model judge for itself whether to escalate, it cannot see what it is missing, so it hesitates, grinds through work it is bad at, and is not equipped to report "I got worse" (measured the hard way on 2026-10-07).
- **`pro`**: stay on the strong model, delegate legwork to subagents (one less tier switch, more expensive).

Events:

- **`SessionStart`** — records the current model and injects the tier discipline (tier = cheap: "suggest upgrading when unsure" / "switch back when done"; tier = pro: the reverse).
- **`UserPromptSubmit`** — mechanical detection over 19 high-precision coding keywords / file suffixes (see `config.json`; tightened 2026-10-10 from 43: everyday words such as "plan"/"interface"/"design" were removed, so discussing a design no longer misfires). **Prompt length alone never triggers** (pasting a webpage or a log must not cause a false upgrade), plus a **sticky window**: if code was edited recently, follow-up turns within 30 minutes nudge regardless of text. On a hit: ① the model gets a conditional instruction ("if you are not already on the strong tier, call the upgrade skill named in your `/config` before you start"), ② that is all — **no predictive message to you** (removed 2026-10-10: it fired on everyday words such as "plan"/"interface" *and* announced "this turn runs on Pro" at a moment when nothing had switched yet; users reported it as alarming). **Upgrades are driven mechanically, not by model self-assessment** — that is the fix for the self-reference trap.
- **Upgrade notice, fired the moment the escalation happens (2026-10-10)** — the fact comes from the **Skill tool's own result**: when a skill's frontmatter `model:` header takes effect, the engine hands the resolved model back in that result (`tool_response.model`; typed as *"Resolved model the skill turn runs on when a frontmatter model override took effect; omitted otherwise"*). A Pro-tier resolved model means this turn really is running strong, so you get **one** notice right then (cooldown `cooldownMin` per session; never when the session is already permanently Pro; subagent turns and `status:"forked"` skill runs skipped). **This is the only user-facing upgrade notice** — nothing is announced on prediction. ⚠ Why not `turn.complete`'s `usage.model`: against a direct DeepSeek endpoint the engine reports the session's *base* tier there (measured 2026-10-10 — a turn that verifiably ran on `deepseek-v4-pro[1m]` was logged as flash, and all 548 responses of the day were), which made that criterion silently always false. `usage.model` is still OR-ed in for hosts that report it faithfully.
- **Hard gate (`tool.call` on Edit/Write/NotebookEdit, opt-in)** — before the model calls an editing tool it has necessarily already reasoned a turn, so *it deciding to edit code is the coding signal* — the only reliable automatic one when the user said nothing and the model itself is unsure. On the **first code-file modification of a turn** the call is **denied once** (the model must activate your upgrade skill and retry; the rest of the turn then runs on the strong tier — the cost is one extra round trip). Judgement and the edges you will actually hit:
  - **Code files only, by extension.** Besides source files, `.json/.yaml/.toml/.ini/.ps1` and friends **count as code**; **`.md/.txt`-style docs pass** (otherwise editing a README or a memory file would burn a round trip for nothing).
  - **Creating a code file with Write trips it too** — existence is not checked; writing a new `.ts` is still "editing code".
  - **The base-tier read (`$.session.model()`) cannot see a skill's turn-level switch** — so the gate also accepts the escalation fact recorded by the Skill branch above (`_proEpoch`, the `_epoch` value at the moment the skill ran): **a turn that already escalated is no longer denied** (fixed 2026-10-10, and its turn attribution fixed again 2026-10-11 — see the next bullet).
  - **At most once per turn**, deduplicated against the turn boundary `_epoch` (incremented **only** by `turn.complete`; the gate records `_forcedEpoch`) — not by a time cooldown, which would keep re-denying the same edit in a long turn. ⚠ Explicitly **not** by a counter incremented on `UserPromptSubmit`: that event fires **again inside the same turn** (a subagent hand-back arrives as a user-role message), which silently broke the dedup — measured 2026-10-11, the gate denied an edit in a turn that had just escalated.
  - **Subagent edits are never denied.** A delegated edit arrives with an `agentId`; the gate fires only on the main loop's own edits. A subagent already runs on the (usually cheaper) subagent model, while a skill's `model:` header switches the **session turn** — it cannot re-tier a subagent that is already running, so the denial's advice ("call the upgrade skill") is unactionable. Worse, that needless denial would consume the turn's single forced slot, leaving the main loop's own first edit ungated. Subagent edits still stamp the sticky window (`_codingAt`).
  - **No skill name configured → no gate at all.** Denying with no skill to call would only deadlock the model.
- **The upgrade skill** lives at `<config dir>/skills/<your-skill>/SKILL.md`, and its frontmatter `model:` header names the strong model — active for that turn only, falls back next turn, nothing written to disk. **A skill's `model:` header is the only non-user-triggered model switch in Claude Code** (hooks cannot switch the model — confirmed in the docs, measured working on 2026-10-07), which is why the gate can only *ask the model to call a skill*; the plugin itself cannot change tiers.
- **`PreModelSwitch`** — shows the cost of the switch ("dropping the prompt cache, ~80k context, ~¥0.36 to re-cache") so you switch at a task boundary.
- **`PostModelSwitch`** — records the new tier and injects the matching reminder.

## Configuration

`plugin/config.json` is the single source of truth (edit it, never the code): dual pricing tiers (cheap/pro, per million tokens), holidays, model-name mapping, currency prefix, and the upgrade heuristic (keywords, sticky window, cooldown). DeepSeek terms: peak = Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time on non-holidays; **weekends (including make-up weekends) and holidays are off-peak all day**.

**The skill name is a plugin option, not a `config.json` value** (priority: plugin option > `config.json`'s `upgrade.skillName`). Set `upgrade_skill` in `/config`; the value is written to **your own** `settings.json` and survives plugin upgrades. The shipped `config.json` leaves it **blank** ⇒ a stranger installing this is never gated and never has the plugin call a skill they do not have.

**Using a provider other than DeepSeek** — the shipped defaults are DeepSeek's; edit `config.json`:

```json
{
  "pricing": {
    "cheap": { "idle": { "hit": 0, "miss": 0, "out": 0 }, "peak": { "hit": 0, "miss": 0, "out": 0 } },
    "pro":   { "idle": { "hit": 0, "miss": 0, "out": 0 }, "peak": { "hit": 0, "miss": 0, "out": 0 } }
  },
  "models": { "cheap": "your-cheap-model", "pro": "your-strong-model" },
  "currency": "$",
  "upgrade": { "keywords": ["your", "terms"], "cooldownMin": 10, "stickyMin": 30, "skillName": "" }
}
```

- **No peak/off-peak pricing** (most providers): set `peak` equal to `idle`.
- **No cache discount, or a different cache model** (Anthropic itself charges less for cache reads and more for cache writes): set `hit` to 0 or to your real discount; the cost line degrades to a miss+output estimate, still the right order of magnitude.
- **Tier detection** matches `models.pro` exactly (works for any provider); the `includes('pro')` check is only a fallback heuristic for DeepSeek-style names.
- **Currency**: `currency` is the prefix used by the status bar, `/token-status` and the switch-cost estimate — use `"$"` for dollars.
- **Token accounting** is auto-compatible with both conventions: DeepSeek's Anthropic-compatible endpoint reports `input_tokens` **without** cache reads (measured: cacheRead 1.1M with input 3k), Anthropic's includes them. Miss-priced part = `cacheRead > input ? input + cacheCreation : input - cacheRead`; hit part = cacheRead.

## Cache safety

- It acts only at the **birth point** of content — before it enters context. Stored history is never rewritten: changing past bytes invalidates the prompt cache and costs more than it saves.
- Everything is **fail-open**: on any error the plugin steps aside.
- Trimmed output is **archived, not summarized** — the full original goes to disk and the model only sees the path.
- The harness already clears old tool output before compacting; this plugin does not compete with it.

## Honest edges

- **Pricing, model names and the currency symbol default to DeepSeek** (dual peak/off-peak tiers, `currency: "¥"`). Another provider means editing `config.json` — no code changes. Peak/off-peak is evaluated in **Beijing time (UTC+8)** whatever your machine's timezone is, and `holidays` is a China State Council list — outside China, set `peak` equal to `idle` (or keep your own date list).
- **The hard gate's price**: its judgement reads the session's *base* tier, but it also accepts this turn's escalation fact, so **a turn that already escalated is not denied again**; at most once per turn; and it is completely off unless you configure a skill name.
- **The upgrade nudge names a skill**, and a skill's `model:` header is the only way a plugin can switch tiers without you typing `/model`. With no skill name anywhere, the advice degrades to a plain "switch with `/model`".
- **readDedup** compares mtime + size rather than content hashes (a same-second, same-size rewrite is missed), and recent Claude Code builds already answer whole-file re-reads natively — the remaining value is partial-overlap merging and long-span re-reads.
- A denied read or edit costs one failed round while the model retries; hence the 3-strike escape hatch on reads.
- The archive folder **cannot delete anything** — the host's `fs` has no remove API — so eviction writes an empty file over the oldest slot. Archived *content* stays bounded (20 files' worth), but the file *count* grows by one per trim, as zero-byte husks.
- The read records are also keyed by resolved path; a file reached through a junction or hard link that resolves elsewhere is treated as different file from an earlier spelling.
- Status-bar figures are aggregated from `turn.complete`, and `/compact` does not reset the running totals.
- **Costs are priced per turn by the tier that turn actually ran at** — the escalation fact above (engine-reported resolved model, OR `usage.model` where faithful): Pro-served tokens at Pro rates, the rest at the cheap ones, with the Pro portion broken out. Attribution is **turn-level**, so a lifted turn is counted entirely as Pro even though its first requests ran cheap — a deliberate slight over-estimate. Ledgers written before v0.2.5 carry no per-tier split (cheap rates); v0.2.5 and earlier decided the tier from `usage.model`, which on a direct DeepSeek endpoint reads as *always cheap* — don't compare cost figures across either line.
- `config.json`'s `_comment` documents every key's exact semantics, including the caveats above — it ships with the plugin.

## Verify

```sh
claude plugin test plugin      # 58 checks: denial / escape hatch / trimming / folding / hard gate / state isolation / pricing / compaction
claude plugin validate plugin --strict
```

## Links

- [Claude Market](https://www.claudemarket.ai/plugins) — plugin directory

MIT © Zoria Lind.

> The repo also carries the older Node / `settings.json` hook layer (`hooks/token-hook.mjs`) that the plugin was ported from. It is deprecated — everything it did now lives inside the plugin — and is documented only in the [Chinese README](README.zh-CN.md). Do not run both: they handle the same events and would double-count and double-trim.

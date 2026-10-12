# cc-token-optimizer

**English** · [中文](README.zh-CN.md)

[![Listed on ClaudePluginHub](https://www.claudepluginhub.com/badge/zoria-lind-cc-token-optimizer-plugin)](https://www.claudepluginhub.com/plugins/zoria-lind-cc-token-optimizer-plugin)

A Claude Code plugin that cuts what a session actually burns — read de-duplication, output trimming, cache-stall nudges, and a live **token** / cache-hit bar above the prompt. It reports **tokens only**: no cost estimate, deliberately (see *What the numbers mean*).

```
/plugin install cc-token-optimizer --marketplace Zoria-Lind/cc-token-optimizer
```

One command to install: no `settings.json` edits, no Node. Claude Code 2.1.275+ (developed and tested against **2.1.296**).

## Install

It asks whether to add the marketplace (`y`), then for a scope — `user` applies it to every session. Nothing else to set up:

- The eight hook registrations live in the plugin itself (`plugin/hooks/tokenGuard.ts`; the status bar and `/token-status` are registered in `plugin/hooks/register.tsx`), and load with it.
- There are **two** stores, with different lifetimes:
  - The hook layer's `guard-state` (read records, trim counters, tier facts) lives in the host's plugin KV — `<config dir>/plugins/store/cc-token-optimizer*.json` — so it survives across sessions and hot reloads. It is **not** `$.state` (v0.2.0 shipped that mistake; fixed in 0.2.1).
  - The **token ledger** behind the status bar and `/token-status` (rounds, tokens, the last turn's growth) lives in `$.state`, which is session-scoped by design: it survives a hot reload, but a new session or `/clear` starts from zero. Its figures mean *this session*, not a lifetime total.
- Config is read from the plugin's own `config.json`; a missing or corrupt file falls back to built-in defaults instead of erroring.

Update:

```
/plugin marketplace update zoria-plugins
/plugin update cc-token-optimizer@zoria-plugins
```

Turning it off — the `/plugin` manager (disable or uninstall), or from a shell:

```
claude plugin disable cc-token-optimizer
```

Nothing else on your machine is touched: the only things it writes are its own store under `<config dir>/plugins/store/`, and trimmed-output archives inside its own plugin directory (`plugin/.archive/<session>/`).

## Modules

| Module | Hook point | What it does |
|---|---|---|
| **readDedup** | `tool.call` Read | Denies a re-read when the file is unchanged (mtime + size) and the requested range is **already fully** in context. Partial overlap **passes** and is merged into the record. Three denials in a row on the same file → always passes (escape hatch). Two things it deliberately does **not** dedup: PDF page-range reads (`pages` says nothing about line ranges) and anything after a compaction (see compactReset). |
| **recordRead** | after that same Read | Stores mtime/size + read ranges (v2 format, bucketed per session / sub-agent, LRU-pruned), keyed by the file's **resolved** path (so `D:\a\b.ts` and `D:/a/b.ts` are one record) and holding the range the tool **actually returned** — a token-capped read is recorded as the page the model really saw, not as what was asked for. |
| **outputTrim** | `PostToolUse` Bash/PowerShell | Folds runs of ≥3 identical lines; if the output is still over 5000 chars, head/tail samples are injected (1500+1500; 800+800 when the command failed). **Whenever anything is folded or trimmed, the full original is archived to disk first** and the archive path is appended to what the model sees. (Archive writes go through the host's `fs.write`, which refuses anything over 4 MiB — a larger output gets trimmed with no archive path.) |
| **coldStartGuard** | `SessionStart` | A resumed session whose prompt cache has expired gets one line: context size, how many tokens the next request will have to re-read, and "consider `/clear`". |
| **modelDirector** | `SessionStart` · `UserPromptSubmit` · `tool.call` Edit/Write/NotebookEdit · `PreModelSwitch` · `PostModelSwitch` | Tier discipline: mechanical upgrade nudges + an **optional hard gate** + a transparent switch warning, in tokens (see below). All of it is switchable off with `/tier-auto off`. |
| **tierFact** | `PostToolUse` Skill | Reads the resolved model out of the Skill tool's own result — the only trustworthy escalation signal against a direct DeepSeek endpoint — and when it is a Pro model records the fact (`_proAt` / `_proEpoch`) and toasts you **at the moment it happens**. The hard gate reads that fact (0.3.0: nothing else does — cost accounting is gone). |
| **compactReset** | `session.compact` | Drops the session's read records at a compaction: the harness clears old tool output out of context when it compacts, so every "you already read this" record is stale from that point on. `trigger: "precompute"` is skipped — it is the one dispatch that installs nothing. |
| **status bar** · `/token-status` | AbovePrompt · slash command | rounds, context size, input + cache read/write, output, cache-hit rate, **and how much the last turn added (`上轮 +Δ`)**; the command adds the output share and the session window. ⚠ **Session-cumulative, and tokens only — there is no money figure anywhere** (see *What the numbers mean*). |
| **`tools/stats.mjs`** | manual | Sums denials, trims, folded lines and archive size across sessions, and estimates tokens saved. |

## What the numbers mean

Above every prompt — a real one, unedited:

![the status bar above the prompt](docs/bar.png)

The same line as text:

```
[opt] 13轮 · ctx 134k (13%) · 输入 68k + 缓存读 4.2M / 写 0 · 输出 72k · 命中 98.4% · 混合(Pro 1.5M) · 上轮 +268k
```

`/token-status` prints the same ledger, with the breakdown (figures illustrative here):

```
- 轮次: 15(另有 usage 缺失 0 轮、子代理 2 轮,未计入)
- 输入 96k / 缓存读 9.9M / 缓存写 0 / 输出 143k(上轮 +27k)
- 缓存命中率: 99.0%
- 档位构成(token): Pro 1.4M(1 轮)/ 基础档 9.0M(14 轮)
- 自动升档: 开(改代码文件的首次调用会先拦一次)
- 输出占比 2%(输出含思考 token)
- 统计窗口: 会话始于 10-11 02:35 · 首轮于 02:37 · 本实例 register 加载 1 次(未重载)
```

With `/tier-auto off` the bar gains one more mark — `· 升档关` — and that `自动升档` line flips to `**关**`.

The built-in labels are Chinese today (see *Honest edges*). **Tokens only — and that is a deliberate design decision, not a missing feature:**

- **There is no cost figure anywhere, and there will not be one.** Money depends on your provider's billing rules, and those do **not** follow the model name the engine reports. Measured on a gateway that routes per call: in one stretch **9 of 15 calls were billed as Pro while the plugin's own session had escalated exactly zero times**, and the session log recorded *flash* for every one of them — the model that actually served a request is not visible to a plugin at all. A figure derived from those labels was off by **2.5–4×** against a real bill. Tokens, by contrast, are something every provider counts the same way.
- **The per-turn number is the one that changes behaviour.** `上轮 +268k` is what the last turn put into the context — and that content is re-read on **every** request after it. Redirecting a long log to a file or running `/compact` sooner is the lever that shows up in a bill; the bar's ⚠ at ≥50% context is the same nudge.
- **The tier split is counted in tokens, and it is a lower bound.** `混合(Pro 1.5M)` / `档位构成(token)` say how many tokens ran on the strong tier, judged **only from what a plugin can see**: a skill-driven escalation during that turn, or a session whose base tier is already strong. **A gateway that routes calls on its own is invisible here** — measured: the platform billed 6 of 15 calls as Pro in a stretch where this plugin had escalated zero times. Read the Pro share as a floor, not a total.
- **Both surfaces are session-cumulative**: a new session or `/clear` restarts them from zero. The hook layer's counters are a different store and do persist (see *Install*).
- **`缓存写 0` (cache write: 0) is not a bug.** That cell is *cache creation* (`cache_creation_input_tokens`) — how much content was written into the prompt cache — **not output**: output is the cell to its right (`输出 …`), it is always priced, and it is the most expensive line in the table. DeepSeek's price list has exactly three lines — input (cache hit) / input (cache miss) / output — and **no fourth "cache write" line** (writing is not charged separately), so their endpoint does not report that quantity at all. Measured: in one session **all 84 responses** reported `cache_creation_input_tokens: 0` (with the `cache_creation.ephemeral_*` breakdown also all zero) while cache **reads** totalled **9.9M** — had nothing been written, nothing could be read back. Anthropic's own endpoint does charge a cache-write premium and does populate the field.

## modelDirector: the tier director

The resident tier comes from `defaultTier` in `plugin/config.json`, and the discipline text flips with it:

- **`cheap` (shipped default)**: starts on the cheap model every session; you upgrade when needed and the next session falls back automatically. **The upgrade trigger is deliberately human by default** — if you let the cheap model judge for itself whether to escalate, it cannot see what it is missing, so it hesitates, grinds through work it is bad at, and is not equipped to report "I got worse" (measured the hard way on 2026-10-07).
- **`pro`**: stay on the strong model, delegate legwork to subagents (one less tier switch, more expensive).
- **Turning the nudging off — `/tier-auto`** (0.3.0): `/tier-auto off` switches the plugin from *pushing* to *reporting*. The hard gate stops denying, the model-side nudges stop being injected, and the SessionStart text becomes "do not suggest upgrading". What is left is **one toast, fired at exactly the gate's trigger** (the turn's first code-file edit — a signal that cannot false-positive): *"自动升档已关 · 插件本轮不推升档"*. You keep the signal and make the call yourself. `/tier-auto on` restores the default; the setting persists across sessions (it lives in the plugin's own store, not in your config). ⚠ It **never claims "this turn will not upgrade"** — a skill's `model:` header is something the model can call at any time, so the plugin can only promise not to *push*. The same switch shows up as a line in `/token-status`.

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
- **`PreModelSwitch`** — warns what the switch does to the cache ("dropping the prompt cache: ~80k tokens, and the next request re-reads them at the miss price") so you switch at a task boundary.
- **`PostModelSwitch`** — records the new tier and injects the matching reminder.

## Configuration

`plugin/config.json` is the single source of truth (edit it, never the code): the model-name mapping (`models.cheap` / `models.pro`) and the upgrade heuristic (keywords, sticky window, cooldown). **There is no pricing table** — 0.3.0 removed it together with every money display (see *What the numbers mean*).

**The skill name is a plugin option, not a `config.json` value** (priority: plugin option > `config.json`'s `upgrade.skillName`). Set `upgrade_skill` in `/config`; the value is written to **your own** `settings.json` and survives plugin upgrades. The shipped `config.json` leaves it **blank** ⇒ a stranger installing this is never gated and never has the plugin call a skill they do not have.

**Using a provider other than DeepSeek** — point the two model names at whatever you actually run:

```json
{
  "defaultTier": "cheap",
  "models": { "cheap": "your-cheap-model", "pro": "your-strong-model" },
  "upgrade": { "keywords": ["your", "terms"], "cooldownMin": 10, "stickyMin": 30, "skillName": "" }
}
```

- **Model names are the only provider-specific input.** Tier detection matches `models.pro` exactly (works for any provider); the `includes('pro')` check is only a fallback heuristic for DeepSeek-style names. Nothing else in the plugin cares who serves you — that is the point of dropping the price table.
- **Token accounting** is auto-compatible with both conventions: DeepSeek's Anthropic-compatible endpoint reports `input_tokens` **without** cache reads (measured: cacheRead 1.1M with input 3k), Anthropic's includes them. The cache-hit rate normalizes for both.

## Cache safety

- It acts only at the **birth point** of content — before it enters context. Stored history is never rewritten: changing past bytes invalidates the prompt cache and costs more than it saves.
- Everything is **fail-open**: on any error the plugin steps aside.
- Trimmed output is **archived, not summarized** — the full original goes to disk and the model only sees the path.
- The harness already clears old tool output before compacting; this plugin does not compete with it.

## Honest edges

- **The plugin reports tokens, not money — deliberately.** Billing rules belong to your provider, and they do not have to follow the model name the engine reports: on one gateway, **9 of 15 calls in a stretch were billed as Pro while nothing in that session had escalated**, and the log said `flash` for every one of them. Cost figures derived from those labels were off by **2.5–4×** against a real bill, so 0.3.0 removed them outright. Your bill is the only source of truth for money; this plugin's job is to keep the token counts honest.
- **The hard gate's price**: its judgement reads the session's *base* tier, but it also accepts this turn's escalation fact, so **a turn that already escalated is not denied again**; at most once per turn; and it is completely off unless you configure a skill name.
- **`/tier-auto off` silences the plugin, not the model.** The gate and the nudges stop; a `model:`-header skill can still be called (by you or by the model), and nothing is watching whether a coding turn is running on the cheap tier. That was the gate's whole job — with the switch off you are doing it yourself.
- **The upgrade nudge names a skill**, and a skill's `model:` header is the only way a plugin can switch tiers without you typing `/model`. With no skill name anywhere, the advice degrades to a plain "switch with `/model`".
- **readDedup** compares mtime + size rather than content hashes (a same-second, same-size rewrite is missed), and recent Claude Code builds already answer whole-file re-reads natively — the remaining value is partial-overlap merging and long-span re-reads.
- A denied read or edit costs one failed round while the model retries; hence the 3-strike escape hatch on reads.
- The archive folder **cannot delete anything** — the host's `fs` has no remove API — so eviction writes an empty file over the oldest slot. Archived *content* stays bounded (20 files' worth), but the file *count* grows by one per trim, as zero-byte husks.
- The read records are also keyed by resolved path; a file reached through a junction or hard link that resolves elsewhere is treated as different file from an earlier spelling.
- Status-bar figures are aggregated from `turn.complete`, and `/compact` does not reset the running totals.
- Ledgers written by 0.2.x still carry cost fields; 0.3.0 neither reads nor writes them. The token counters (`turns` / `input` / `cacheRead` / `output`) are unaffected, so there is nothing to migrate.
- **A "turn" is whatever the engine says it is.** An async subagent splits one of your messages into **two** engine turns — the delegation closing one, the hand-back opening the next — so the round count can exceed the number of messages you sent. Not a bug: verified against the engine's own `turn_duration` records (which is also where a turn's wall-clock length comes from).
- The plugin's **own status strings are Chinese-only** today (`轮次`, `上轮 +`, the trim notices), even though this README is bilingual. Model names are config-driven; the labels themselves are not localized yet.
- `config.json`'s `_comment` documents every key's exact semantics, including the caveats above — it ships with the plugin.

## Verify

```sh
claude plugin test plugin      # 60 checks: denial / escape hatch / trimming / folding / hard gate / tier switch + token tier split / state isolation / ledger / compaction
claude plugin validate plugin --strict
```

## Links

- [Claude Market](https://www.claudemarket.ai/plugins) — plugin directory ([cc-token-optimizer entry](https://www.claudemarket.ai/plugins/zoria-lind-cc-token-optimizer/cc-token-optimizer))
- [Claude Plugin Hub](https://www.claudepluginhub.com/plugins/zoria-lind-cc-token-optimizer-plugin) — plugin directory (verified listing)

Issues and pull requests are welcome.

MIT © Zoria Lind.

> The repo also carries the older Node / `settings.json` hook layer (`hooks/token-hook.mjs`) that the plugin was ported from. It is deprecated — everything it did now lives inside the plugin, and it is also the only file left that still contains a price table (the plugin itself has none since 0.3.0) — and is documented only in the [Chinese README](README.zh-CN.md). Do not run both: they handle the same events and would double-count and double-trim.

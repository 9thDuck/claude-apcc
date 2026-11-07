> Historical record at commit 7f31302; most findings below were fixed later; some were accepted, see README Honest limits.

33 claims probed / 30 holding / 3 failing

Repo `claude-apcc` @ 7f31302, Node v24.20.0, Linux. Every claim was exercised by launching the real
`node hooks/apcc.mjs <event>` as a separate process with JSON on stdin and an isolated HOME,
CLAUDE_CONFIG_DIR, APCC_CC_STATE_DIR and CLAUDE_PROJECT_DIR. Full command/stdin/stdout/stderr/exit
evidence is in `log.md`; raw results are `results-*.json`. The installer was run only with an isolated
`CLAUDE_CONFIG_DIR` / `--project` cwd. No file under `hooks/`, `scripts/` or `README.md` was modified
(`git status` clean).

"Failing" below means the literal README wording is contradicted by a probe; in all three cases the
behaviour is deliberate or an edge, not a broken core loop.

## Claim → evidence → holds?

| # | Claim (README) | Probe evidence (see log.md) | Holds? |
|---|---|---|---|
| 1 | Zero deps; one file `hooks/apcc.mjs`; Node 18+ | `package.json` has no dependencies/devDependencies, `engines.node >=18`; hook imports only `node:fs/os/path/crypto`; only `hooks/apcc.mjs` is the runtime | Yes* (only Node 24 executed; 18+ is inspection) |
| 2 | `nudge` injects ONE directive past threshold, one final reminder if ignored, subagents skipped | C2 series: 40k silent; 110k nudge1; immediate +14k backoff; 126k nudge2; 170k silent; subagent silent, main session nudges; 10-min re-arm triggered by stored timestamp | Yes |
| 3 | `gate` blocks ordinary tools once ignored near compaction; persist writes / read-only bd / allowlist pass; bounded, never deadlocks | C3: ordinary `ls` denied; Read/Grep/Glob/TaskOutput allowed; Write to `.opencode/context`, `bd note`, index.md allowed and unlock; 4 denials then release outside hard zone; hard zone keeps denying but persist write still allowed | Yes |
| 4 | `stop` recognises an end-anchored `PERSISTED: <n> units` line and records it | C4: 3 units, manual, singular, lowercase, trailing text, trailing blanks, unicode all recorded; "not yet" mention, `none`, `0 units`, unbalanced fence ignored; below-threshold records silently | Yes |
| 5 | `precompact` records honest status and writes **every** user message **verbatim**; never blocks | C5: status `NOT DONE` at 110k, `tokensBefore=110000`, exit 0, no block output; words file written. But identical duplicate dropped, `<system-reminder>` stripped, command turn rewritten `/model opus`, meta/summary/sidechain/noise dropped | No* (filtering/dedup; see surprises) |
| 6 | `restore` after compact/clear injects a recovery contract with status, index tail, user-words pointer | C6 compact: full contract + verbatim newest messages + index tail + user-words path; clear with index file: contract; resume expired warns. Clear on a beads-only project with no index.md and no words file: silent | No* (clear with nothing to recover injects nothing) |
| 7 | State per session, user-level `~/.local/state/apcc-cc`, under a lock | C7: default state created at `$HOME/.local/state/apcc-cc`; C22 relocates; 8 concurrent nudge processes → exactly 1 non-empty stdout; no `.lock` left behind | Yes |
| 8 | Compaction point learned from real compactions | C8: three auto `compact_boundary` samples (pre=100k, window=180k) lowered threshold 132k→90k (95k then nudged); samples from a 200k window did not move the 180k threshold | Yes |
| 9 | Hooks cannot trigger `/compact` | No `node:child_process` import/usage in the hook; the stop message itself says "hooks cannot run /compact" | Yes |
| 10 | Acts only in `.beads/` or `.opencode/context/` projects; others silent | C10: plain project nudge/gate/restore all silent exit 0; beads and context projects act | Yes |
| 11 | Persist is an instruction the model can ignore | Nudge text is a plain additionalContext; nothing forces a persist until the gate; observed behavior consistent with the stated limit | Yes (not falsifiable directly) |
| 12 | `install.mjs` installs `~/.claude`; `--project` installs `./.claude` | H1/H10: both create six hook events plus the hook copy; CLAUDE_CONFIG_DIR honoured | Yes |
| 13 | Flags `--window`, `--dry-run`, `--uninstall` | H4 dry-run writes nothing; H11 `--window 40000` exit 2; H11b 250000 stored; H5 uninstall removes hooks + dir | Yes |
| 14 | Installer idempotent; **only touches its own** hook entries; keeps other hooks/settings | H2 content idempotent (1 entry per event); H3 preserved model/permissions/other hook/window. But a third-party hook whose command merely contains `claude-apcc` was stripped, and key order changes between runs | No* (over-broad `ours()` substring match) |
| 15 | Refuses to overwrite an unparseable settings.json (backup + exit) | H7 invalid JSON: backup created, original unchanged, exit 1; H8 `null` and array same | Yes |
| 16 | Prepare project with `mkdir -p .opencode/context` (or beads) | Context-created and beads-created projects both become tracked and act | Yes |
| 17 | Installer sets `autoCompactWindow: 180000` unless present; threshold derived from window | H1 sets 180000; H3 keeps 200000; C24 window 180k → threshold 132k, nudge at 133k not 130k | Yes |
| 18 | `APCC_CC=0` kill switch | C18: `0` and `false` silent; control `1` nudges | Yes |
| 19 | `APCC_PERSIST_THRESHOLD_TOKENS` override (`100k`) | C19: `100k`, `0.1m`, `100000` all nudge at 105k; `abc`/`0` ignored and fall back | Yes |
| 20 | `APCC_GATE_ALLOW_TOOLS` comma prefixes | C20: `mcp__chat__` prefix allowed, unlisted denied, second item of `a,b` allowed, spaces trimmed | Yes |
| 21 | `APCC_MARKER_TOOLS` (default `post_message`) | C21: default `mcp__chat__post_message` text ending in PERSISTED records and opens the gate; custom `send_reply` accepted | Yes |
| 22 | `APCC_CC_STATE_DIR` relocates state | C22: state written to the alternate dir, base state untouched | Yes |
| 23 | `APCC_CC_REMOTE_ONLY=1` acts only in cloud sessions | C23: silent without `CLAUDE_CODE_REMOTE=true`; acts with it; silent with `false` | Yes |
| 24 | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` place the threshold | C24: window 180k→132k; pct 80→113k (nudge at 114k, silent at 112k); `settings.json autoCompactWindow` used; pct 150/-5/0/100/junk ignored | Yes |
| 25 | With `.beads/`, directives use `bd note`/`bd create`, recovery re-reads beads | C5 beads nudge names `bd note`/`bd create`; C6 recovery names `bd show` parent/children | Yes |
| 26 | Without `.beads/`, routes via session-notes.md/index.md and never mentions `bd` | C26: no-beads nudge names session-notes/index and no `bd`; recovery no `bd`, contract present | Yes |
| 27 | Gate allows only read-only bd (`show list ready prime history search count stats blocked children`), no chaining/redirects | C27b hard zone: all 10 allowed (also leading/double spaces); `;`, `&&`, `|`, `>`, `>>`, `<`, backticks, `$()`, `&`, newline, `2>/dev/null`, `bd export`, `bd delete`, `bd update`, `cd &&`, `sudo` all denied. One deliberate exception: `bd show ... 2>&1 \| head` allowed | Yes* (explicit pipe exception) |
| 28 | Gate denies `bd update --notes` (history overwrite) | C28: literal, `=`, `bash -c`, `sh -lc`, `eval`, `bash <<EOF`, bare flag all denied at any context size; `--append-notes` passes. Bypassed by `$FLAG` indirection and `--not\<newline>es` when the gate is not engaged | Yes* (obfuscation bypass) |
| 29 | Fail-open, never fail-silent; missing file quiet; other error → stderr + exit 1; never exit 2 | G: missing transcript quiet; garbage stdin exit 1; JSON `null` exit 1; transcript-is-directory exit 1; corrupt state stderr exit 0; read-only state dir stderr exit 1; no probe ever exited 2 | Yes* (corrupt state exits 0) |
| 30 | `npm test` runs the suite | `node --test hooks/apcc.test.mjs` (the exact package script; `npm test` itself was denied by the harness): all pass, 0 fail | Yes |
| 31 | `verify.mjs` runs the real hook sandboxed, PASS/FAIL + evidence, checks the listed set | exit 0, all PASS, sandbox `/tmp/apcc-verify-hfVTzf`; checks match the listed set; no real settings/state touched | Yes |
| 32 | `install.mjs --uninstall` | H5 removes all six own entries, keeps other hook and window, deletes hook dir. H6 on a config with no settings.json: exit 1 with ENOENT stack | Yes* (edge failure) |

## Surprises

1. **The gate's command filter is a substring test, so destructive commands that mention the persist paths pass while the gate is engaged.** In the hard zone (cap cannot release): `rm -rf .opencode/context/`, `git checkout -- .opencode/context/`, `git clean -fd .opencode/context/`, `mv .opencode/context/ /tmp/gone`, `curl … -o .opencode/context/x`, `rm -rf docs/research/` were all allowed; the same commands without the trailing slash were denied. The same applies to `bd note|create|remember`: `bd note p-1 --stdin && rm -rf /tmp/x` and `bd show p-1 && bd note p-2 --stdin` were allowed.
2. **`bd update --notes` protection is bypassable by shell indirection.** `bd update p-1 $NOTES_FLAG`, `FLAG=--notes; bd update p-1 $FLAG`, `NOTES=--notes bd update p-1 $NOTES`, and `bd update p-1 --not\<newline>es x` were not denied at low context. Inside the gate's hard zone those commands are still denied as ordinary work, so the protection is weakest exactly where it is least needed.
3. **The installer's "ours" matcher is the substring `claude-apcc` in the command.** An unrelated third-party hook `echo my-claude-apcc-log-line` was silently removed by the install (H3 `kept=false`).
4. **The installer is content-idempotent but not byte-idempotent.** Second run produces the same entries but the JSON key order changes (`hooks` is deleted and re-added after `autoCompactWindow`).
5. **`--uninstall` on a config with no `settings.json` crashes** (ENOENT stack, exit 1) instead of no-op or creating a clean empty file.
6. **The gate only blocks four denials when `compactAt` is unknown** (no autoCompactWindow/`CLAUDE_CODE_AUTO_COMPACT_WINDOW`): after 4 denies it allows ordinary tools permanently. In the hard zone (window known) the cap does not release. So the gate's "block until saved" strength depends on the window setting.
7. **`bd show … 2>&1 | head` is deliberately allowed** even though the claim says "no chaining or redirects".
8. **PreCompact dedups identical user text and strips `<system-reminder>` blocks; command turns become `/cmd args`; meta/compact-summary/sidechain/tool-output noise is dropped.** The saved file is honest but not "every message verbatim".
9. **Corrupt state prints a warning but exits 0**, not 1: `loadState` treats it as recoverable.
10. **`/clear` recovery depends on the newest user-words file.** With real UUID session ids the fallback works and points at the file; with a hyphenated non-UUID id the prefix match fails and a clear can be completely silent. Real Claude Code session ids are UUIDs, so this is latent.
11. **A past-window warning can be merged into the same hook result as the nudge** (two messages from one call), and it fires only once per epoch.
12. **`isTracked` uses `fs.existsSync`, so a `.beads` regular file (not directory) also qualifies** — noticed by code read, not probed.
13. **The nudge tells the model to "ensure `.opencode/` is gitignored first" but the hook never checks it**; persisting can create files the repo tracks.

## What looks wrong that nobody asked about

- The gate's security boundary is string-matching a single shell command. It prevents accidental chaining past `bd show`, but it does not distinguish a persist write from a destructive command aimed at the persist directory. Since `.opencode/` is often gitignored, `rm -rf .opencode/context/` through the gate can destroy the only copy of in-flight state at the precise moment the tool exists to protect it.
- The whole "block until persisted" story is meaningfully weaker when `autoCompactWindow` is not configured: the 4-denial release makes the gate advisory, while the README's recommended install sets the window. Users who already have a window but never run the installer get the weak mode.
- The recovery contract points at an absolute path under the user-level state directory. Copying the project to another machine, or a different `HOME`, loses the verbatim words even though the project files travel.
- Dedup by exact text (for both user words and checkpoint state) silently merges a later repeated instruction with the earlier one; the timestamp of the later repetition is lost.
- State files have no schema/version field; the code special-cases one legacy scalar (`learnedReserve`). A future format change has no migration hook.
- The lock falls through to `fn()` unlocked after ~1 second (`40 × 25 ms`). Under a slow filesystem two hooks could both nudge; only 8 fast concurrent runs were exercised.
- `parseMarker` only rejects an odd fence count. A reply whose last non-empty line is a marker inside an otherwise balanced fence after a quoted block is accepted; the heuristic is reasonable but not a parser.

## Untested ways this could still break

- Only Node 24.20.0 was executed. Node 18/20 compatibility is inspection only (ESM, `Atomics.wait`, `crypto.createHash`, optional chaining all look fine, but not run).
- No real Claude Code host was involved. All payloads are synthetic: the actual `hook_event_name`/`tool_name` strings, `transcript_path`, `cwd`, `agent_id`, `source`, `prompt_cache_likely_expired`, `context_tokens`, and whether Claude Code honors `additionalContext`/`permissionDecision`/`systemMessage` were not observed. A schema mismatch in the host would invalidate every claim at once.
- No real host compaction was observed. Learning was driven by synthetic `compact_boundary` lines; the token meter was fed synthetic `usage` objects, not real `cache_read_input_tokens`/`cache_creation_input_tokens`/sidechain records.
- The 10-minute re-arm was simulated by rewriting `lastNudgeAt`; real elapsed time, clock jumps, DST and a system clock moving backwards are untested.
- The lock's unlocked-fallback path (lock held >1 s) was not triggered; only fast concurrent runs.
- Linux only. Case-insensitive macOS/Windows paths, `fs.renameSync` across filesystems, path separators in the `PERSIST_DEST` regex, and symlinked/relative `CLAUDE_PROJECT_DIR` (state hash depends on the exact string) are untested.
- A single transcript JSON line larger than the 600 KB tail read was not tested; only a torn first line. A giant tool-result line could hide the last assistant usage from the meter.
- Non-numeric `usage` fields (strings, nulls, negative values) were not tested; `input_tokens` as a string would concatenate rather than sum.
- Invalid UTF-8, lone surrogates, and extremely long paths in the transcript or project dir were not tested; only valid unicode text/session ids.
- Installer shapes not tested: hooks arrays containing non-object entries, `matcher` fields, `hooks` as a non-array, concurrent installs while a live session reads settings.json, and npm-installed path layouts.
- `APCC_MARKER_TOOLS` on a tool whose `text` is non-string, huge, or an array was not tested.
- MCP tools whose payload carries the reply outside `tool_input.text` (e.g. nested content blocks) were not tested; the marker would be missed.
- Kill-switch values other than `"0"`/`"false"` (e.g. `"no"`, empty string) are not documented as switches and were not tested.
- `npm test` was not invoked through npm itself (harness denied it); the package's exact `node --test` command was used, so npm-specific lifecycle behavior is untested.
- `verify.mjs` interrupt/failure cleanup was not tested; only the success path ran to completion.

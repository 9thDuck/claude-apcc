# Reference

Detail behind the [README](../README.md): hooks, configuration, limits and checks.

## What it does

| Hook | Handler | Behaviour |
|---|---|---|
| `UserPromptSubmit`, `PostToolUse` | `nudge` | When the main conversation crosses a threshold *before* the host compacts, inject one "persist now" directive (a single final reminder only if it was ignored). Subagents are skipped. |
| `PreToolUse` | `gate` | If the nudge was ignored and you are close to the compaction point, block ordinary work tools until the state is saved. Persist writes, read-only `bd` queries and `git status`/`git diff`/`git log`, creating `.opencode/context`, editing `.gitignore`, and anything in `APCC_GATE_ALLOW_TOOLS` always pass. Bounded: it can never deadlock a session. |
| `Stop` | `stop` | Recognises an end-anchored `PERSISTED: <n> units` line (or the manual `PERSISTED (manual): <n> units` form) in the reply and records it. |
| `PreCompact` | `precompact` | Records the honest persist status and writes your messages **verbatim** to a file, mode `0600` (exact duplicates are merged; `<system-reminder>` blocks and tool/summary noise are dropped; slash-command turns are kept as `/cmd args`). Never blocks compaction. |
| `SessionStart` | `restore` | After compact (always), and after `/clear` only when there is an index tail or a user-words file to restore, injects a recovery contract: what was persisted, the tail of your context index, and a pointer to the verbatim user-words file. The words file is written at compaction, so after `/clear` it holds what you typed up to the last compaction, not everything since: if exactly one of this project's user-words files was active in the last 15 minutes it is offered for context only; otherwise none is named. At `startup` only, also emits the once-per-session notices (a missing `autoCompactWindow`, or `.beads/` without `bd` on PATH) as one `systemMessage`. |

State is kept per session, user-level (`~/.local/state/apcc-cc`), under a lock. The compaction point is learned from your real compactions, since the host compacts *below* the configured window.

## The skill

`skills/persisting-context/SKILL.md` teaches the persist format: where state goes, what one unit is, the `PERSISTED:` marker and the recovery order. The hook names it in every nudge and recovery message, with the right name for how apcc is installed:

- **plugin:** `apcc:persisting-context` (components are namespaced under the plugin name)
- **script install:** `persisting-context` (copied into your skills directory)

Both installs ship the same file; there is one source in the repo.

## Why `autoCompactWindow`?

On 1M-token models the default compaction point is far past any sensible persist threshold. The script installer sets `autoCompactWindow: 180000` unless you already have a value; the persist threshold is derived from that window. The plugin cannot set it, so it shows the once-per-session hint above instead and the door stays open for you to choose the value.

## Configuration (environment)

| Variable | Meaning |
|---|---|
| `APCC_CC=0` | Kill switch (`0` or `false` exactly). It also silences the startup notices. |
| `APCC_PERSIST_THRESHOLD_TOKENS` | Override the persist threshold (e.g. `100k`). |
| `APCC_GATE_ALLOW_TOOLS` | Comma list of tool-name prefixes the gate never blocks, e.g. `mcp__slack__` when that is your only way to reach the user. |
| `APCC_MARKER_TOOLS` | Comma list of tools whose `text` argument is a reply that may end in `PERSISTED:` (default `post_message`). |
| `APCC_CC_STATE_DIR` | Relocate state. |
| `APCC_CC_REMOTE_ONLY=1` | Act only in cloud sessions. |
| `APCC_CC_UNTRACKED=0` | Total silence in projects with no `.opencode/context/` or `.beads/` (no startup line, no words copy). |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Read from Claude Code's own settings to place the threshold. |

## Beads is optional

apcc works without any tracker. A project is tracked when it has `.opencode/context/` or a `.beads/` directory; when `.beads/` exists but `bd` is not on the hook process's PATH, every message routes to `.opencode/context` instead.

With beads usable, the directives use `bd note` / `bd create` and recovery re-reads beads first. Without it, everything routes through `.opencode/context/session-notes.md` and `index.md`, and `bd` is never mentioned; if `.beads/` exists but `bd` is not on PATH, the startup message says so once (the hook process's PATH can differ from your shell's). The gate allows only read-only `bd` commands (`show list ready prime history search count stats blocked children`), no chaining or redirects (the one exception is a trailing `2>&1 | head` or `tail`), and denies `bd update --notes` because it overwrites a bead's history.

For beads itself, use the upstream plugin (optional):

```text
/plugin marketplace add steveyegge/beads
/plugin install beads@beads-marketplace
```

or install `bd` yourself. Note that both plugins inject context at SessionStart and PreCompact (upstream runs `bd prime`, apcc runs its recovery): correct, but two blocks of context.

## Honest limits

- These limits are deliberate. Independent verification passes (`docs/verification/`) found more issues than were fixed in place: most findings were fixed later, and some are accepted and listed here. The pass documents are historical records.

- A `PERSISTED: n units` claim reads as done only when apcc saw a persist write in this context. Counted: a Write or Edit of any size under `.opencode/context/` or `docs/research/`; a Bash `echo`, `printf`, `cat <<EOF` or `{ echo; echo; }` group redirected into those dirs, optionally followed by a plain read-back (`&& tail notes`, a following `cat notes`); a python or node one-liner that writes a path there; `bd note`, `create`, `remember`, `update --append-notes`. A write made just before the first nudge counts; after a delta nudge (the window is nearly full again) the claim needs a write made after that nudge. Not counted: output of another command redirected into the dirs, `cat file >>`, `tee`, and writes from an earlier cycle. A subagent's writes in the same project count, but a `PERSISTED:` line in a subagent's reply is ignored. This checks that something was saved, not that it is good: `echo . >> .opencode/context/index.md` still counts. Limits: a command that starts with `cd <persist dir> &&` or uses `$VAR`/`~` paths is refused (use Write, or a relative path); notes written through an MCP tool (for example a beads MCP server) are not recognised, so write the index line from the main thread too; a write is recorded when attempted, so one the user rejects or that fails still counts.
- Hooks **cannot trigger `/compact`**. apcc makes the model persist *before* the host compacts, and restores *after*. It does not compact for you.
- The plugin install path was checked with `claude plugin validate . --strict` (CI), a synthetic exec-form harness (paths with a space and a symlink), and an install from GitHub into a scratch Claude Code config (2026-11-07). Live Claude Code sessions on Haiku ran the same hook through the script-install route, not through a plugin install: three in 2026-11-05/06, and one on 2026-11-08 (150k window, a 30-file read task, seven host auto-compactions at ~118-125k tokens) in which the model persisted in response to the nudges, restore ran after every compaction, and the constraint and answer survived. A live session through the plugin install itself has not been run. Raw logs are not in the repo. The script install is the fallback.
- Exec-form plugin hooks (`command` + `args`) need a recent Claude Code; the exact minimum version is unknown. On old CLIs the plugin hooks may fail to parse; use the script install.
- Managed organisations that set `allowManagedHooksOnly` may block plugin hooks (check your org policy); if they do, the plugin silently does nothing there, so use the script install instead.
- It only acts in projects that have somewhere to persist to: `.opencode/context/` or a `.beads/` directory. Any other project gets only the startup line, and no work state is saved; only your messages are copied to the state dir at compaction. The one exception is the script installer, which sets `autoCompactWindow` (default 180000) in your user settings when none is set; that applies to every session, including untracked projects and 1M-context models.
- The gate is a best-effort guard, not a sandbox. It string-matches one shell command: it blocks destructive commands aimed at the persist paths, but shell indirection (`$VAR` flags, line continuations) can defeat the `bd update --notes` deny. It exists to stop accidents.
- The gate looks at command text, so it can be fooled on purpose: a persist token inside quoted data or a comment (`echo 'bd note' >> ~/.bashrc`), a script that does the deleting (`python evil.py .opencode/context/`), encoded payloads, and verbs it does not know. Its quote reading is simpler than bash's, so crafted quoting (`$'...'` escapes, an apostrophe in a `#` comment, a heredoc delimiter written as `'E'OF`) can hide a command from the destructive check, and a truncating redirect (`echo x > file && echo y >> notes`) is not seen. Plain chaining after a real persist command (`bd note x && npm publish`) also passes. Independent testing found these; they are accepted because the gate guards against accidents, not a hostile model.
- Gate strength depends on knowing your compaction window. Without `autoCompactWindow` (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) the gate releases after 4 denials; with it, the gate stays engaged close to the compaction point. The script installer sets the window; the plugin only suggests it. `Read`, `Grep`, `Glob`, `TaskOutput`, `Skill`, `AskUserQuestion`, `TodoWrite`, `ToolSearch`, `ExitPlanMode`, `KillShell` and `TaskStop` are never gated, nor are plain `pwd`, `ls` and `cat`, `mkdir -p` of the persist dirs, and the skill's `.gitignore` setup; `Agent` and `WebFetch` are gated. After each persist in the same context the quiet span before the next nudge doubles (up to 8x of 12k tokens), so an obedient model is not interrupted every 12k tokens. `bd update --notes` (which replaces a bead's notes) is denied always, not only near compaction.
- The context meter reads the last 600 KB of the transcript; if the newest single line is larger than that, no reading is taken until the next turn.
- The user-words file lives in the user-level state directory, so it does not travel if you move the project to another machine. It holds every typed message verbatim, so treat the state directory as sensitive: it is created `0700` with `0600` files, and user-words files older than 30 days are pruned; delete the directory to remove them sooner.
- The plugin and the script install store state in the same place, but running both at once is refused by the installer and stood down by the plugin.
- `node` must be on PATH for either install; the plugin cannot enforce its `engines` field, and without it the hooks fail and apcc does nothing. `bd` is a documented prerequisite: the plugin cannot check it either (without it apcc uses the plain-files route), and the script installer refuses without it unless `--force`.
- Developed and tested on Linux only, with synthetic hook payloads (CI runs Node 18/20/22) and a few live Haiku sessions. The plugin manifest is validated in CI. Not checked on macOS or Windows, or against every Claude Code release.
- The persist step is an instruction to the model. A model can ignore it; the gate and the recovery contract exist to make that costly and recoverable, not impossible.

## Failure behaviour

Fail-open, never fail-silent: a missing file is quiet; an unexpected error is printed on stderr and the hook exits `1` (non-blocking). A corrupt state file is reported on stderr and rebuilt (exit 0). It never exits `2`, which would block every tool call.

## Verify it yourself

```bash
npm test                          # unit and e2e tests (scripts/test.mjs lists the files explicitly)
node scripts/verify.mjs           # end-to-end checks, real hook as separate processes, in a sandbox
node scripts/verify.mjs --plugin  # + plugin checks: hooks.json run in exec form from a space + symlink path
npx -y @anthropic-ai/claude-code@2.1.295 plugin validate . --strict
```

`verify.mjs` never touches your real settings or state. It checks nudge-once, backoff, gate deny/allow, bd read-only passthrough, chained-command rejection, notes-overwrite deny, persist marker recording, user-words capture, recovery text with and without beads, the `.beads/`-without-`bd` route and its startup notice, scope (untracked project, subagent, kill switch), and corrupt-state / garbage-stdin behaviour. The plugin mode reads `hooks/hooks.json`, expands `${CLAUDE_PLUGIN_ROOT}`, and spawns every entry exactly as the host does.

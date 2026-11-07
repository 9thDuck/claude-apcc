# claude-apcc

**Persist → gate → restore.** A set of [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) that stop long sessions from silently losing work, decisions and your own instructions when the context window compacts.

Zero dependencies. One file (`hooks/apcc.mjs`), Node 18+. Ships as a Claude Code **plugin** and as a **script installer** for managed or older installs.

Use at your own risk and judgement; the author is not liable for any loss or damage ([details](#use-at-your-own-risk)).

## Install

### As a plugin (recommended)

In Claude Code:

```text
/plugin marketplace add 9thDuck/claude-apcc
/plugin install apcc@apcc
```

Or in one step on a recent Claude Code version:

```text
/plugin install apcc --marketplace 9thDuck/claude-apcc
```

Then restart, or run `/reload-plugins`.

To update later:

```text
/plugin marketplace update apcc
/reload-plugins
```

The plugin cannot set `autoCompactWindow` (a plugin's settings carry no such key). At **session startup, once per session** (not on resume, `/clear` or after compaction), apcc prints a hint when no window is visible in `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, the user settings, the project settings or the project-local settings. In a project with neither `.opencode/context/` nor `.beads/`, this hint is not shown (apcc prints its own idle line instead); see [Prepare a project](#prepare-a-project). Add it yourself:

```json
{ "autoCompactWindow": 180000 }
```

in `~/.claude/settings.json` (or `.claude/settings.json` in a project). apcc never edits your settings. The hint says "not found", not "not set": managed settings and `--settings` cannot be read from a hook.

State lives in `~/.local/state/apcc-cc` (or `APCC_CC_STATE_DIR`). It survives a plugin uninstall, so a reinstall keeps the persisted state; delete that directory to start clean. The directory is created `0700` and its files `0600`; user-words files older than 30 days are deleted with the same sweep as session state.

### As a script install (fallback)

Use this on an older CLI, where plugin hooks are blocked, or where you prefer settings entries you can read:

```bash
git clone https://github.com/9thDuck/claude-apcc ~/claude-apcc
node ~/claude-apcc/scripts/install.mjs            # all projects (~/.claude)
cd /path/to/your/project
node ~/claude-apcc/scripts/install.mjs --project  # only this project (./.claude)
```

Flags: `--window 180000` (autoCompactWindow if you have none), `--dry-run`, `--uninstall`, `--force` (install even though the plugin is present). It is idempotent, only touches its own hook entries, keeps your other hooks and settings, and refuses to overwrite a `settings.json` it cannot parse (it saves a backup copy and exits). It also copies the persist skill to `<claude-dir>/skills/persisting-context/`, with an ownership marker (`<!-- installed by apcc <version> -->`) as the first line after the frontmatter. It never overwrites a skill without that marker, and `--uninstall` removes only its own copy. Restart Claude Code sessions afterwards.

The installer sets `autoCompactWindow` unless you already have one, so the window hint is a plugin-only message.

### Both at once would double-fire

Claude Code does not dedupe a plugin's copy of a handler against a script install's copy, so every event would fire twice. If a script install is present — user-level (`~/.claude`) or `--project` (`./.claude`) — the plugin **stands down** and says so once at startup, telling you how to remove the script install. The installer refuses to run when an `apcc@…` plugin is installed at either level, unless you pass `--force`. Use one install mode per machine.

### Prepare a project

```bash
mkdir -p .opencode/context   # or use beads
```

apcc only acts fully in a project that has somewhere to persist to: `.opencode/context/` or a `.beads/` directory. With neither it does two things only: a startup line saying apcc is idle and how to switch it on, and one late nudge per context (at the usual persist threshold) asking the model to create `.opencode/context`, add it to `.gitignore` and persist. It writes nothing into the project, and never gates; your messages are still copied verbatim to the state dir at compaction and pointed to afterwards. `mkdir -p .opencode/context` is the opt-in; `APCC_CC_UNTRACKED=0` restores total silence.

## The problem

Claude Code compacts a long conversation into a summary. Summaries paraphrase: constraints you stated ("never touch billing", "budget is $20"), half-finished plans and in-flight state quietly vanish. By the time you notice, the detail is gone.

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
| `APCC_CC_UNTRACKED=0` | Total silence in projects with no `.opencode/context/` or `.beads/` (no startup line, no late nudge, no words copy). |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Read from Claude Code's own settings to place the threshold. |

## Example

[`examples/walkthrough.mjs`](examples/walkthrough.mjs) plays one session through the real hook with the payloads Claude Code sends: a constraint stated early, the persist nudge, the gate blocking a model that ignored it, the notes and index line that unblock it, the Stop message, and the recovery contract injected after the host compacts. No model runs; the script plays the model's steps, so you see exactly what the hook says at each stage. It touches only a temp directory.

```bash
node examples/walkthrough.mjs
```

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
- The plugin install path was checked with `claude plugin validate . --strict`, a synthetic exec-form harness (paths with a space and a symlink) and three short live Claude Code sessions on Haiku run by the author (2026-11-05/06). In the last one (150k window, a 14-file read task, six host auto-compactions at ~116-119k tokens) the model persisted ten index lines in response to the nudges, the gate and Stop message fired, PreCompact and restore ran every time, and the task finished correctly with the constraint and decision intact. Raw logs are not in the repo. The script install is the fallback.
- Exec-form plugin hooks (`command` + `args`) need a recent Claude Code; the exact minimum version is unknown. On old CLIs the plugin hooks may fail to parse; use the script install.
- Managed organisations that set `allowManagedHooksOnly` may block plugin hooks (check your org policy); if they do, the plugin silently does nothing there, so use the script install instead.
- It only acts in projects that have somewhere to persist to: `.opencode/context/` or a `.beads/` directory. Any other project gets only the startup line and the one late nudge described above, and no work state is saved; only your messages are copied to the state dir at compaction. The one exception is the script installer, which sets `autoCompactWindow` (default 180000) in your user settings when none is set; that applies to every session, including untracked projects and 1M-context models.
- The gate is a best-effort guard, not a sandbox. It string-matches one shell command: it blocks destructive commands aimed at the persist paths, but shell indirection (`$VAR` flags, line continuations) can defeat the `bd update --notes` deny. It exists to stop accidents.
- The gate looks at command text, so it can be fooled on purpose: a persist token inside quoted data or a comment (`echo 'bd note' >> ~/.bashrc`), a script that does the deleting (`python evil.py .opencode/context/`), encoded payloads, and verbs it does not know. Its quote reading is simpler than bash's, so crafted quoting (`$'...'` escapes, an apostrophe in a `#` comment, a heredoc delimiter written as `'E'OF`) can hide a command from the destructive check, and a truncating redirect (`echo x > file && echo y >> notes`) is not seen. Plain chaining after a real persist command (`bd note x && npm publish`) also passes. Independent testing found these; they are accepted because the gate guards against accidents, not a hostile model.
- Gate strength depends on knowing your compaction window. Without `autoCompactWindow` (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) the gate releases after 4 denials; with it, the gate stays engaged close to the compaction point. The script installer sets the window; the plugin only suggests it. `Read`, `Grep`, `Glob`, `TaskOutput`, `Skill`, `AskUserQuestion`, `TodoWrite`, `ToolSearch`, `ExitPlanMode`, `KillShell` and `TaskStop` are never gated, nor are plain `pwd`, `ls` and `cat`, `mkdir -p` of the persist dirs, and the skill's `.gitignore` setup; `Agent` and `WebFetch` are gated. After each persist in the same context the quiet span before the next nudge doubles (up to 8x of 12k tokens), so an obedient model is not interrupted every 12k tokens. `bd update --notes` (which replaces a bead's notes) is denied always, not only near compaction.
- The context meter reads the last 600 KB of the transcript; if the newest single line is larger than that, no reading is taken until the next turn.
- The user-words file lives in the user-level state directory, so it does not travel if you move the project to another machine. It holds every typed message verbatim, so treat the state directory as sensitive: it is created `0700` with `0600` files, and user-words files older than 30 days are pruned; delete the directory to remove them sooner.
- The plugin and the script install store state in the same place, but running both at once is refused by the installer and stood down by the plugin.
- `node` must be on PATH for either install; the plugin cannot enforce its `engines` field.
- Developed and tested on Linux with synthetic hook payloads (CI runs Node 18/20/22). The plugin manifest is validated in CI; not yet checked against every Claude Code release.
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

## Uninstall

Plugin:

```text
/plugin uninstall apcc
/plugin marketplace remove apcc
```

Script install:

```bash
node scripts/install.mjs --uninstall            # user level
node scripts/install.mjs --uninstall --project  # project level
```

Both leave your persisted state in `~/.local/state/apcc-cc`; delete that directory when you want it gone. The script uninstall removes the skill copy only when its ownership marker is present, and it leaves `autoCompactWindow` in your settings (the installer may have set it) — remove it by hand if you want the default back. If `settings.json` cannot be parsed, `--uninstall` also refuses (after saving a backup), so fix or move that file first.

## Support

If apcc saves you work, you can [sponsor the project on GitHub](https://github.com/sponsors/9thDuck). It is optional and nothing is gated behind it.

## Use at your own risk

apcc runs as hooks inside your Claude Code sessions, can deny tool calls, and writes files into your projects and its state directory. Use it at your own risk and judgement. It is provided as is, without warranty of any kind, and the author is not liable for any loss, damage, lost work or other harm from using it. Back up anything you cannot afford to lose, and read [Honest limits](#honest-limits) first. The full terms are in the [license](LICENSE).

## License

[PolyForm Shield 1.0.0](LICENSE). You may use apcc for any purpose, including at work, and modify it for your own use. You may not offer a product or service that competes with apcc. This is a source-available license, not an OSI open-source one.

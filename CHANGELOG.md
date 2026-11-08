# Changelog

The public repository starts at 0.2.1. Entries below it describe earlier, unpublished history.

## Unreleased

- The script installer now refuses to install when `bd` (beads) is not on PATH and changes nothing; `--force` overrides, `--uninstall` and `--help` are unaffected. The plugin install cannot check prerequisites, so the README lists them.
- Projects without `.beads/` or `.opencode/context/` no longer get the late "set up .opencode/context and persist" nudge. They get the startup line and the verbatim copy of your messages only; apcc never asks the model to create anything.

## 0.2.1 (2026-11-07)

- Licensed under PolyForm Shield 1.0.0: free to use and modify, including at work, but not to offer a competing product or service. README and installer output now say plainly that apcc is used at your own risk and the author is not liable for any loss or damage.

## 0.2.0 (2026-11-06)

- Untracked projects (no `.opencode/context/` or `.beads/`) are no longer fully silent: one startup line says how to switch apcc on. Nothing is written into the project and there is no gate; your messages are still copied verbatim to apcc's state dir at compaction and pointed to on restore. `APCC_CC_UNTRACKED=0` restores silence.
- Audit fixes: the gate no longer deadlocks in project paths with a space, non-ASCII characters or `+`; a `PERSISTED: n units` is verified only by a persist write apcc saw (a Write or Edit under the persist dirs, a Bash `echo`/`printf`/heredoc/brace-group redirected into them, a python or node writer, a `bd note`); a write just before the first nudge counts, a delta nudge needs its own write after it; a bare claim, an earlier cycle's write, or another command's output redirected into the dir is reported as unverified and does not release the gate, and the deny text says how to fix it; a `PERSISTED:` line in a subagent's reply is ignored; the destructive-command check skips backticks that quoting or a heredoc body makes plain text, so a note that mentions `npm install` is not refused (its quote reading is simpler than bash's; see Honest limits); a write followed by a read-back (`tail`, `head`, `cat file`) still counts; the not-backed text clears after a later real persist or a new cycle; a subagent write from before the main thread's first token reading counts as early; the `..` traversal check applies to redirect targets and path words, not prose; the post-nudge grace is counted in tool calls, not tokens; the plugin stands down only when the script install's wired hook file exists, and warns once when it does not; the armed gate lets `pwd`, `ls`, `cat`, `mkdir -p` of the persist dirs, the skill's `.gitignore` setup, `KillShell` and `TaskStop` through (`Agent` and `WebFetch` stay blocked).
- `/clear` restores only the words saved at the last compaction, offered for context when exactly one session in the project was active in the last 15 minutes; messages typed since that compaction are not in it.
- Found in a live Haiku trial: the nudge now gives the exact `.gitignore` command the gate accepts (a compound command was refused); the compaction point never prints as a negative number on small windows; the pitch says the host compacts and apcc persists, gates and restores (hooks cannot run `/compact`). Live trials confirmed PreCompact and restore after auto and manual compaction.
- Restore no longer says "nothing was persisted" when an earlier persist exists but later work is unsaved. Live trial 3: six auto-compactions, ten persisted units, task completed intact.
- Opus review fixes: after `/clear` only a single recently active words file is offered, as context only (never another session's or an old one's instructions as open work); reading the index no longer counts as a persist (only appending does); the gate no longer blocks `Skill`, `AskUserQuestion`, `TodoWrite`, `ToolSearch`, `ExitPlanMode`; repeated persists back off the next nudge; on small windows the nudge comes at least 5k before the host's compaction point.
- Ships as a Claude Code plugin and marketplace: `/plugin marketplace add 9thDuck/claude-apcc`, then `/plugin install apcc@apcc` (one step on a recent Claude Code version: `/plugin install apcc --marketplace 9thDuck/claude-apcc`). The script installer stays as the fallback for managed or older CLIs.
- `hooks/hooks.json` wires the six handlers in exec form (`command` + `args`, `${CLAUDE_PLUGIN_ROOT}`), with no shell and no matchers. The entry guard now survives plugin paths that contain a space or are reached through a symlink.
- The persist skill ships at `skills/persisting-context/SKILL.md`; it loads as `apcc:persisting-context` under the plugin and as `persisting-context` under the script install, and the hook names it by mode.
- The plugin stands down when a script install is present (one startup message), and the installer refuses when the plugin is installed unless `--force`; the two would otherwise fire every handler twice.
- The script installer also installs the skill, with `<!-- installed by apcc <version> -->` as the first body line after the frontmatter. It never overwrites a skill without that marker and `--uninstall` removes only its own copy.
- Startup shows a one-time-per-session hint when no `autoCompactWindow` is visible in the environment or in user, project or local settings. The plugin never writes settings.
- Beads stays optional and now needs `bd` on PATH as well as `.beads/`; otherwise messages route to `.opencode/context`. The README points at the upstream `beads` plugin.
- One source of truth for the version (`package.json`), a sync test, `scripts/verify.mjs --plugin` for the space + symlink path, and `claude plugin validate . --strict` in CI.
- State still lives in `~/.local/state/apcc-cc` and survives uninstall.

## 0.1.0
- First release. Six hook events, five handlers (nudge, gate, stop, precompact, restore) with no dependencies.
- Works with or without the `bd` (beads) tracker; text adapts.
- Gate allows only read-only `bd` commands (no chaining or redirects) and denies `bd update --notes`.
- `APCC_GATE_ALLOW_TOOLS` and `APCC_MARKER_TOOLS` for MCP-based reply tools.
- Lossless user-words file written at PreCompact and pointed to by the recovery contract.
- `scripts/install.mjs` (idempotent, reversible) and `scripts/verify.mjs` (end-to-end, sandboxed).

### Hardening after independent verification
- Gate: a Bash command that names a persist path or `bd note` but also deletes, moves, resets or downloads is not a persist write. Shell wrappers (`bash -c`, `eval`, heredoc to sh, `perl -e`, `python -c`) are judged on their raw text; persist file names such as `rm.md` are not mistaken for deletions; `git -C <dir> restore` is caught; `bd update --append-notes` counts as a persist write (the deny text recommends it).
- Installer: only entries at `.../hooks/apcc/claude-apcc/apcc.mjs` (either path separator) are treated as its own; an unexpected `hooks` shape is backed up and refused instead of crashing; `--uninstall` is a no-op without settings.json and removes the empty parent dirs it created.
- Meter: non-numeric or negative `usage` values are ignored instead of concatenating as strings.
- A `.beads` regular file no longer counts as a tracker.
- README: documented the gate's best-effort nature, window dependence, the verbatim-file semantics, the exact kill-switch values and the >600KB-last-line meter limit.

### Third verification pass
- A denied destructive command that merely contained `bd note` was still recorded as a persist and opened the gate for the next call. Fixed (the gate only records an allowed persist).
- Windows-style persist paths (`.opencode\context\x.md`) are now recognised.
- Prose in `bd note`/`bd create`/`echo | bd note` (a bare `rm` in a title), and heredocs with hyphenated delimiters, are no longer mistaken for deletions.
- Quote-split (`r''m`), backslash-escaped (`m\v`), `$(...)`-hidden and `../` traversal verbs are now caught; `chmod`, `Remove-Item`, `Move-Item`, `Clear-Content`, `del`, `nc` and bare `>` truncation added.

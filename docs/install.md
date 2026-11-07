# Install details

The short install is in the [README](../README.md#install). This page has the rest.

## As a plugin (recommended)

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

## As a script install (fallback)

Use this on an older CLI, where plugin hooks are blocked, or where you prefer settings entries you can read:

```bash
git clone https://github.com/9thDuck/claude-apcc ~/claude-apcc
node ~/claude-apcc/scripts/install.mjs            # all projects (~/.claude)
cd /path/to/your/project
node ~/claude-apcc/scripts/install.mjs --project  # only this project (./.claude)
```

Flags: `--window 180000` (autoCompactWindow if you have none), `--dry-run`, `--uninstall`, `--force` (install even though the plugin is present). It is idempotent, only touches its own hook entries, keeps your other hooks and settings, and refuses to overwrite a `settings.json` it cannot parse (it saves a backup copy and exits). It also copies the persist skill to `<claude-dir>/skills/persisting-context/`, with an ownership marker (`<!-- installed by apcc <version> -->`) as the first line after the frontmatter. It never overwrites a skill without that marker, and `--uninstall` removes only its own copy. Restart Claude Code sessions afterwards.

The installer sets `autoCompactWindow` unless you already have one, so the window hint is a plugin-only message.

## Both at once would double-fire

Claude Code does not dedupe a plugin's copy of a handler against a script install's copy, so every event would fire twice. If a script install is present — user-level (`~/.claude`) or `--project` (`./.claude`) — the plugin **stands down** and says so once at startup, telling you how to remove the script install. The installer refuses to run when an `apcc@…` plugin is installed at either level, unless you pass `--force`. Use one install mode per machine.

## Prepare a project

```bash
mkdir -p .opencode/context   # or use beads
```

apcc only acts fully in a project that has somewhere to persist to: `.opencode/context/` or a `.beads/` directory. With neither it does one thing only: a startup line saying apcc is idle and how to switch it on. It writes nothing into the project, and never gates; your messages are still copied verbatim to the state dir at compaction and pointed to afterwards. `mkdir -p .opencode/context` is the opt-in; `APCC_CC_UNTRACKED=0` restores total silence.

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

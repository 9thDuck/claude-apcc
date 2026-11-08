# claude-apcc

**Persist → gate → restore.** A set of [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks) that stop long sessions from silently losing work, decisions and your own instructions when the context window compacts.

One file (`hooks/apcc.mjs`). Ships as a Claude Code **plugin** and as a **script installer** for managed or older installs.

Use at your own risk and judgement; the author is not liable for any loss or damage ([details](#use-at-your-own-risk)).

## Why it exists

apcc ties persistence to a lower context level. The host's own compaction fires late, near the window limit, when the summary has the least room to keep the exact next step, decisions and gotchas, and asking the model to "please save first" at that point has nothing checking the answer. So apcc picks an earlier point (the script installer sets `autoCompactWindow` to 180000 if you have none) and makes saving happen before it: a nudge as context nears the line, a gate that holds back other work until the save is done, and a restore afterwards.

It is aimed at long-running sessions. A short session never reaches the threshold, so apcc does nothing in it.

**Cost: estimates only.** In the author's own use it seemed to bring spend down. A rough model using Opus 5.5 list prices (a 500k-token task, compaction at 130k, extra beads calls included) suggests the result depends on the session. With the prompt cache always warm and no pauses, it came out more expensive. Once the session paused for over five minutes now and then, so the cache expired and the whole context was billed again, it came out cheaper, and more so for longer runs. Those inputs are assumptions, not measurements, and the model ignores subscription limits. Treat the numbers as a reason to try it, not a promise. Published research also finds that models handle very long contexts less reliably ([RULER](https://arxiv.org/abs/2404.06654), [Chroma](https://www.trychroma.com/research/context-rot)), though nobody has measured whether compacting earlier is better than compacting late.

## Prerequisites

- Node 18 or newer on your PATH. Without it the hooks fail and apcc does nothing.
- [Beads](https://github.com/steveyegge/beads) (`bd`) installed, and `bd init` run in each project you want apcc in. apcc saves your state as beads notes. The script installer (below) refuses to run if `bd` is not on PATH; pass `--force` to install anyway. The plugin install cannot check this: Claude Code has no install-time check for plugins.

## Install

As a Claude Code plugin (recommended). In Claude Code:

```text
/plugin marketplace add 9thDuck/claude-apcc
/plugin install apcc@apcc
```

Then restart, or run `/reload-plugins`. On a recent Claude Code version, `/plugin install apcc --marketplace 9thDuck/claude-apcc` does both steps in one.

Or as a script install, for managed or older installs:

```bash
git clone https://github.com/9thDuck/claude-apcc ~/claude-apcc
node ~/claude-apcc/scripts/install.mjs            # all projects (~/.claude)
node ~/claude-apcc/scripts/install.mjs --project  # run inside a project: only that project
```

Then set `autoCompactWindow` (for example `180000`) in your Claude Code settings so apcc knows when compaction is near; the script installer sets it for you. In a project without `.beads/`, apcc stays mostly idle: one startup line, and it saves only your own messages.

Details, updating, uninstalling, flags and the plugin-versus-script rules: [docs/install.md](docs/install.md).

## The problem

Claude Code compacts a long conversation into a summary. Summaries paraphrase: constraints you stated ("never touch billing", "budget is $20"), half-finished plans and in-flight state quietly vanish. By the time you notice, the detail is gone.

## What it does

Hooks cannot trigger compaction, so apcc works around the host's own: it makes the model save before, and restores after.

- **Persist (nudge):** when the context nears the compaction point, it asks the model once to write its decisions and in-flight state to `.opencode/context/` (or beads), following the bundled [persisting-context skill](skills/persisting-context/SKILL.md).
- **Gate:** if that nudge was ignored and compaction is close, it blocks ordinary work tools until the state is saved. It is bounded and cannot deadlock a session.
- **Record:** at compaction it notes honestly whether anything was persisted, and copies your own messages verbatim to a private file.
- **Restore:** after compaction it injects a recovery contract: what was saved, the tail of your context index, and a pointer to your verbatim messages.

| Hook | Handler | Behaviour |
|---|---|---|
| `UserPromptSubmit`, `PostToolUse` | `nudge` | Past a threshold *before* the host compacts, inject one "persist now" directive. Subagents are skipped. |
| `PreToolUse` | `gate` | If the nudge was ignored near the compaction point, block ordinary work tools until state is saved. |
| `Stop` | `stop` | Records a `PERSISTED: <n> units` line in the reply. |
| `PreCompact` | `precompact` | Records the honest persist status and your messages verbatim (`0600`). Never blocks compaction. |
| `SessionStart` | `restore` | After compact (and after `/clear` when there is something to restore), injects the recovery contract. |

Per-hook detail is in [docs/reference.md](docs/reference.md). To see one session play out step by step with no model involved, run `node examples/walkthrough.mjs` ([source](examples/walkthrough.mjs)).

## Configuration

| Variable | Meaning |
|---|---|
| `APCC_CC=0` | Kill switch. Also silences the startup notices. |
| `APCC_PERSIST_THRESHOLD_TOKENS` | Override the persist threshold (for example `100k`). |
| `APCC_GATE_ALLOW_TOOLS` | Comma list of tool-name prefixes the gate never blocks. |
| `APCC_CC_STATE_DIR` | Relocate state (default `~/.local/state/apcc-cc`). |
| `APCC_CC_UNTRACKED=0` | Total silence in projects with no `.opencode/context/` or `.beads/`. |

The rest (`APCC_MARKER_TOOLS`, `APCC_CC_REMOTE_ONLY`, the window variables) are in [docs/reference.md](docs/reference.md#configuration-environment).

## Beads

With beads installed, the directives use `bd note` and `bd create`, and recovery re-reads beads first. A project without `.beads/` can use `.opencode/context/` instead (`mkdir -p .opencode/context`); that fallback is described in [docs/reference.md](docs/reference.md#beads-is-optional).

## Uninstall

```text
/plugin uninstall apcc
/plugin marketplace remove apcc
```

For a script install: `node scripts/install.mjs --uninstall` (add `--project` for a project install). Your persisted state stays in `~/.local/state/apcc-cc`; delete it when you want it gone. See [docs/install.md](docs/install.md#uninstall) for what uninstall leaves behind.

## Honest limits

- The persist step is an instruction to the model, and a model can ignore it. In two earlier Haiku trials it did; in the latest one (seven compactions) it followed every nudge. Expect that to vary by model. When it is ignored, apcc reports "not done" after compaction and points to the recovery steps. The gate and the recovery contract make ignoring it costly and recoverable, not impossible.
- It only acts fully in a project with `.beads/` (or the `.opencode/context/` fallback). In any other folder you get one startup line and a copy of your own messages, nothing more.
- Prerequisites are not enforced by the plugin: Claude Code has no install-time check. Without `bd` apcc falls back to plain files; without `node` the hooks error and apcc does nothing. The script installer refuses without `bd` (override with `--force`).
- The gate matches command text. It stops accidents, not a determined attacker, and is not a sandbox.
- Exec-form plugin hooks need a recent Claude Code, and organisations that set `allowManagedHooksOnly` may block them; the script install covers both.
- Tested on Linux only: synthetic hook payloads, CI on Node 18/20/22, and a few short live Haiku sessions. Not checked on macOS or Windows, or against every Claude Code release.

The full list is in [docs/reference.md](docs/reference.md#honest-limits). The independent verification passes are in [docs/verification/](docs/verification/). To check it yourself, run `npm test` and `node scripts/verify.mjs`.

## Support

If apcc saves you work, you can [sponsor the project on GitHub](https://github.com/sponsors/9thDuck). It is optional and nothing is gated behind it.

## Use at your own risk

apcc runs as hooks inside your Claude Code sessions, can deny tool calls, and writes files into your projects and its state directory. Use it at your own risk and judgement. It is provided as is, without warranty of any kind, and the author is not liable for any loss, damage, lost work or other harm from using it. Back up anything you cannot afford to lose, and read [Honest limits](docs/reference.md#honest-limits) first. The full terms are in the [license](LICENSE).

## License

[PolyForm Shield 1.0.0](LICENSE). You may use apcc for any purpose, including at work, and modify it for your own use. You may not offer a product or service that competes with apcc. This is a source-available license, not an OSI open-source one.


---
name: persisting-context
description: Save decisions, progress and in-flight state so a context compaction, /clear or new session cannot lose the work. Use when an apcc persist nudge arrives, before compacting a long session, or at a task boundary.
---

# Persisting context

Compaction replaces the conversation with a summary that paraphrases and drops instructions.
Persist what a summary cannot be trusted to keep: decisions and their reasons, progress,
blockers, and the exact next action. Small linked units beat one long dump.

## Where state goes

The apcc hooks read these files and inject the tail of the index after a compaction or /clear:

1. `.opencode/context/index.md` — one line per unit, newest last:
   `| date | slug | destination | one-line summary |`
2. `.opencode/context/session-notes.md` — in-flight state, newest on top.
3. `docs/research/<topic>.md` — reusable findings, one `##` section each.

`.opencode/` is a cross-tool convention: the apcc hook reads and writes it, and other
apcc-compatible tools read the same index, so keep the format stable. Add it to the project's
`.gitignore` before the first persist (the index and notes are session state, not deliverables)
unless the project deliberately commits them.

## When to persist

- When an apcc nudge asks for it; the nudge states the actual token threshold for this session.
- Before a `/compact`, a `/clear`, or any pause long enough for the prompt cache to expire.
- At a task boundary, before starting work that will replace the current plan.

## What one unit is

One fact each: what changed, why, the current state, and the exact next action. A unit is not a
transcript of tool output, a list of resolved dead ends, or anything the repo can tell you in
seconds. Link a unit to the one it follows when the order matters.

In-flight state also records where you are, what you tried that failed, and any still-open
decision.

## Beads: only when the project uses them

If the project has a `.beads/` directory and `bd` is on PATH, the tracker is the first place to
keep progress, blockers and decisions:

- progress, blocker or next action on the bead in play -> `bd note <id> --stdin`
- a durable, standalone decision -> `bd create "Decision: <slug>"`

If `.beads/` exists but `bd` is not on PATH, do not call `bd`. Persist to the context files above;
the hook says so and routes recovery there too. Beads is optional: apcc works without it, and a
project's own tracker, when present, is authoritative.

Never replace a bead's notes history; append with `bd note`.

## Marker

End the persist reply with the marker as its last line:

    PERSISTED: <n> units (<slugs>)

or `PERSISTED: none` when nothing needed saving. When the user asked for the persist, use the
manual form exactly: `PERSISTED (manual): <n> units (<slugs>)`, or `PERSISTED (manual): none`.
The stop hook reads only a marker at the very end of the reply; a quoted example in a code fence or
mid-reply does not register. A persist never ends the turn: keep working afterwards.

## Recovery order

After a compaction or /clear, before making a state claim:

1. Read the injected recovery map and the files it points at.
2. Re-read the recorded requirement (the in-progress bead if the project uses beads; otherwise the
   context index and the files it names). A remembered requirement is not a recorded one.
3. Cite a freshly read artifact for any claim about current state.
4. The user's newest message wins over any recovered plan or note.

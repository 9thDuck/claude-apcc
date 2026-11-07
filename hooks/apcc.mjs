#!/usr/bin/env node
// claude-apcc: persist -> gate -> restore (the host compacts) for Claude Code, built from hooks.
// https://github.com/9thDuck/claude-apcc
//
// What it does (and, honestly, what it cannot):
//   nudge     (UserPromptSubmit, PostToolUse) when the main conversation crosses the
//             persist threshold, inject ONE "persist now" directive per context epoch
//             (a second, final reminder only if it was ignored). Subagent calls skipped.
//   stop      (Stop) detect the end-anchored `PERSISTED: <n> units` marker in the last
//             reply, record it, and tell the user the state is saved (hooks cannot run /compact; they can).
//   gate      (PreToolUse) once a nudge is ignored near the compaction point, block ordinary
//             tools until a persist is recorded. Never blocks Read, Grep, Glob, TaskOutput, Skill,
//             AskUserQuestion, TodoWrite, ToolSearch, ExitPlanMode, KillShell, TaskStop, plain
//             pwd/ls/cat, or the persist-dir setup.
//   untracked projects (no .opencode/context/ or .beads/) get a startup hint only, never a nudge or a gate;
//             their user words are still saved at compaction and pointed to on restore.
//   precompact(PreCompact) record the honest persist status and copy the user's words to the state dir.
//             NEVER blocks compaction (a hold-and-spawn gate wedged sessions in the field).
//   restore   (SessionStart) after compact/clear: bump the epoch and inject the recovery
//             contract (persist status + index tail). The words are captured at compaction only, so
//             /clear restores the words from the last compaction (a single active session, within
//             15 minutes), not everything typed since. On resume of a big stale session,
//             warn the user that the prompt cache expired.
//
// Cannot do: trigger /compact (Claude Code hooks cannot). The persist nudge fires before the host
// compacts only because autoCompactWindow is set in ~/.claude/settings.json (the default on
// 1M-window models is ~967K tokens, far past any sensible persist threshold).
//
// Fail-open, never fail-silent: a missing file is expected and stays quiet; any other error
// is reported on stderr and exits 1 (exit 2 would block every tool call). Kill switch: APCC_CC=0.
//
// Configuration (environment): APCC_CC=0 disables; APCC_PERSIST_THRESHOLD_TOKENS overrides the threshold;
// APCC_GATE_ALLOW_TOOLS=prefix1,prefix2 tools the gate never blocks (e.g. an MCP server that is your only
// way to reach the user); APCC_MARKER_TOOLS=name1,name2 tools whose text argument is a reply that may end
// in the PERSISTED marker; APCC_CC_UNTRACKED=0 silences untracked projects; APCC_CC_STATE_DIR relocates state; APCC_CC_REMOTE_ONLY=1 acts only in cloud sessions.

import fs from "node:fs"
import os from "node:os"
import { pathToFileURL } from "node:url"
import path from "node:path"
import crypto from "node:crypto"

// Fail-open, never fail-silent: a missing file is expected (a project without settings or state);
// anything else is written to stderr so a broken hook is visible instead of looking like a no-op.
export function warn(where, e) {
  if (e && e.code === "ENOENT") return
  process.stderr.write("apcc: " + where + ": " + (e && e.message ? e.message : String(e)) + "\n")
}

export const VERSION = "0.2.1"
// How the persist skill is named in hook text depends on the install: a plugin namespaces every
// component under the plugin name (`apcc:persisting-context`); the script installer copies the
// skill into the user's skill directory as plain `persisting-context`. Hook processes get
// CLAUDE_PLUGIN_ROOT only when the plugin is what is running the hook.
export const skillName = (env = process.env) => (env.CLAUDE_PLUGIN_ROOT ? "apcc:persisting-context" : "persisting-context")
// event -> [matcher?, handler]. The one table the script installer and hooks/hooks.json follow.
export const EVENTS = [
  ["UserPromptSubmit", "nudge"],
  ["PostToolUse", "nudge"],
  ["Stop", "stop"],
  ["PreCompact", "precompact"],
  ["SessionStart", "restore"],
  ["PreToolUse", "gate"],
]
export const DEFAULT_THRESHOLD_TOKENS = 135_000 // used when no auto-compact window is configured
// Persist at 80% of the auto-compact window so the host compacts shortly AFTER the persist turn
// (window 180k -> nudge 132k). Lower ratios leave a long un-compacted tail; the
// persist turn itself needs roughly 15-30k tokens of headroom before the host compacts.
export const PERSIST_HEADROOM_TOKENS = 15_000 // measured: 15 persist turns cost median ~4k, max ~8.2k tokens
export const DELTA_HEADROOM_TOKENS = 8_000 // second, delta-only persist this close to the compaction point
// Claude Code auto-compacts BELOW autoCompactWindow: it keeps an output + buffer reserve.
// Observed: window 160k compacted at 126,950 tokens, before the old window-25k
// threshold (135k) ever fired, so no persist happened. Each auto compaction is recorded
// with the window it ran under; the reserve is learned as the MEDIAN of (window - tokens at
// compaction) over >= MIN_RESERVE_SAMPLES samples of the SAME window. (A one-way max() let one odd
// reading lower the threshold for good: one bad reading once stored 80k against 29 real compactions at ~33k.)
export const HOST_RESERVE_TOKENS = 33_000
export const MIN_RESERVE_SAMPLES = 3
export const MAX_RESERVE_SAMPLES = 20
export const MIN_THRESHOLD_RATIO = 0.5
export const MIN_NUDGE_BEFORE_COMPACT_TOKENS = 5_000 // the nudge always comes at least this far before the host's compaction point
export const PERSIST_FRESH_TOKENS = 12_000 // a persist covers only this much later growth; earlier persists go stale
export const REARM_TOKENS = 15_000 // growth past the first nudge before the final reminder
export const REARM_MS = 10 * 60 * 1000
export const MAX_NUDGES = 2
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const TAIL_BYTES = 600_000
const CONTEXT_CAP_CHARS = 9_000 // additionalContext hard cap is 10,000

export function parseTokenCount(v) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
  if (typeof v !== "string") return 0
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/)
  if (!m) return 0
  const n = parseFloat(m[1])
  const mult = m[2].toLowerCase() === "m" ? 1_000_000 : m[2].toLowerCase() === "k" ? 1_000 : 1
  return Math.floor(n * mult)
}

export function resolveWindow(env, settings) {
  return parseTokenCount(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW) || parseTokenCount(settings?.autoCompactWindow)
}

// Real host compactions as the transcript recorded them: the only trustworthy source of the trigger point.
export function compactBoundaries(text) {
  const out = []
  for (const line of String(text).split("\n")) {
    if (!line.includes("compact_boundary")) continue
    try {
      const o = JSON.parse(line)
      const m = o.compactMetadata
      if (m && typeof m.preTokens === "number") out.push({ ts: o.timestamp, trigger: m.trigger, pre: m.preTokens })
    } catch {}
  }
  return out
}

export function learnedReserve(samples, window) {
  const r = (Array.isArray(samples) ? samples : [])
    .filter((s) => s && s.window === window && s.pre > 0 && s.pre < window)
    .map((s) => window - s.pre)
    .sort((a, b) => a - b)
  return r.length >= MIN_RESERVE_SAMPLES ? r[Math.floor(r.length / 2)] : 0
}

// Claude Code compacts at (window - output reserve) * pct when CLAUDE_AUTOCOMPACT_PCT_OVERRIDE is set,
// if that is lower than its usual point. Measured in a cloud session (window 180k, pct 80):
// last readings before compaction 127,978 and 127,449, i.e. (180k - 20k) * 0.8 = 128k, not 147k.
export const HOST_OUTPUT_RESERVE_TOKENS = 20_000
export function autocompactPct(env) {
  const pct = parseFloat(env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  return Number.isFinite(pct) && pct > 0 && pct < 100 ? pct : 0
}

// Where the host actually compacts for a given window (0 = unknown).
export function compactPoint(window, learnedReserve = 0, pct = 0) {
  if (window <= 0) return 0
  const usual = window - Math.max(HOST_RESERVE_TOKENS, learnedReserve)
  // A window below the host's own reserve has no usable compaction point: 0 means unknown, never negative.
  return Math.max(0, pct > 0 ? Math.min(usual, Math.floor(((window - HOST_OUTPUT_RESERVE_TOKENS) * pct) / 100)) : usual)
}

// env override -> compaction point minus persist headroom (so little work falls between persist and host compaction) -> default
export function resolveThreshold(env, settings, learnedReserve = 0) {
  const override = parseTokenCount(env.APCC_PERSIST_THRESHOLD_TOKENS)
  if (override > 0) return override
  const window = resolveWindow(env, settings)
  if (window > 0) {
    const cp = compactPoint(window, learnedReserve, autocompactPct(env))
    const usual = Math.max(Math.floor(window * MIN_THRESHOLD_RATIO), cp - PERSIST_HEADROOM_TOKENS)
    // On a small window the ratio floor can sit past the compaction point, so the nudge would only come after the host compacted.
    return cp > 0 ? Math.min(usual, Math.max(cp - MIN_NUDGE_BEFORE_COMPACT_TOKENS, 1_000)) : usual
  }
  return DEFAULT_THRESHOLD_TOKENS
}

// Size of the main conversation as of the last assistant turn: the next request will
// carry input + cache reads + cache writes + that turn's output. Sidechains (subagents)
// are skipped: their context is not the main window.
export function lastMainContextTokens(jsonlText) {
  const lines = jsonlText.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || line[0] !== "{") continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue // partial first line of a tail read, or a torn write
    }
    // Reached the compaction boundary before any newer assistant turn: the older usage figures
    // describe the pre-compact context, so there is no reading yet (not a stale ~250k).
    if (o.type === "system" && o.subtype === "compact_boundary") return 0
    if (o.type !== "assistant" || o.isSidechain || o.isApiErrorMessage) continue
    const u = o.message?.usage
    if (!u) continue
    const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)
    return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens)
  }
  return 0
}

function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r")
  try {
    const { size } = fs.fstatSync(fd)
    const len = Math.min(size, bytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return buf.toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

// END-ANCHORED marker: the reply's last non-empty line, outside an unbalanced code fence.
// Quoted grammar (code blocks, pasted receipts, docs) must never register (apcc learned
// this from three unintended compactions on 2026-09-13).
export function parseMarker(text) {
  if (typeof text !== "string") return { kind: "none" }
  if ((text.match(/^\s*```/gm) ?? []).length % 2 === 1) return { kind: "none" }
  const last = text.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? ""
  const m = last.match(/^PERSISTED(?: \((manual)\))?:\s*(none|(\d+)\s+units?\b.*)$/i)
  if (!m) return { kind: "none" }
  const manual = Boolean(m[1])
  if (m[2].toLowerCase() === "none") return { kind: "acknowledged", manual, units: 0 }
  const units = parseInt(m[3] ?? "0", 10)
  return units > 0 ? { kind: "persisted", manual, units } : { kind: "acknowledged", manual, units: 0 }
}

// `verified`: a write to the notes, the index or a bead was seen in this epoch. A bare "PERSISTED: n units"
// without one is only a claim: it must not satisfy the gate or read as DONE in recovery. "none" is an honest opt-out.
export function recordMarker(st, marker, nowTokens, verified = true) {
  if (marker.kind === "persisted" && !verified) {
    st.claimedEpoch = st.epoch
    st.claimedUnits = marker.units
    return
  }
  st.claimedEpoch = -1 // a verified marker supersedes an earlier unbacked claim
  const priorUnits = st.persistedEpoch === st.epoch ? st.units : 0 // a later "none" must not erase an earlier real persist
  st.persistedEpoch = st.epoch
  st.persistedTokens = nowTokens
  st.units = Math.max(marker.units, priorUnits)
  st.persists = (st.persists ?? 0) + 1
  st.nudges = 0
  st.nudgeCalls = 0
  st.lastNudgeAt = 0
}

export function freshSession(now = Date.now()) {
  return { epoch: 0, nudges: 0, lastNudgeAt: 0, lastNudgeTokens: 0, persistedEpoch: -1, persistedTokens: 0, units: 0, persists: 0, wroteEpoch: -1, wroteTokens: 0, verifyFloor: 0, claimedEpoch: -1, claimedUnits: 0, lastTokens: 0, windowWarnedEpoch: -1, deltaEpoch: -1, gateDenials: 0, updatedAt: now }
}

export function newEpoch(st, now = Date.now()) {
  return { ...st, epoch: st.epoch + 1, nudges: 0, lastNudgeAt: 0, lastNudgeTokens: 0, persistedEpoch: -1, persistedTokens: 0, units: 0, persists: 0, wroteEpoch: -1, wroteTokens: 0, verifyFloor: 0, claimedEpoch: -1, claimedUnits: 0, lastTokens: 0, windowWarnedEpoch: -1, deltaEpoch: -1, gateDenials: 0, updatedAt: now }
}

// A persist covers the context only while little has been added since. persistedTokens
// absent (legacy state) counts as covered. tokens 0 = unknown: trust the epoch flag.
export function isCovered(st, tokens = 0) {
  if (st.persistedEpoch !== st.epoch) return false
  if (!(st.persistedTokens > 0) || !(tokens > 0)) return true
  return tokens - st.persistedTokens <= PERSIST_FRESH_TOKENS
}

export function persistStatus(st, tokens = 0) {
  if (isCovered(st, tokens)) return st.units > 0 ? "DONE" : "NOT NEEDED (the model declined to persist: it replied PERSISTED: none)"
  if (st.persistedEpoch === st.epoch) return `NOT DONE (last persist was at ~${Math.round(st.persistedTokens / 1000)}k tokens, ~${Math.round((tokens - st.persistedTokens) / 1000)}k tokens of work since is unsaved)`
  if (st.claimedEpoch === st.epoch && st.claimedUnits > 0) return `NOT DONE (the model claimed ${st.claimedUnits} persisted unit(s) but no write to the index, notes or a bead was seen: the claim is not verified)`
  return "NOT DONE"
}

// A persist write in this epoch, made at or after the latest nudge's floor (see the nudge handler).
// A write whose token reading is unknown (no transcript) cannot be judged stale, so it counts.
const claimBacked = (st) => st.wroteEpoch === st.epoch && (st.wroteTokens ? st.wroteTokens >= (st.verifyFloor ?? 0) : true)
// Pure decision: should this call inject a nudge, and which one?
export function decideNudge({ tokens, threshold, st, now, compactAt = 0 }) {
  if (threshold <= 0 || tokens < threshold) return null
  if (isCovered(st, tokens)) {
    // Already persisted, but work kept accruing before the host compacts: one delta persist.
    if (compactAt > 0 && tokens >= compactAt - DELTA_HEADROOM_TOKENS && st.deltaEpoch !== st.epoch) return 3
    return null
  }
  // Each persist in the same epoch doubles the quiet span before the next first nudge (cap 8x), so an
  // obedient model on a large window is not interrupted every ~12k tokens.
  if (st.nudges === 0 && st.persistedEpoch === st.epoch && (st.persists ?? 0) > 1 && tokens - st.persistedTokens < PERSIST_FRESH_TOKENS * Math.min(2 ** ((st.persists ?? 0) - 1), 8)) return null
  if (st.nudges === 0) return 1
  if (st.nudges < MAX_NUDGES && (tokens >= st.lastNudgeTokens + REARM_TOKENS || now - st.lastNudgeAt >= REARM_MS)) return 2
  return null
}

// Why the gate refused, in words that are true for the case: an unbacked PERSISTED claim is not "you ignored the reminders".
function denyReason({ tokens, beads, claimed, destructivePersist }) {
  const lead = claimed
    ? `[apcc] Context is ~${k(tokens)} tokens and your PERSISTED line was not backed by a write apcc can see since the last reminder, so the gate stays closed. Make one: use the Write tool on .opencode/context/session-notes.md (or an echo/printf/cat heredoc into the persist dir${beads ? ", or bd note" : ""}), then append a line to .opencode/context/index.md.`
    : `[apcc] Context is ~${k(tokens)} tokens and you ignored the persist reminders; host compaction is near and would lose unsaved scope. Persist now: write units (${beads ? "bd note / " : ""}.opencode/context/session-notes.md / docs/research), append a line to .opencode/context/index.md LAST (that records the persist), then continue.`
  const why = destructivePersist ? " That persist command was refused because it looks destructive (a delete, move, tee, install or live substitution somewhere in it); use the Write tool for the text instead." : ""
  return `${lead}${why} Still allowed: Read/Grep/Glob, read-only bd queries, git status/diff/log, pwd/ls/cat, mkdir -p of the persist dirs, KillShell/TaskStop. Paths built from $VARS or ~ are not recognised: use the Write tool or a relative path.`
}
export const MAX_GATE_DENIALS = 4 // bounded early on: a gate must never deadlock the session
// After the first nudge: this many main-thread tool calls to finish the atomic step before tools are blocked.
// Counted in calls, not tokens: one large Read can jump the meter past any token margin before the model reacts.
export const GATE_GRACE_CALLS = 2
export const HARD_ZONE_TOKENS = 10_000 // this close to the compaction point the denial cap no longer releases the gate
const PERSIST_DEST = /\.opencode\/context\/|docs\/research\//
const INDEX_PATH = /\.opencode\/context\/index\.md/
// Only a command that writes the index counts as recording a unit; `cat`/`tail` of it is a read.
const INDEX_WRITE_BASH = /(?:>>?)\s*(?:"[^"\n]*|'[^'\n]*|[^\s'"|;&]*)\.opencode\/context\/index\.md/
// A write that backs a PERSISTED claim: a file written under a persist dir, or a bead note/create/remember.
const PERSIST_WRITE_BASH = /(?:>>?)\s*(?:"[^"\n]*|'[^'\n]*|[^\s'"|;&]*)(?:\.opencode\/context\/|docs\/research\/)/
export function isPersistWrite(tool, target, proj) {
  if (["Write", "Edit"].includes(tool)) return underPersistDir(target, proj)
  return tool === "Bash" && (PERSIST_CMD.test(target) || writesAuthoredText(target)) && !isDestructive(target) && !MKDIR_MODE_CMD.test(target) && !escapesPersistDir(target, proj)
}
// Bash that saves something: a bd note/create/remember, a redirect into the persist dir from commands that
// author text (echo, printf, a cat heredoc, a `{ echo; echo; }` group), or a python/node one-liner that writes
// a persist path. A redirect of another command's output (`npm test >> .opencode/context/out.log`) or of an
// existing file (`cat src/a.ts >> ...`) saves nothing a later context can use. apcc cannot judge the text.
const AUTHORING_SEGMENT = /^(?:echo|printf|cd|mkdir|true|:|set|export)\b/
// Reading the note back after writing it is a common habit and writes nothing: tail/head/wc/ls/pwd, or a cat that
// redirects nothing (a cat with a redirect is only an authoring segment when it carries the heredoc).
const READBACK_SEGMENT = /^(?:tail|head|wc|ls|pwd|cat)\b(?![^\n]*>)/
const SCRIPT_WRITE = /\b(?:python3?|node)\b\s+-\w*[ce]\b[\s\S]*\b(?:write|writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/
function writesAuthoredText(cmd) {
  if (SCRIPT_WRITE.test(cmd)) return PERSIST_MARK.test(cmd)
  if (!PERSIST_WRITE_BASH.test(cmd)) return false
  const code = shellCode(cmd).replace(/\d*>&\d+|&>>?/g, "")
  return code
    .split(/&&|\|\||[;|&\n]/)
    .map((seg) => seg.replace(/^[\s{}()]+|[\s{}()]+$/g, ""))
    .filter((seg) => seg && !/^\d*>>?\s*\S+$/.test(seg)) // a group closer carrying only the redirect
    .every((seg) => AUTHORING_SEGMENT.test(seg) || READBACK_SEGMENT.test(seg) || (/^cat\b/.test(seg) && /<<HEREDOC/.test(seg)))
}
const PERSIST_CMD = /\bbd\s+(note|create|remember)\b|\bbd\s+update\b[^\n]*--append-notes\b/
// Setting up the persist destination is part of persisting: `mkdir -p .opencode/context` (the
// README's prepare command has no trailing slash) and the .gitignore edit the nudge asks for.
const MKDIR_PERSIST = String.raw`mkdir\s+(?:-p\s+|--parents\s+)?(?:\.opencode\/context|docs\/research)\/?`
// The skill's setup step is one fixed pair, matched whole: any other chain, or a different target, is not it.
const PERSIST_DIR_MKDIR = new RegExp(String.raw`^\s*${MKDIR_PERSIST}\s*(?:&&\s*echo\s+(?:'\.opencode\/?'|"\.opencode\/?")\s*>>\s*\.gitignore\s*)?$`)
// A persist path is not a licence to force a mode: world-writable (777) or unusable (0000) persist
// dirs defeat the private-state intent and break the next save. The plain `mkdir -p` is enough.
const MKDIR_MODE_CMD = /\bmkdir\b[^\n]*\s(?:-m|--mode)(?:\s|=|$)/
const GITIGNORE_PATH = /(?:^|[/\\])\.gitignore$/
// Exactly one simple append: `echo|printf <args> >> .gitignore`, anchored at both ends. No prefix
// command, no chaining/pipe/substitution, no shell wrapper, no second redirect and no truncating
// `>`; quoted arguments are data and may contain anything.
const GITIGNORE_BASH =
  /^[ \t]*(?:echo|printf)\b(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|[^\s<>|;&()`$\\]+))*[ \t]+>>[ \t]*(?:'\.gitignore'|"\.gitignore"|\.gitignore)[ \t]*$/
// A Bash persist write mentions a persist path or `bd note`; a command that ALSO deletes, moves, resets or downloads is not a persist write.
const DESTRUCTIVE_CMD = /\b(rm|rmdir|mv|shred|truncate|dd|curl|wget|unlink|chmod|chown|tee|install|del|erase|nc|ncat|Remove-Item|Move-Item|Clear-Content|Set-Content)\b|(?:^|[;&|(]\s*)>[^>]|\bgit\s+(?:-\S+\s+(?:\S+\s+)?)*(checkout|clean|reset|restore|stash|rm|mv)\b|\b(?:unlink|rmtree|rmSync|removeSync)\b|\bfind\b[^\n]*-delete/
// Read-only tracker queries: recovery starts with `bd show` (recoveryText step 2), so blocking them would block recovery.
// `bd update --notes` REPLACES the notes field; this has lost bead history in practice.
export const NOTES_OVERWRITE_CMD = /\bbd\s+update\b[^|;&]*\s--notes(?:[=\s]|$)/
// Text inside quotes or a heredoc body is data, not flags: a note that MENTIONS `--notes` is not an overwrite.
export function shellCode(cmd) {
  return String(cmd)
    .replace(/<<-?\s*(['"]?)([^\s'"]+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, "<<HEREDOC")
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
}
// The text bash would actually execute substitutions in: single-quoted text and quoted-heredoc bodies are
// literal (blanked), a backslash-escaped character is literal (dropped); double-quoted text and unquoted
// heredoc bodies stay, because `$(...)` and backticks run there.
export function execCode(cmd) {
  let docs = ""
  const s = String(cmd).replace(/<<-?\s*(['"]?)([^\s'"]+)\1([^\n]*)\n([\s\S]*?)\n\s*\2(?=\n|$)/g, (m, q, id, rest, body) => {
    if (!q) docs += body + "\n"
    return "<<HEREDOC" + rest
  })
  let out = ""
  let q = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q === "'") {
      if (c === "'") q = ""
    } else if (c === "\\") i++
    else if (q === '"') {
      if (c === '"') q = ""
      else out += c
    } else if (c === "'" || c === '"') q = c
    else out += c
  }
  return out + "\n" + docs.replace(/\\[\s\S]/g, "")
}
// Quoted text handed to a shell interpreter is the program, not data: judge those commands on the raw text.
export const SHELL_WRAPPER = /\beval\b|\b(?:ba|z|da|k)?sh\b[^\n]*\s-\w*[cs]\b|\b(?:ba|z|da|k)?sh\b\s*<<|\|\s*(?:ba|z|da|k)?sh\b/
// Persist paths are blanked first (a file called rm.md is not a deletion); wrapped programs (bash -c, eval,
// heredoc to sh) are judged on the raw text, because quoted text handed to a shell IS the program.
const PERSIST_PATH_TOKEN = /[\w./-]*(?:\.opencode\/context\/|docs\/research\/)[\w./-]*/g
const PERSIST_MARK = /\.opencode\/context\/|docs\/research\//
const PERSIST_ROOTS = [path.join(".opencode", "context"), path.join("docs", "research")]
function resolveInProj(p, proj) {
  if (!p) return ""
  const base = path.resolve(proj || process.cwd())
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(base, p)
  const rel = path.relative(base, abs)
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? abs : ""
}
// realpath of the deepest existing ancestor plus the not-yet-created rest: a symlink inside a persist
// dir that points out of it must not turn that dir into a way out.
function realish(p) {
  const tail = []
  for (let head = p; ; ) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse())
    } catch {
      const up = path.dirname(head)
      if (up === head) return p
      tail.push(path.basename(head))
      head = up
    }
  }
}
// Is this one whole path (a space, non-ASCII or `+` in it is fine) strictly inside a persist dir of this
// project? `orRoot` also accepts the dir itself (what `mkdir -p .opencode/context/` names).
export function underPersistDir(p, proj, orRoot = false) {
  if (!p) return false
  const base = path.resolve(proj || process.cwd())
  const abs = realish(path.resolve(base, p))
  return PERSIST_ROOTS.some((root) => {
    const rel = path.relative(realish(path.join(base, root)), abs)
    return (orRoot || rel !== "") && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
  })
}
// Shell words with quotes and backslash escapes resolved; unquoted ; & | ( ) < > end a word (so a
// redirect target is its own word).
export function shellWords(cmd) {
  const words = []
  let cur = ""
  let has = false
  let q = ""
  const s = String(cmd)
  const flush = () => {
    if (has) words.push(cur)
    cur = ""
    has = false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = ""
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      q = c
      has = true
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i]
      has = true
    } else if (/\s/.test(c) || ";&|()<>".includes(c)) flush()
    else {
      cur += c
      has = true
    }
  }
  flush()
  return words
}
// A word that mentions a persist dir is a path unless it is prose: a quoted index line holds spaces and
// pipes. Paths start like paths, or have no whitespace and no pipe.
// A word with a `..` segment is a path unless it is a pipe-delimited prose line; a redirect target is always
// checked (see escapesPersistDir), whatever it looks like.
const pathLike = (w) => /^(?:\/|\.{1,2}\/|~|\.opencode\/|docs\/)/.test(w) || !/[\s|]/.test(w) || (!w.includes("|") && /(?:^|\/)\.\.(?:\/|$)/.test(w))
const REDIRECT_TARGET = /(?:>>?)\s*("[^"\n]*"|'[^'\n]*'|[^\s'"|;&<>]+)/g
// A persist path is allowed only while it still names something under this project's own persist dir:
// `.opencode/context/../../etc/x`, `.opencode/context-evil/` and another project's path are not.
function escapesPersistDir(text, proj) {
  if (!text) return false
  const t = normPath(String(text))
  const badTarget = [...t.matchAll(REDIRECT_TARGET)].some((m) => {
    const w = m[1].replace(/^["']|["']$/g, "")
    return PERSIST_MARK.test(w) && !underPersistDir(w, proj, true)
  })
  return badTarget || shellWords(t).some((w) => PERSIST_MARK.test(w) && pathLike(w) && !underPersistDir(w.replace(/^-[\w-]+=/, ""), proj, true))
}
// Windows-style persist paths (.opencode\context\x.md) are persist paths too.
export const normPath = (t) => String(t).replace(/(\.opencode)\\(context)\\/g, "$1/$2/").replace(/(docs)\\(research)\\/g, "$1/$2/")
// Every segment is prose or a persist command, so words like rm inside it are data, not a deletion.
const PROSE_SEGMENT = /^\s*(?:bd\s+(?:note|create|remember|update)\b|echo\b|printf\b|cat\b)/
export function isDestructive(cmd) {
  // quote-splitting (r''m) and backslash escapes (m\v) must not hide a verb
  const raw = normPath(cmd).replace(/(?<=\w)(?:''|"")(?=\w)/g, "").replace(/\\(?=[A-Za-z])/g, "")
  const wrapped = SHELL_WRAPPER.test(raw) || /\b(?:perl|python3?|node|ruby)\b\s+-\w*[ce]\b/.test(raw)
  const code = shellCode(raw)
  const subst = /\$\(|`/.test(execCode(raw))
  if (!wrapped && !subst && code.split(/&&|\|\||[;|&\n]/).filter((x) => x.trim()).every((x) => PROSE_SEGMENT.test(x.replace(/<<HEREDOC.*/, "")))) return DESTRUCTIVE_CMD.test(code.replace(/>\s*\S+/g, "").replace(/\bbd\s+\w+[^;|&\n]*/g, "BD").replace(/\b(echo|printf)\b[^;|&\n]*/g, "$1"))
  const text = wrapped || subst ? raw : code
  return DESTRUCTIVE_CMD.test(text.replace(PERSIST_PATH_TOKEN, (m) => (m.includes("..") ? m : "PATH")))
}
export function isNotesOverwrite(cmd) {
  const raw = String(cmd)
  return NOTES_OVERWRITE_CMD.test(shellCode(raw)) || (SHELL_WRAPPER.test(raw) && NOTES_OVERWRITE_CMD.test(raw))
}
export function isMarkerTool(name, env = process.env) {
  const names = envList(env.APCC_MARKER_TOOLS ?? "post_message")
  return names.some((n) => name === n || String(name ?? "").endsWith("__" + n))
}
const READ_CMD = /^\s*(?:bd\s+(?:show|list|ready|prime|history|search|count|stats|blocked|children)\b|(?:pwd|ls|cat)(?:\s|$))/
// The recovery contract tells the model to rebuild from `git status` / `git diff`, so those (and
// `git log`) must pass a closed gate too. --output/-o writes a file, so it is not a read.
const GIT_READ_CMD = /^\s*git\s+(?:status|diff|log)\b/
// --output/-o writes a file; --ext-diff and --textconv run a program configured in git (or a
// filter), so they are not reads. The --no- forms are fine and do not match.
const GIT_READ_UNSAFE = /--output\b|--ext-diff\b|--textconv\b|(?:^|\s)-o(?:\s|=|$)/
const SHELL_UNSAFE = /[;&|<>`\n]|\$\(/ // chaining, pipes, redirects, substitution: not a plain read

// Pure decision: once the model has been told (first nudge) and the grace has passed, only persisting
// (and reading) may proceed. The second nudge fires REARM_TOKENS after the first, i.e. at the
// compaction point, so waiting for it meant the gate could never engage before compaction.
// Persist writes are always allowed, so even the hard zone cannot deadlock a session.
export const envList = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean)
export function decideGate({ tool, toolInput, st, tokens, threshold, compactAt = 0, env = process.env, proj = process.cwd() }) {
  if (threshold <= 0 || tokens < threshold) return { allow: true }
  if (isCovered(st, tokens)) return { allow: true }
  const nudges = st.nudges ?? 0
  if (nudges < 1) return { allow: true }
  if (nudges < MAX_NUDGES && (st.nudgeCalls ?? 0) <= GATE_GRACE_CALLS) return { allow: true }
  const hardZone = compactAt > 0 && tokens >= compactAt - HARD_ZONE_TOKENS
  if ((st.gateDenials ?? 0) >= MAX_GATE_DENIALS && !hardZone) return { allow: true }
  if (["Read", "Grep", "Glob", "TaskOutput", "Skill", "AskUserQuestion", "TodoWrite", "ToolSearch", "ExitPlanMode", "KillShell", "TaskStop"].includes(tool)) return { allow: true }
  if (envList(env.APCC_GATE_ALLOW_TOOLS).some((p) => String(tool).startsWith(p))) return { allow: true } // e.g. an MCP server that is the only way to reach the user
  const target = normPath(toolInput?.file_path ?? toolInput?.command ?? "")
  const plainRead = READ_CMD.test(target) || (GIT_READ_CMD.test(target) && !GIT_READ_UNSAFE.test(target))
  if (tool === "Bash" && plainRead && !SHELL_UNSAFE.test(target.replace(/\s*2>&1\s*\|\s*(head|tail)(\s+-?\d+)?\s*$/, ""))) return { allow: true }
  // An allowance by persist path is only for this project's own persist dir; a `..` that leaves
  // it (or another project's absolute path) is not the setup the nudge asked for.
  const escapes = tool === "Bash" && escapesPersistDir(target, proj)
  const targetInProj = resolveInProj(target, proj)
  const persistSetup =
    (tool === "Bash" && !isDestructive(target) && !escapes && (PERSIST_DIR_MKDIR.test(target) || GITIGNORE_BASH.test(target))) ||
    (["Write", "Edit"].includes(tool) && GITIGNORE_PATH.test(targetInProj))
  if (persistSetup) return { allow: true }
  const persistCall =
    (["Write", "Edit"].includes(tool) && underPersistDir(target, proj)) ||
    (tool === "Bash" && (PERSIST_CMD.test(target) || PERSIST_DEST.test(target)) && !isDestructive(target) && !MKDIR_MODE_CMD.test(target) && !escapes)
  if (persistCall) return { allow: true, completes: (tool === "Bash" ? INDEX_WRITE_BASH.test(target) : INDEX_PATH.test(target)) }
  return { allow: false }
}

const k = (n) => `${Math.round(n / 1000)}k`

export function nudgeText({ tokens, threshold, which, beads = true, beadsNoBd = false, skill = "persisting-context" }) {
  const head =
    which === 3
      ? `[apcc] Context is ~${k(tokens)} tokens, right at the auto-compact window. Host compaction is imminent. Persist ONLY what changed since your last persist (new decisions, progress, exact next action), as small units.`
      : which === 1
      ? `[apcc] Context is ~${k(tokens)} tokens (persist threshold ${k(threshold)}). Persist now, at the next safe boundary: finish the atomic step you are on, never abandon in-flight edits.`
      : `[apcc] Final reminder: context is ~${k(tokens)} tokens and nothing has been persisted this context. Persist at the next safe boundary.`
  return [
    head,
    ...(beadsNoBd ? [BEADS_NO_BD_LINE] : []),
    "Save what compaction would lose, as small linked units (one fact each; what + why + state + next action):",
    ...(beads
      ? [
          "- progress / blocker / decision / next action on the bead you are working on -> `bd note <id> --stdin` (REQUIRED whenever a bead is in play: recovery re-reads beads first, so state kept only in session-notes is easy to miss)",
          '- durable decision -> `bd create "Decision: <slug>" -t decision`',
        ]
      : []),
    "- research or reusable findings -> docs/research/<topic>.md (one ## section per finding)",
    "- in-flight state (where I am, tried/failed, exact next action) -> .opencode/context/session-notes.md (newest on top)",
    "Append one line per unit to .opencode/context/index.md: `| date | slug | destination | one-line summary |` (first, if `.opencode/` is not gitignored yet, run exactly `echo '.opencode/' >> .gitignore` as its own command; a compound command is not accepted while the gate is engaged).",
    "Skip tool output, resolved dead-ends, and anything re-derivable from the repo in seconds.",
    "Then end that reply with the marker as its LAST line: `PERSISTED: <n> units (<slugs>)`, or `PERSISTED: none` if nothing needed saving. If the user asked you to persist, use the manual form exactly: `PERSISTED (manual): <n> units (<slugs>)` (or `PERSISTED (manual): none`). A persist never ends a turn: keep working afterwards.",
    `Skill: ${skill}`,
  ].join("\n")
}

export function recoveryText({ source, st, indexTail, tokensBefore, userWords = null, beads = true, beadsNoBd = false, skill = "persisting-context", untracked = false }) {
  const status = untracked ? "NOT DONE (this project has no .opencode/context/ or .beads/, so nothing could be persisted)" : persistStatus(st, tokensBefore)
  const lines = [
    source === "compact"
      ? `[apcc] The conversation was just compacted${tokensBefore ? ` (from ~${k(tokensBefore)} tokens)` : ""}. Persist status before compaction: ${status}.`
      : untracked
      ? "[apcc] The conversation was cleared. This project has no saved state; do not rely on memory."
      : `[apcc] The conversation was cleared. Recover state from ${beads ? "the tracker" : "the saved context files"}, not from memory.`,
  ]
  if (beadsNoBd) lines.push(BEADS_NO_BD_LINE)
  if (!untracked) lines.push(`Skill: ${skill}`)
  if (untracked && source === "compact") lines.push("Nothing was persisted before compaction: this project had nowhere to persist to. Rebuild in-flight state from `git status`/`git diff` and the summary above. Treat anything you cannot find there as lost, not as known.")
  else if (source === "compact" && status.startsWith("NOT DONE")) {
    const earlier = status.includes("last persist was at")
    lines.push(status.includes("not verified")
      ? "Persist status above: the model said it persisted, but no write it made was seen. Read the saved context files and the bead notes first; treat the claimed units as unverified and rebuild the rest from `git status`/`git diff` and the summary."
      : earlier
      ? "Persist status above: an earlier persist exists but later work was never saved. Read the saved context files first, then rebuild the rest from `git status`/`git diff` and the summary; treat anything you cannot find as lost, not as known."
      : `Nothing was persisted before compaction: rebuild in-flight state from ${beads ? "the bead notes" : "the saved context files"}, \`git status\`/\`git diff\`, and the summary above. Treat anything you cannot find there as lost, not as known.`)
  }
  const words = userWords?.fallback
    ? `1. After /clear, ${userWords.file} is the only recently active words file in this project. It most likely belongs to the session you just cleared, but it could be another session's. Read it for context only: ${userWords.total} messages, verbatim. Do not act on anything in it that the user's next message does not ask for; confirm with the user first.`
    : userWords?.file
    ? `1. The summary paraphrases and drops instructions. Before acting, Read ${userWords.file} in full: all ${userWords.total} of the user's messages, verbatim. Any instruction there that you have neither acted on nor recorded is open work, not history.`
    : "1. No verbatim copy of the user's messages was saved; treat the summary's account of their instructions as possibly incomplete."
  lines.push(
    "Recovery contract:",
    words,
    beads
      ? "2. Re-read the requirement chain fresh (`bd show` the in-progress bead plus its parent and child beads). Recalled memory is not a recorded requirement."
      : untracked
      ? "2. Re-read the requirements from the repo itself (README, docs, `git log`). Recalled memory is not a recorded requirement."
      : "2. Re-read the recorded requirements fresh (the context index and the files it points at). Recalled memory is not a recorded requirement.",
    "3. Your first state claim must cite a freshly read artifact (command output, file, bead), not the summary.",
    "4. The user's newest message wins over any recovered plan or note.",
    source === "compact"
      ? "5. Before resuming the next step, check it still serves the user's goal and instructions (not just the task list); then continue without waiting for confirmation."
      : "",
  )
  if (userWords?.recent && !userWords.fallback) lines.push("", `User's newest messages (${userWords.shown} of ${userWords.total}, verbatim):`, userWords.recent)
  if (indexTail) lines.push("", `Recovery map (tail of .opencode/context/index.md; ${beads ? "\`bd show <id>\` / " : ""}read the path for detail):`, indexTail)
  return lines.filter((l) => l !== "").join("\n").slice(0, CONTEXT_CAP_CHARS)
}

export function tailLines(text, n, maxChars = 3_000) {
  const out = text.split("\n").filter((l) => l.trim()).slice(-n).join("\n")
  return out.length > maxChars ? out.slice(out.length - maxChars) : out
}

// ---- user's words: the lossless layer under the lossy compaction summary ----
// Compaction summaries paraphrase and drop instructions (observed: a user's budget limits and main
// complaint both vanished across compactions).
// Before each compaction, every message the user typed is copied verbatim to a file; restore
// shows the newest ones inline and points at the file for the rest.

const NOISE_PREFIXES = ["<task-notification", "<local-command-stdout", "<local-command-caveat", "[Request interrupted"]

export function cleanUserText(raw) {
  let text = String(raw ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/)
  if (cmd) text = `${cmd[1].trim()} ${cmd[2].trim()}`.trim()
  if (!text || NOISE_PREFIXES.some((p) => text.startsWith(p))) return ""
  return text
}

function partsText(c) {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.filter((p) => p?.type === "text").map((p) => p.text).join("\n")
  return ""
}

export function userMessages(jsonlText) {
  const out = []
  const seen = new Set()
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    if (r.isSidechain) continue
    let raw
    if (r.type === "user" && !r.isMeta && !r.isCompactSummary) raw = partsText(r.message?.content)
    else if (r.type === "attachment" && r.attachment?.type === "queued_command") raw = partsText(r.attachment.prompt) // typed while Claude was busy
    else continue
    const text = cleanUserText(raw)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push({ ts: r.timestamp ?? "", text })
  }
  return out
}

export function userWordsMarkdown(msgs) {
  return [`# User's words, verbatim (${msgs.length} messages, oldest first)`, "", ...msgs.map((m) => `## ${m.ts}\n${m.text}\n`)].join("\n")
}

// Newest messages that fit the budget, oldest first.
export function recentUserWords(markdown, maxChars = 3_500) {
  const sections = markdown.split(/\n(?=## )/).slice(1)
  const picked = []
  let used = 0
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i].trim()
    if (used + s.length > maxChars) {
      if (!picked.length) picked.push(`${s.slice(0, maxChars)} …[truncated]`)
      break
    }
    picked.unshift(s)
    used += s.length + 1
  }
  return { text: picked.join("\n"), shown: picked.length, total: sections.length }
}

export function userWordsFile(proj, sessionId, env = process.env) {
  const f = stateFile(proj, env)
  return path.join(path.dirname(f), wordsNameFor(f, sessionId))
}

// /clear starts a new session id. The session that was just cleared is usually the project's one
// recently active words file; with more than one recent candidate (concurrent sessions) or only an
// old one, naming a file would hand another session's instructions to this one, so name none.
const CLEAR_FALLBACK_MS = 15 * 60_000
function latestUserWordsFile(proj, sessionId, env, source = "compact", now = Date.now()) {
  const own = userWordsFile(proj, sessionId, env)
  if (fs.existsSync(own)) return { file: own, fallback: false }
  if (source !== "clear") return null
  const dir = path.dirname(own)
  const prefix = path.basename(own).replace(/-[^-]+\.md$/, "-")
  try {
    const recent = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
      .map((f) => path.join(dir, f))
      .filter((f) => now - fs.statSync(f).mtimeMs <= CLEAR_FALLBACK_MS)
    return recent.length === 1 ? { file: recent[0], fallback: true } : null
  } catch (e) {
    warn("readdir user-words", e)
    return null
  }
}

// ---- state (user-level, never inside the project) ----

export function stateFile(proj, env = process.env) {
  const base = env.APCC_CC_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "apcc-cc")
  return path.join(base, `state-${crypto.createHash("sha1").update(proj).digest("hex").slice(0, 12)}.json`)
}

function loadState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"))
    return s && typeof s === "object" && s.sessions ? s : { sessions: {} }
  } catch (e) {
    warn("read state", e)
    return { sessions: {} }
  }
}

// The state dir also holds user-words files, i.e. every message the user typed verbatim, so
// owner-only modes are the floor. A dir created by an older version keeps its wider mode.
function ensurePrivateDir(dir) {
  // Parents apcc has to create (a fresh ~/.local/state) are not apcc's to close to the group:
  // create them with the default mode, then the leaf itself 0700.
  const parent = path.dirname(dir)
  if (parent && parent !== dir) fs.mkdirSync(parent, { recursive: true })
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (e) {
    if (e.code !== "EEXIST") throw e
  }
  try {
    fs.chmodSync(dir, 0o700) // a dir made by an older version may still be 0755
  } catch (e) {
    warn("chmod state dir", e)
  }
}

function writePrivate(file, data) {
  fs.writeFileSync(file, data, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600) // a file written by an older version may already be 0644
  } catch (e) {
    warn("chmod " + path.basename(file), e)
  }
}

// The words-file name a state file's directory would use for this session id.
const wordsNameFor = (statePath, sessionId) =>
  path.basename(statePath).replace(/^state-([0-9a-f]+)\.json$/, `user-words-$1-${String(sessionId).slice(0, 8)}.md`)

// Same 30-day sweep as sessions: user-words files are one per session and would otherwise pile up.
// The live session's file is never pruned (a long session that has not compacted in a month would
// otherwise lose the file /clear recovery points at), and only regular files are candidates.
function pruneUserWords(dir, now, keep = "") {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (e) {
    if (e.code !== "ENOENT") warn("prune user-words", e)
    return
  }
  for (const name of names) {
    if (!name.startsWith("user-words-") || !name.endsWith(".md") || name === keep) continue
    const f = path.join(dir, name)
    let s
    try {
      s = fs.statSync(f)
    } catch (e) {
      if (e.code !== "ENOENT") warn("prune user-words", e)
      continue
    }
    if (!s.isFile() || now - s.mtimeMs <= RETENTION_MS) continue
    try {
      fs.rmSync(f, { force: true })
    } catch (e) {
      warn("prune user-words", e)
    }
  }
}

function saveState(file, state, now, sessionId = "") {
  for (const [id, s] of Object.entries(state.sessions)) if (now - (s.updatedAt ?? 0) > RETENTION_MS) delete state.sessions[id]
  pruneUserWords(path.dirname(file), now, sessionId ? wordsNameFor(file, sessionId) : "")
  ensurePrivateDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writePrivate(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file) // atomic
}

// Tiny cross-process lock: parallel PostToolUse hooks must not both nudge.
function withLock(file, fn) {
  const lock = `${file}.lock`
  ensurePrivateDir(path.dirname(file))
  for (let i = 0; i < 40; i++) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600))
      try {
        return fn()
      } finally {
        fs.rmSync(lock, { force: true })
      }
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) fs.rmSync(lock, { force: true }) // stale
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
  return fn() // lock never freed: proceed unlocked rather than block the session
}

function projectDir(input, env) {
  return env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
}

// The script installer copies the runtime to this path. When it exists AND the plugin is what is
// running the hooks, both copies fire: Claude Code does not dedupe a plugin's copy of the same
// handler, so restore would bump the epoch twice and nudge would repeat itself.
export const SCRIPT_INSTALL_REL = path.join("hooks", "apcc", "claude-apcc", "apcc.mjs")
const SCRIPT_INSTALL_MARK = "/" + SCRIPT_INSTALL_REL.replace(/\\/g, "/")
// An install only fires when settings.json actually wires its hook command. The file alone can be
// a leftover from an aborted install; standing down for it would make the plugin inert while
// claiming that both installs are active.
function settingsWiresInstall(v) {
  if (Array.isArray(v)) return v.some(settingsWiresInstall)
  if (v && typeof v === "object") return Object.values(v).some(settingsWiresInstall)
  return typeof v === "string" && v.replace(/\\/g, "/").includes(SCRIPT_INSTALL_MARK)
}
function installWired(dir) {
  try {
    return settingsWiresInstall(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")))
  } catch {
    return false
  }
}
function installDirs(env, proj) {
  // env.HOME first (the hook's env is what the host passed), so tests can simulate a home.
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude")
  // `node scripts/install.mjs --project` writes under <project>/.claude, not the user's config dir.
  return proj ? [claudeDir, path.join(proj, ".claude")] : [claudeDir]
}
// Wired AND the hook file exists. A wired entry whose file was deleted runs nothing (the host only
// prints "hook missing"), so the plugin must not stand down for it.
export function scriptInstallPresent(env = process.env, proj = "") {
  return installDirs(env, proj).some((d) => installWired(d) && fs.existsSync(path.join(d, SCRIPT_INSTALL_REL)))
}
function scriptInstallBroken(env, proj) {
  return installDirs(env, proj).some((d) => installWired(d) && !fs.existsSync(path.join(d, SCRIPT_INSTALL_REL)))
}
const BROKEN_INSTALL_LINE = "apcc: settings.json wires the script install's hook file, but the file is missing, so the script install is broken and the plugin is running instead. Rerun `node scripts/install.mjs` (or `node scripts/install.mjs --uninstall` to drop the wiring)."
export const STANDDOWN_MESSAGE =
  "apcc: both the plugin and the script install are active, so the plugin is standing down to avoid double-firing. Remove the script install: node scripts/install.mjs --uninstall (add --project if you installed per project)."

export const hasBeadsDir = (proj) => {
  try {
    return fs.statSync(path.join(proj, ".beads")).isDirectory()
  } catch {
    return false
  }
}

// A `.beads/` directory is not enough: the hook's messages tell the model to run `bd`, which fails
// when the binary is not on the hook process's PATH (it can differ from the Bash tool's PATH).
// Scan PATH entries with access(X_OK); never spawn, so the 10 s budget stays safe. Cached per
// session in state, because PATH does not change during a session.
const BD_BINARIES = process.platform === "win32" ? ["bd.exe", "bd.cmd", "bd"] : ["bd"]
export function bdOnPath(env = process.env) {
  for (const dir of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of BD_BINARIES) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK)
        return true
      } catch {}
    }
  }
  return false
}

// Shown when `.beads/` exists but `bd` is not on PATH: route to the always-available
// context files instead. Says "not on PATH", never "not installed" (the PATH is the hook's).
export const BEADS_NO_BD_LINE = "`.beads/` found but `bd` is not on PATH, using .opencode/context instead."

// Only act where persistence has somewhere to go.
export function isTracked(proj) {
  return hasBeadsDir(proj) || fs.existsSync(path.join(proj, ".opencode", "context"))
}

function readJsonSettings(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"))
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch (e) {
    warn("read settings", e)
    return {}
  }
}

// Read settings in the host's precedence order: project-local beats project beats user. Managed
// settings and --settings cannot be seen from here, so callers must say "not found", not "not set".
export function readSettings(env = process.env, proj = process.cwd()) {
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
  const user = readJsonSettings(path.join(cfg, "settings.json"))
  const project = readJsonSettings(path.join(proj, ".claude", "settings.json"))
  const local = readJsonSettings(path.join(proj, ".claude", "settings.local.json"))
  return { ...user, ...project, ...local }
}

// A plugin cannot set autoCompactWindow (its settings only apply `agent` and `subagentStatusLine`).
// Tell the user once per session instead of writing anything.
export const WINDOW_HINT =
  'apcc: autoCompactWindow not found; add "autoCompactWindow": 180000 to settings.json so the persist threshold matches your compaction point.'

const out = (obj) => process.stdout.write(JSON.stringify(obj))

// ---- untracked project: no persist destination yet ----
// A project with neither `.opencode/context/` nor `.beads/` used to get total silence, so a model
// in a fresh repo lost its state to compaction without ever being asked to save it. One small
// exception keeps the opt-in honest: one startup line saying how to switch apcc on. Nothing is
// written into the project and the model is never asked to create anything. The user's words are the exception that costs nothing:
// they are captured at PreCompact and pointed to on restore, in the state dir. APCC_CC_UNTRACKED=0 restores total silence.
export const UNTRACKED_HINT =
  "apcc: this project has no .opencode/context/ or .beads/, so no work state is saved before compaction and the gate is off. Your own messages are still copied verbatim at compaction (to apcc's state dir, not the project) and pointed to afterwards. Run `mkdir -p .opencode/context` to switch full persistence on."
// Save the user's words verbatim before the summary replaces them. They go to the state dir, not the project.
function saveUserWords(input, proj, env) {
  try {
    if (input.transcript_path && fs.existsSync(input.transcript_path)) {
      const msgs = userMessages(fs.readFileSync(input.transcript_path, "utf8"))
      if (msgs.length) {
        const wf = userWordsFile(proj, input.session_id, env)
        ensurePrivateDir(path.dirname(wf))
        writePrivate(wf, userWordsMarkdown(msgs))
      }
    }
  } catch (e) {
    warn("save user-words", e)
  }
}
function untrackedHandle(event, input, env, proj, now) {
  if (env.APCC_CC_UNTRACKED === "0" || env.APCC_CC_UNTRACKED === "false") return null
  if (input.agent_id) return null
  if (env.CLAUDE_PLUGIN_ROOT && scriptInstallPresent(env, proj)) return null // the script install speaks; never both
  if (event === "precompact") {
    saveUserWords(input, proj, env)
    return null
  }
  if (event === "restore") {
    if (input.source === "startup") return { systemMessage: UNTRACKED_HINT }
    if (input.source !== "compact" && input.source !== "clear") return null
    let userWords = null
    try {
      const wf = latestUserWordsFile(proj, input.session_id, env, input.source, now)
      if (wf) userWords = { file: wf.file, fallback: wf.fallback, ...(({ text, shown, total }) => ({ recent: text, shown, total }))(recentUserWords(fs.readFileSync(wf.file, "utf8"))) }
    } catch (e) {
      warn("read user-words", e)
    }
    if (input.source === "clear" && !userWords) return null
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: recoveryText({ source: input.source, st: freshSession(now), indexTail: "", tokensBefore: 0, userWords, beads: false, untracked: true, skill: skillName(env) }) } }
  }
  return null // no late nudge: without .beads/ (or .opencode/context/) apcc only copies your words and says so at startup
}

export function handle(event, input, env = process.env, now = Date.now()) {
  if (env.APCC_CC === "0" || env.APCC_CC === "false") return null
  // Opt-in guard: a hook entry that sets this only acts in cloud sessions, so a copy wired into
  // project settings cannot double-nudge on the user's laptop, where the user-level hooks run apcc.
  if (env.APCC_CC_REMOTE_ONLY === "1" && env.CLAUDE_CODE_REMOTE !== "true") return null
  // Running as a plugin while a script install is also wired up: stand aside, so nudge, gate,
  // stop, precompact and restore cannot fire twice. Tell the user once per session, at startup.
  // A `--project` install lives under the project's .claude, so the project dir is part of the check.
  const proj = projectDir(input, env)
  // Only act where persistence has somewhere to go: an untracked project only gets the startup hint,
  // including the stand-down notice and its state write.
  if (!input.session_id) return null
  if (!isTracked(proj)) return untrackedHandle(event, input, env, proj, now)
  if (env.CLAUDE_PLUGIN_ROOT && scriptInstallPresent(env, proj)) {
    if (event !== "restore" || input.source !== "startup") return null
    const file = stateFile(proj, env)
    return withLock(file, () => {
      const state = loadState(file)
      const st = state.sessions[input.session_id] ?? freshSession(now)
      if (st.standDownNoticed) return null
      st.standDownNoticed = true
      st.updatedAt = now
      state.sessions[input.session_id] = st
      saveState(file, state, now, input.session_id)
      return { systemMessage: STANDDOWN_MESSAGE }
    })
  }
  const file = stateFile(proj, env)
  const settings = readSettings(env, proj)
  return withLock(file, () => {
    const state = loadState(file)
    delete state.learnedReserve // legacy one-way scalar: unverifiable, never trusted again
    const win = resolveWindow(env, settings)
    const reserve = learnedReserve(state.compactions, win)
    const threshold = resolveThreshold(env, settings, reserve)
    const compactAt = compactPoint(win, reserve, autocompactPct(env))
    let st = state.sessions[input.session_id] ?? freshSession(now)
    if (typeof st.bdOnPath !== "boolean") st.bdOnPath = bdOnPath(env) // cached for this session
    const beadsDir = hasBeadsDir(proj)
    const beads = beadsDir && st.bdOnPath
    const beadsNoBd = beadsDir && !st.bdOnPath
    let result = null

    if (event === "nudge") {
      if (input.agent_id) return null // subagent: its own context, not the main window
      if (!input.transcript_path || !fs.existsSync(input.transcript_path)) return null
      if (st.learnPending) {
        st.learnPending = false
        const seen = new Set((state.compactions ?? []).map((c) => c.boundaryAt).filter(Boolean))
        for (const bd of compactBoundaries(fs.readFileSync(input.transcript_path, "utf8")))
          if (bd.trigger === "auto" && win > 0 && bd.pre > 0 && bd.pre < win && !seen.has(bd.ts))
            state.compactions = [...(state.compactions ?? []), { window: win, pre: bd.pre, at: now, boundaryAt: bd.ts }].slice(-MAX_RESERVE_SAMPLES)
      }
      const tokens = lastMainContextTokens(readTail(input.transcript_path))
      // Compaction/clear that SessionStart did not announce: the meter fell off a cliff.
      if (st.lastTokens > 0 && tokens > 0 && tokens < st.lastTokens * 0.6) st = newEpoch(st, now)
      if (tokens > 0) st.lastTokens = tokens
      const window = win
      if (window > 0 && tokens > window * 1.05 && st.windowWarnedEpoch !== st.epoch) {
        // Past the configured window with no compaction: the setting is not in effect in this
        // session (it is read at startup, so a running session may keep its original value).
        st.windowWarnedEpoch = st.epoch
        result = { systemMessage: `apcc: context is ~${k(tokens)} tokens, past your auto-compact window (${k(window)}), but nothing compacted. The setting ("autoCompactWindow" in settings.json) applies at session start; restart Claude Code so unattended runs compact on their own.` }
      }
      const which = decideNudge({ tokens, threshold, st, now, compactAt })
      if (which) {
        if (which === 3) st.deltaEpoch = st.epoch
        else st.nudges = which
        // Only a persist made after the latest first nudge backs a claim: an earlier write is stale.
        // A claim is backed only by a persist write at or after this floor (token reading of the write):
        // a first nudge accepts a write from just before it (inside the fresh span) but not an earlier
        // cycle's; a delta nudge needs a write after the nudge itself.
        if (which === 1) {
          st.claimedEpoch = -1 // an earlier cycle's unbacked claim is not this cycle's
          st.verifyFloor = Math.max(0, threshold - PERSIST_FRESH_TOKENS, st.persistedEpoch === st.epoch ? st.persistedTokens + 1 : 0)
          st.nudgeCalls = 0 // a new cycle gets its own grace
        } else if (which === 3) st.verifyFloor = tokens
        st.lastNudgeAt = now
        st.lastNudgeTokens = tokens
        result = { ...result, hookSpecificOutput: { hookEventName: input.hook_event_name || "UserPromptSubmit", additionalContext: nudgeText({ tokens, threshold, which, beads, beadsNoBd, skill: skillName(env) }) } }
      }
    } else if (event === "gate") {
      // Where the reply is delivered by a tool call (APCC_MARKER_TOOLS, default post_message), the Stop hook's
      // last_assistant_message never holds the PERSISTED line: read it from the tool input here.
      if (!input.agent_id && isMarkerTool(input.tool_name, env)) {
        const marker = parseMarker(input.tool_input?.text)
        if (marker.kind !== "none") recordMarker(st, marker, input.transcript_path && fs.existsSync(input.transcript_path) ? lastMainContextTokens(readTail(input.transcript_path)) : st.lastTokens, claimBacked(st))
      }
      // Bead notes are append-only history, for subagents too.
      if (input.tool_name === "Bash" && isNotesOverwrite(input.tool_input?.command ?? ""))
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "[apcc] `bd update --notes` replaces the bead's whole notes history. Append instead: `bd note <id> --stdin` (or `bd update <id> --append-notes ...`).",
          },
        }
      if (input.agent_id) {
        // A persist delegated to a subagent in this project backs the main thread's claim. The subagent is
        // never gated and never spends the main thread's grace; only the verification record is credited.
        if (isPersistWrite(input.tool_name, normPath(input.tool_input?.file_path ?? input.tool_input?.command ?? ""), proj)) {
          st.wroteEpoch = st.epoch
          st.wroteTokens = st.lastTokens || 1 // 0 would read as "unknown, counts"; no reading yet means early in the context
          st.updatedAt = now
          state.sessions[input.session_id] = st
          saveState(file, state, now, input.session_id)
        }
        return null
      }
      // st.lastTokens comes from the PostToolUse nudge, which sees the transcript one assistant
      // message behind this call (it misses the latest tool result). Read the transcript here.
      const fresh = input.transcript_path && fs.existsSync(input.transcript_path) ? lastMainContextTokens(readTail(input.transcript_path)) : 0
      const tokens = fresh > 0 ? fresh : st.lastTokens || 0
      st.nudgeCalls = (st.nudges ?? 0) >= 1 ? (st.nudgeCalls ?? 0) + 1 : 0 // tool calls since the first nudge: the grace is counted in these
      const g = decideGate({ tool: input.tool_name, toolInput: input.tool_input, st, tokens, threshold, compactAt, env, proj })
      // A persist write made close to the threshold counts even when the gate was not engaged yet:
      // compaction can land before the Stop hook ever sees a PERSISTED marker (seen in live testing).
      const target = normPath(input.tool_input?.file_path ?? input.tool_input?.command ?? "")
      const earlyPersist =
        g.allow &&
        !(input.tool_name === "Bash" && isDestructive(target)) &&
        tokens >= threshold - PERSIST_FRESH_TOKENS &&
        ((["Write", "Edit"].includes(input.tool_name) && INDEX_PATH.test(target)) ||
          (input.tool_name === "Bash" && (PERSIST_CMD.test(target) || INDEX_WRITE_BASH.test(target))))
      if (g.allow && isPersistWrite(input.tool_name, target, proj)) {
        st.wroteEpoch = st.epoch
        st.wroteTokens = tokens
      }
      if (g.completes || earlyPersist) {
        // Count the write as a unit: in project threads the reply often ends in a tool call, so the
        // Stop hook never sees the PERSISTED marker and units stayed 0 ("NOT NEEDED" after a real persist).
        st.units = (st.persistedEpoch === st.epoch ? st.units ?? 0 : 0) + 1
        st.persists = (st.persists ?? 0) + 1
        st.claimedEpoch = -1
        st.persistedEpoch = st.epoch
        st.persistedTokens = tokens
        st.nudges = 0
        st.nudgeCalls = 0
        st.lastNudgeAt = 0
      }
      if (!g.allow) {
        st.gateDenials = (st.gateDenials ?? 0) + 1
        result = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: denyReason({ tokens, beads, claimed: st.claimedEpoch === st.epoch, destructivePersist: input.tool_name === "Bash" && (PERSIST_CMD.test(target) || PERSIST_DEST.test(target)) && isDestructive(target) }),
          },
        }
      }
    } else if (event === "stop") {
      // Live proof that the Stop hook runs: every main-session stop is counted with its time.
      if (!input.agent_id) {
        st.stops = (st.stops ?? 0) + 1
        st.lastStopAt = now
      }
      const marker = input.agent_id ? { kind: "none" } : parseMarker(input.last_assistant_message) // a subagent's reply is not the main thread's claim
      if (marker.kind !== "none") {
        recordMarker(st, marker, input.transcript_path && fs.existsSync(input.transcript_path) ? lastMainContextTokens(readTail(input.transcript_path)) : st.lastTokens, claimBacked(st))
        if (marker.kind === "persisted" && claimBacked(st)) {
          const tokens = input.transcript_path && fs.existsSync(input.transcript_path) ? lastMainContextTokens(readTail(input.transcript_path)) : st.lastTokens
          if (tokens >= threshold)
            result = {
              systemMessage: `apcc: ${marker.units} unit(s) persisted at ~${k(tokens)} tokens. NOT compacted: hooks cannot run /compact. If you are here, run /compact now (state is saved). Unattended, the host auto-compacts at ${compactAt > 0 ? `~${k(compactAt)}` : "its window"} and recovers from the saved state.`,
            }
        }
      }
    } else if (event === "precompact") {
      if (input.agent_id) return null // a subagent's own compaction says nothing about the main window
      st.compactingAt = now
      // The host does not report its token count here; read the main transcript like the nudge does.
      const fromTranscript = input.transcript_path && fs.existsSync(input.transcript_path) ? lastMainContextTokens(readTail(input.transcript_path)) : 0
      st.tokensBefore = input.context_tokens_before ?? (fromTranscript || st.lastTokens)
      st.compactTrigger = input.trigger
      st.compactStatus = persistStatus(st, st.tokensBefore)
      saveUserWords(input, proj, env)
      // observational only: must never block compaction
    } else if (event === "restore") {
      const source = input.source
      if (source === "compact" || source === "clear") {
        const tokensBefore = source === "compact" ? st.tokensBefore || st.lastTokens : 0
        const statusSnapshot = { ...st } // status as of the context that just ended
        // A PreCompact/SessionStart pair also fires without any real compaction (seen when background
        // subagents finished), so it only schedules learning; the transcript's compact_boundary is the ground truth.
        const learnPending = source === "compact" && st.compactTrigger === "auto"
        st = newEpoch(st, now)
        if (learnPending) st.learnPending = true
        let indexTail = ""
        try {
          indexTail = tailLines(fs.readFileSync(path.join(proj, ".opencode", "context", "index.md"), "utf8"), 15)
        } catch (e) {
          warn("read index.md", e)
        }
        let userWords = null
        try {
          const wf = latestUserWordsFile(proj, input.session_id, env, source, now)
          if (wf) userWords = { file: wf.file, fallback: wf.fallback, ...(({ text, shown, total }) => ({ recent: text, shown, total }))(recentUserWords(fs.readFileSync(wf.file, "utf8"))) }
        } catch (e) {
          warn("read user-words", e)
        }
        if (source === "compact" || indexTail || userWords)
          result = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: recoveryText({ source, st: statusSnapshot, indexTail, tokensBefore, userWords, beads, beadsNoBd, skill: skillName(env) }) } }
      } else if (source === "startup") {
        // Two once-per-session startup notices, combined into one systemMessage when both apply:
        // `.beads/` without `bd` on PATH, and no autoCompactWindow visible to the hook. The script
        // install sets the window itself, so it never needs the second one.
        const msgs = []
        if (beadsNoBd && !st.bdWarned) {
          st.bdWarned = true
          msgs.push("apcc: " + BEADS_NO_BD_LINE)
        }
        if (env.CLAUDE_PLUGIN_ROOT && !st.brokenInstallWarned && scriptInstallBroken(env, proj)) {
          st.brokenInstallWarned = true
          msgs.push(BROKEN_INSTALL_LINE)
        }
        if (!scriptInstallPresent(env, proj) && resolveWindow(env, settings) === 0 && !st.windowHinted) {
          st.windowHinted = true
          msgs.push(WINDOW_HINT)
        }
        if (msgs.length) result = { systemMessage: msgs.join("\n") }
      } else if (source === "resume" && input.prompt_cache_likely_expired && (input.context_tokens ?? 0) >= threshold) {
        const usd = typeof input.estimated_cache_write_usd === "number" ? ` (re-caching ≈ $${input.estimated_cache_write_usd.toFixed(2)})` : ""
        result = {
          systemMessage: `apcc: resumed a ~${k(input.context_tokens)}-token session after ${Math.round((input.seconds_since_last_response ?? 0) / 60)} min idle; the prompt cache expired${usd}. Persist state, then /compact or /clear before continuing to keep costs down.`,
        }
      }
    }

    st.updatedAt = now
    state.sessions[input.session_id] = st
    saveState(file, state, now, input.session_id)
    return result
  })
}

async function main() {
  const event = process.argv[2]
  if (event === "--version" || event === "version") return console.log(VERSION)
  let raw = ""
  for await (const chunk of process.stdin) raw += chunk
  const input = raw.trim() ? JSON.parse(raw) : {}
  const result = handle(event, input)
  if (result) out(result)
}

// A path with a space is percent-encoded in import.meta.url, and Node resolves the main
// module's real path, so compare against realpathSync(process.argv[1]) as a URL.
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()

if (isMain) {
  main().catch((e) => {
    // non-blocking but loud (exit 2 would block every tool call)
    process.stderr.write("apcc: " + (e?.stack || e) + "\n")
    process.exit(1)
  })
}

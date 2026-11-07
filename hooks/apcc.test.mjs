import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  learnedReserve, warn, envList, isDestructive, isMarkerTool, VERSION,
  parseTokenCount, resolveThreshold, resolveWindow, lastMainContextTokens, parseMarker, decideNudge, freshSession,
  newEpoch, persistStatus, nudgeText, recoveryText, tailLines, handle, stateFile, userMessages, recentUserWords, userWordsMarkdown, userWordsFile, DEFAULT_THRESHOLD_TOKENS, REARM_TOKENS, REARM_MS,
} from "./apcc.mjs"

const asst = (usage, extra = {}) => JSON.stringify({ type: "assistant", message: { usage }, ...extra })

test("parseTokenCount handles k/M suffixes and junk", () => {
  assert.equal(parseTokenCount("200k"), 200_000)
  assert.equal(parseTokenCount("1M"), 1_000_000)
  assert.equal(parseTokenCount(150000), 150_000)
  assert.equal(parseTokenCount("0"), 0)
  assert.equal(parseTokenCount("abc"), 0)
  assert.equal(parseTokenCount(undefined), 0)
})

test("threshold: env override, compaction point (window - 33k reserve) minus 25k headroom, default", () => {
  assert.equal(resolveThreshold({ APCC_PERSIST_THRESHOLD_TOKENS: "90000" }, {}), 90_000)
  assert.equal(resolveThreshold({}, { autoCompactWindow: 170000 }), 122_000)
  assert.equal(resolveThreshold({}, { autoCompactWindow: 100000 }), 52_000)
  assert.equal(resolveThreshold({}, { autoCompactWindow: 200000 }), 152_000)
  assert.equal(resolveThreshold({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }, { autoCompactWindow: 200000 }), 252_000)
  assert.equal(resolveThreshold({}, { autoCompactWindow: 160000 }, 40_000), 105_000) // learned reserve wins when larger
  assert.equal(resolveThreshold({}, { autoCompactWindow: 160000 }, 10_000), 112_000) // never below the default reserve
  assert.equal(resolveThreshold({}, {}), DEFAULT_THRESHOLD_TOKENS)
})

test("context meter sums input+cache+output of the LAST main-chain assistant turn", () => {
  const t = [
    asst({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 5 }),
    asst({ input_tokens: 9, cache_read_input_tokens: 99999, cache_creation_input_tokens: 1, output_tokens: 1 }, { isSidechain: true }),
    asst({ input_tokens: 20, cache_read_input_tokens: 2000, cache_creation_input_tokens: 300, output_tokens: 80 }),
    JSON.stringify({ type: "user", message: {} }),
  ].join("\n")
  assert.equal(lastMainContextTokens(t), 20 + 2000 + 300 + 80)
})

test("context meter tolerates a torn first line and empty input", () => {
  assert.equal(lastMainContextTokens('{"type":"assi\n' + asst({ input_tokens: 5, output_tokens: 5 })), 10)
  assert.equal(lastMainContextTokens(""), 0)
})

test("marker is end-anchored and ignores quoted grammar", () => {
  assert.deepEqual(parseMarker("done\n\nPERSISTED: 3 units (a, b, c)"), { kind: "persisted", manual: false, units: 3 })
  assert.deepEqual(parseMarker("ok\nPERSISTED (manual): 1 unit (x)\n"), { kind: "persisted", manual: true, units: 1 })
  assert.equal(parseMarker("PERSISTED: none").kind, "acknowledged")
  assert.equal(parseMarker("PERSISTED: 2 units (a)\nand then more text").kind, "none") // not the last line
  assert.equal(parseMarker("see:\n```\nPERSISTED: 2 units (a)").kind, "none") // inside an unbalanced fence
  assert.equal(parseMarker("```\nPERSISTED: 2 units (a)\n```").kind, "none") // last line is the fence
  assert.equal(parseMarker("I will write PERSISTED: 2 units later").kind, "none")
  assert.equal(parseMarker("PERSISTED: 0 units").kind, "acknowledged")
  assert.equal(parseMarker(undefined).kind, "none")
})

test("nudge decision: once per epoch, one final reminder, never after persist", () => {
  const th = 100_000
  let st = freshSession(0)
  assert.equal(decideNudge({ tokens: 99_999, threshold: th, st, now: 0 }), null)
  assert.equal(decideNudge({ tokens: 100_000, threshold: th, st, now: 0 }), 1)
  st = { ...st, nudges: 1, lastNudgeAt: 0, lastNudgeTokens: 100_000 }
  assert.equal(decideNudge({ tokens: 100_500, threshold: th, st, now: 1000 }), null) // backoff
  assert.equal(decideNudge({ tokens: 100_000 + REARM_TOKENS, threshold: th, st, now: 1000 }), 2) // grew
  assert.equal(decideNudge({ tokens: 100_500, threshold: th, st, now: REARM_MS }), 2) // waited
  st = { ...st, nudges: 2 }
  assert.equal(decideNudge({ tokens: 500_000, threshold: th, st, now: 10 * REARM_MS }), null) // capped
  st = { ...freshSession(0), persistedEpoch: 0, units: 2 }
  assert.equal(decideNudge({ tokens: 500_000, threshold: th, st, now: 0 }), null) // already persisted
  assert.equal(decideNudge({ tokens: 500_000, threshold: 0, st: freshSession(0), now: 0 }), null) // disabled
})

test("epoch resets persist state; status is honest", () => {
  let st = { ...freshSession(0), persistedEpoch: 0, units: 3, nudges: 2 }
  assert.equal(persistStatus(st), "DONE")
  st = newEpoch(st)
  assert.equal(st.epoch, 1)
  assert.equal(st.nudges, 0)
  assert.equal(persistStatus(st), "NOT DONE")
  assert.match(persistStatus({ ...freshSession(0), persistedEpoch: 0, units: 0 }), /NOT NEEDED/)
})

test("the manual marker instruction is the exact grammar parseMarker accepts", () => {
  const n = nudgeText({ tokens: 140_000, threshold: 135_000, which: 1 })
  assert.match(n, /PERSISTED \(manual\): <n> units/)
  assert.doesNotMatch(n, /PERSISTED \(manual\): \.\.\./)
  assert.deepEqual(parseMarker("done\nPERSISTED (manual): 2 units (a, b)"), { kind: "persisted", manual: true, units: 2 })
  assert.equal(parseMarker("done\nPERSISTED (manual): none").kind, "acknowledged")
})

test("texts stay under the 10k additionalContext cap and carry the contract", () => {
  const n = nudgeText({ tokens: 140_000, threshold: 135_000, which: 1 })
  assert.match(n, /PERSISTED: <n> units/)
  assert.match(n, /bd note/)
  assert.ok(n.length < 3000)
  const huge = "x".repeat(50_000)
  const r = recoveryText({ source: "compact", st: freshSession(0), indexTail: huge, tokensBefore: 150_000 })
  assert.ok(r.length <= 9000)
  assert.match(recoveryText({ source: "compact", st: freshSession(0), indexTail: "", tokensBefore: 0 }), /Persist status before compaction: NOT DONE/)
  assert.match(recoveryText({ source: "compact", st: { ...freshSession(0), persistedEpoch: 0, units: 2 }, indexTail: "", tokensBefore: 0 }), /: DONE/)
  assert.equal(tailLines("a\n\nb\nc\nd", 2), "c\nd")
})

// ---- end to end through handle() with a real temp project, transcript, and state dir ----

function rig({ tokens, tracked = true, bd = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-"))
  const proj = path.join(root, "proj")
  fs.mkdirSync(path.join(proj, tracked ? ".beads" : "src"), { recursive: true })
  // Isolated PATH: bd is visible only when this rig puts a fake one there.
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin, { recursive: true })
  if (bd) fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const transcript = path.join(root, "t.jsonl")
  const setTokens = (n) => fs.writeFileSync(transcript, asst({ input_tokens: n, output_tokens: 0 }) + "\n")
  setTokens(tokens ?? 0)
  const env = { CLAUDE_PROJECT_DIR: proj, APCC_CC_STATE_DIR: path.join(root, "state"), CLAUDE_CONFIG_DIR: path.join(root, "cfg"), APCC_PERSIST_THRESHOLD_TOKENS: "100000", PATH: bin }
  const input = (extra = {}) => ({ session_id: "s1", transcript_path: transcript, cwd: proj, hook_event_name: "UserPromptSubmit", ...extra })
  return { root, proj, env, input, setTokens }
}

// A PERSISTED claim only counts with a persist write behind it; this is the write.
const writeNotes = (r, now = 0) => handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") } }), r.env, now)

// Spends the post-nudge grace (a few tool calls) so the next gate call is judged by the armed gate.
const pastGrace = (r) => { for (let i = 0; i < GATE_GRACE_CALLS; i++) handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }), r.env, 0) }

test("e2e: below threshold is silent; crossing nudges once; persisted marker silences", () => {
  const r = rig({ tokens: 50_000 })
  assert.equal(handle("nudge", r.input(), r.env, 1000), null)
  r.setTokens(120_000)
  const first = handle("nudge", r.input(), r.env, 2000)
  assert.match(first.hookSpecificOutput.additionalContext, /Persist now/)
  assert.equal(first.hookSpecificOutput.hookEventName, "UserPromptSubmit")
  assert.equal(handle("nudge", r.input({ hook_event_name: "PostToolUse" }), r.env, 3000), null) // backoff
  writeNotes(r, 3500)
  const stop = handle("stop", r.input({ last_assistant_message: "saved.\nPERSISTED: 2 units (a, b)" }), r.env, 4000)
  assert.match(stop.systemMessage, /2 unit\(s\) persisted/)
  r.setTokens(125_000)
  assert.equal(handle("nudge", r.input(), r.env, 9_999_999), null) // persisted just now
  r.setTokens(300_000)
  assert.match(handle("nudge", r.input(), r.env, 9_999_999).hookSpecificOutput.additionalContext, /Persist now/) // that persist is stale
})

test("e2e: ignored nudge gets exactly one final reminder", () => {
  const r = rig({ tokens: 120_000 })
  assert.ok(handle("nudge", r.input(), r.env, 0))
  r.setTokens(140_000)
  const second = handle("nudge", r.input(), r.env, 1000)
  assert.match(second.hookSpecificOutput.additionalContext, /Final reminder/)
  r.setTokens(400_000)
  assert.equal(handle("nudge", r.input(), r.env, 99_999_999), null)
})

test("e2e: subagent calls, untracked projects, kill switch and missing session are inert", () => {
  const r = rig({ tokens: 500_000 })
  assert.equal(handle("nudge", r.input({ agent_id: "sub-1" }), r.env, 0), null)
  assert.equal(handle("nudge", r.input(), { ...r.env, APCC_CC: "0" }, 0), null)
  assert.equal(handle("nudge", { ...r.input(), session_id: undefined }, r.env, 0), null)
  const u = rig({ tokens: 500_000, tracked: false })
  assert.equal(handle("nudge", u.input(), { ...u.env, APCC_CC_UNTRACKED: "0" }, 0), null) // opt-out restores silence
  assert.equal(handle("restore", u.input({ source: "startup" }), { ...u.env, APCC_CC_UNTRACKED: "0" }, 0), null)
  assert.equal(handle("gate", u.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), u.env, 0), null) // never gated
})

test("e2e: untracked project gets one startup hint and one late nudge per context, and writes nothing into the project", () => {
  const u = rig({ tokens: 20_000, tracked: false })
  assert.match(handle("restore", u.input({ source: "startup" }), u.env, 0).systemMessage, /mkdir -p \.opencode\/context/)
  assert.equal(handle("restore", u.input({ source: "resume" }), u.env, 0), null)
  assert.equal(handle("nudge", u.input(), u.env, 1), null) // below threshold
  u.setTokens(130_000)
  const n = handle("nudge", u.input(), u.env, 2)
  assert.match(n.hookSpecificOutput.additionalContext, /nowhere to persist/)
  assert.match(n.hookSpecificOutput.additionalContext, /mkdir -p \.opencode\/context/)
  assert.equal(handle("nudge", u.input(), u.env, 3), null) // once per context
  u.setTokens(20_000)
  handle("nudge", u.input(), u.env, 4) // meter drop = new epoch
  u.setTokens(130_000)
  assert.ok(handle("nudge", u.input(), u.env, 5)) // nudged again after compaction
  assert.equal(fs.existsSync(path.join(u.proj, ".opencode")), false)
  assert.equal(handle("nudge", u.input({ agent_id: "sub" }), u.env, 6), null)
})

test("e2e: compact restore reports the honest status and re-arms the next epoch", () => {
  const r = rig({ tokens: 120_000 })
  fs.mkdirSync(path.join(r.proj, ".opencode", "context"), { recursive: true })
  fs.writeFileSync(path.join(r.proj, ".opencode", "context", "index.md"), "| 2026-10-01 | slug-a | bd note x | did a thing |\n")
  handle("nudge", r.input(), r.env, 0) // nudged, NOT persisted
  assert.equal(handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "auto", context_tokens_before: 130_000 }), r.env, 1000), null)
  const rec = handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 2000)
  const ctx = rec.hookSpecificOutput.additionalContext
  assert.match(ctx, /Persist status before compaction: NOT DONE/)
  assert.match(ctx, /slug-a/)
  assert.match(ctx, /~130k tokens/)
  // new epoch: crossing the threshold again nudges again
  r.setTokens(130_000)
  assert.ok(handle("nudge", r.input(), r.env, 3000))
})

test("e2e: compaction that SessionStart never announced is detected by the meter drop", () => {
  const r = rig({ tokens: 130_000 })
  assert.ok(handle("nudge", r.input(), r.env, 0))
  handle("stop", r.input({ last_assistant_message: "PERSISTED: 1 unit (a)" }), r.env, 10)
  r.setTokens(20_000)
  handle("nudge", r.input(), r.env, 20) // meter fell off a cliff -> new epoch
  r.setTokens(130_000)
  assert.ok(handle("nudge", r.input(), r.env, 30))
})

test("e2e: resume of a big stale session warns the user, small ones stay quiet", () => {
  const r = rig({ tokens: 0 })
  const big = handle("restore", r.input({ hook_event_name: "SessionStart", source: "resume", prompt_cache_likely_expired: true, context_tokens: 182_000, seconds_since_last_response: 5400, estimated_cache_write_usd: 1.14 }), r.env, 0)
  assert.match(big.systemMessage, /cache expired/)
  assert.match(big.systemMessage, /\$1\.14/)
  assert.equal(handle("restore", r.input({ source: "resume", prompt_cache_likely_expired: true, context_tokens: 10_000 }), r.env, 0), null)
  // Startup is not silent any more: with no window configured it carries the one-time hint.
  assert.match(handle("restore", r.input({ source: "startup" }), r.env, 0).systemMessage, /autoCompactWindow not found/)
})

// ---- step 4: beads needs `bd` on PATH, not only a `.beads/` directory ----

test("e2e: .beads/ without bd on PATH routes every message to .opencode/context, never to bd", () => {
  const r = rig({ tokens: 120_000, bd: false })
  const ctx = handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext
  assert.match(ctx, /`\.beads\/` found but `bd` is not on PATH, using \.opencode\/context instead/)
  assert.match(ctx, /\.opencode\/context\/session-notes\.md/)
  assert.doesNotMatch(ctx, /\bbd note\b/)
  assert.doesNotMatch(ctx, /\bbd create\b/)
  // The gate's deny reason drops the `bd note /` alternative too.
  r.setTokens(125_000)
  pastGrace(r)
  const gate = handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } }), r.env, 1000)
  assert.equal(gate.hookSpecificOutput.permissionDecision, "deny")
  assert.doesNotMatch(gate.hookSpecificOutput.permissionDecisionReason, /\bbd note\b/)
  // Recovery uses the saved-context route, not `bd show`.
  const rec = handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 2000)
  const recCtx = rec.hookSpecificOutput.additionalContext
  assert.match(recCtx, /`\.beads\/` found but `bd` is not on PATH/)
  assert.doesNotMatch(recCtx, /\bbd show\b/)
})

test("e2e: with bd on PATH the beads routing is unchanged", () => {
  const r = rig({ tokens: 120_000 })
  const ctx = handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext
  assert.match(ctx, /\bbd note\b/)
  assert.doesNotMatch(ctx, /not on PATH/)
  r.setTokens(125_000)
  pastGrace(r)
  const gate = handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } }), r.env, 1000)
  assert.match(gate.hookSpecificOutput.permissionDecisionReason, /\bbd note \//)
})

test("e2e: a non-executable bd file on PATH does not count", () => {
  const r = rig({ tokens: 120_000, bd: false })
  fs.writeFileSync(path.join(r.env.PATH, "bd"), "not a program\n", { mode: 0o644 })
  assert.match(handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext, /not on PATH/)
})

test("e2e: startup warns once when .beads/ exists but bd is not on PATH", () => {
  const r = rig({ tokens: 0, bd: false })
  const first = handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 0)
  assert.match(first.systemMessage, /`\.beads\/` found but `bd` is not on PATH, using \.opencode\/context instead/)
  assert.equal(handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 1000), null)
  // A configured window keeps the unrelated startup hint out of this check.
  const withBd = rig({ tokens: 0 })
  assert.equal(handle("restore", withBd.input({ hook_event_name: "SessionStart", source: "startup" }), { ...withBd.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" }, 0), null)
})

test("e2e: bd-on-PATH detection is cached in the session state", () => {
  const no = rig({ tokens: 0, bd: false })
  handle("restore", no.input({ source: "startup" }), no.env, 0)
  assert.equal(JSON.parse(fs.readFileSync(stateFile(no.proj, no.env), "utf8")).sessions.s1.bdOnPath, false)
  const yes = rig({ tokens: 0 })
  handle("restore", yes.input({ source: "startup" }), yes.env, 0)
  assert.equal(JSON.parse(fs.readFileSync(stateFile(yes.proj, yes.env), "utf8")).sessions.s1.bdOnPath, true)
})

test("e2e: precompact never blocks (no decision, no output)", () => {
  const r = rig({ tokens: 0 })
  assert.equal(handle("precompact", r.input({ trigger: "manual" }), r.env, 0), null)
})

test("e2e: warns once when context is past the configured window with no compaction", () => {
  const r = rig({ tokens: 200_000 })
  fs.mkdirSync(r.env.CLAUDE_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(path.join(r.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ autoCompactWindow: 170000 }))
  const env = { ...r.env, APCC_PERSIST_THRESHOLD_TOKENS: "135000" }
  const first = handle("nudge", r.input(), env, 0)
  assert.match(first.systemMessage, /past your auto-compact window \(170k\)/)
  assert.doesNotMatch(first.systemMessage, /\/autocompact/, "the /autocompact command was never verified to exist")
  assert.match(first.systemMessage, /restart/i)
  assert.match(first.hookSpecificOutput.additionalContext, /Persist now/) // nudge still delivered alongside
  r.setTokens(210_000)
  const second = handle("nudge", r.input(), env, 20 * 60 * 1000)
  assert.equal(second.systemMessage, undefined) // warned once per epoch
  const inside = rig({ tokens: 160_000 })
  fs.mkdirSync(inside.env.CLAUDE_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(path.join(inside.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ autoCompactWindow: 170000 }))
  assert.equal(handle("nudge", inside.input(), { ...inside.env, APCC_PERSIST_THRESHOLD_TOKENS: "135000" }, 0).systemMessage, undefined)
})

test("e2e: stop message says nothing was compacted", () => {
  const r = rig({ tokens: 150_000 })
  writeNotes(r)
  const msg = handle("stop", r.input({ last_assistant_message: "x\nPERSISTED: 2 units (a, b)" }), r.env, 0).systemMessage
  assert.match(msg, /NOT compacted/)
})

test("delta persist: once, only after a persist, right at the window", () => {
  const st = { ...freshSession(0), persistedEpoch: 0, units: 2 }
  const base = { threshold: 102_000, compactAt: 127_000, st, now: 0 }
  assert.equal(decideNudge({ ...base, tokens: 110_000 }), null)
  assert.equal(decideNudge({ ...base, tokens: 120_000 }), 3)
  assert.equal(decideNudge({ ...base, tokens: 120_000, st: { ...st, deltaEpoch: 0 } }), null)
  assert.equal(decideNudge({ ...base, tokens: 120_000, compactAt: 0 }), null)
})

test("meter: no reading between a compact boundary and the next assistant turn", () => {
  const u = { input_tokens: 1, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 0, output_tokens: 1 }
  const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary" })
  const user = JSON.stringify({ type: "user", message: { role: "user", content: "summary" } })
  assert.equal(lastMainContextTokens([asst(u), boundary, user].join("\n")), 0)
  assert.equal(lastMainContextTokens([asst(u), boundary, user, asst({ ...u, cache_read_input_tokens: 20_000 })].join("\n")), 20_002)
})

const boundary = (ts, trigger, preTokens) => JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: ts, compactMetadata: { trigger, preTokens } })

test("the host reserve is learned per window as a median, from transcript compact_boundary records only", () => {
  const r = rig({ tokens: 10_000 })
  const env = { ...r.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "160000" }
  delete env.APCC_PERSIST_THRESHOLD_TOKENS
  const samples = () => JSON.parse(fs.readFileSync(stateFile(r.proj, env), "utf8")).compactions
  const lines = [boundary("t1", "manual", 90_000), boundary("t2", "auto", 127_000), boundary("t3", "auto", 127_500), boundary("t4", "auto", 40_000)]
  fs.appendFileSync(r.input().transcript_path, lines.join("\n") + "\n")
  handle("precompact", r.input({ trigger: "auto" }), env, 1)
  handle("restore", r.input({ source: "compact" }), env, 2)
  assert.equal(samples(), undefined) // nothing is learned until the next nudge reads the transcript
  handle("nudge", r.input(), env, 3)
  assert.equal(samples().length, 3) // the manual boundary is not a trigger measurement
  assert.equal(learnedReserve(samples(), 160_000), 33_000) // median: one odd reading cannot move it
  assert.equal(learnedReserve(samples(), 180_000), 0) // another window: nothing learned yet
  handle("precompact", r.input({ trigger: "auto" }), env, 4)
  handle("restore", r.input({ source: "compact" }), env, 5)
  handle("nudge", r.input(), env, 6)
  assert.equal(samples().length, 3) // the same boundaries are never counted twice
})

test("a PreCompact/SessionStart pair with no compact_boundary in the transcript teaches nothing", () => {
  const r = rig({ tokens: 119_000 })
  const env = { ...r.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" }
  const f = stateFile(r.proj, env)
  handle("precompact", r.input({ trigger: "auto" }), env, 0) // seen live: fires when background subagents finish
  handle("restore", r.input({ source: "compact" }), env, 1)
  handle("nudge", r.input(), env, 2)
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).compactions, undefined)
  handle("precompact", r.input({ trigger: "auto", agent_id: "sub-1" }), env, 3) // subagent
  handle("restore", r.input({ source: "clear" }), env, 4)
  handle("nudge", r.input(), env, 5)
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).compactions, undefined)
})

test("a legacy learnedReserve scalar in the state file is discarded, not trusted", () => {
  const r = rig()
  const env = { ...r.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" }
  const f = stateFile(r.proj, env)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ sessions: {}, learnedReserve: 80_434 }))
  handle("precompact", r.input({ trigger: "manual", context_tokens_before: 90_000 }), env, 0)
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).learnedReserve, undefined)
})

test("stop: a later PERSISTED: none keeps the unit count of an earlier real persist in the same epoch", () => {
  const r = rig()
  writeNotes(r)
  handle("stop", r.input({ last_assistant_message: "done\nPERSISTED: 3 units (a, b, c)" }), r.env, 0)
  handle("stop", r.input({ last_assistant_message: "later\nPERSISTED: none" }), r.env, 1)
  const st = JSON.parse(fs.readFileSync(stateFile(r.proj, r.env), "utf8")).sessions[r.input({}).session_id]
  assert.equal(st.units, 3)
})

const u = (content, extra = {}) => JSON.stringify({ type: "user", timestamp: "t", message: { role: "user", content }, ...extra })

test("user words: keeps typed and queued messages, drops tool output, notifications, meta and duplicates", () => {
  const lines = [
    u("first instruction"),
    u([{ type: "tool_result", content: "noise" }]),
    u("<task-notification>done</task-notification>"),
    u("<local-command-stdout>Compacted</local-command-stdout>"),
    u("meta", { isMeta: true }),
    u("summary", { isCompactSummary: true }),
    u("side", { isSidechain: true }),
    u("<command-name>/compact</command-name><command-message>compact</command-message><command-args>keep the budget in mind</command-args>"),
    JSON.stringify({ type: "attachment", timestamp: "t", attachment: { type: "queued_command", prompt: "typed while busy" } }),
    u([{ type: "text", text: "first instruction" }]),
    u("real <system-reminder>injected</system-reminder> words"),
    "{torn",
  ].join("\n")
  assert.deepEqual(userMessages(lines).map((m) => m.text), ["first instruction", "/compact keep the budget in mind", "typed while busy", "real  words"])
})

test("user words: newest fit the inline budget, oldest first; one oversized message is truncated", () => {
  const md = userWordsMarkdown([1, 2, 3, 4].map((i) => ({ ts: `t${i}`, text: "x".repeat(100) + i })))
  const r = recentUserWords(md, 250)
  assert.equal(r.total, 4)
  assert.equal(r.shown, 2)
  assert.match(r.text, /## t3[\s\S]*## t4/)
  assert.match(recentUserWords(userWordsMarkdown([{ ts: "t", text: "y".repeat(500) }]), 100).text, /truncated/)
})

test("state and user-words files are private, and old user-words files are pruned", () => {
  const r = rig({ tokens: 120_000 })
  fs.writeFileSync(r.input().transcript_path, [u("a pasted key: sk-test"), asst({ input_tokens: 120_000, output_tokens: 0 })].join("\n") + "\n")
  handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "manual" }), r.env, 1000)
  const wf = userWordsFile(r.proj, "s1", r.env)
  const dir = path.dirname(wf)
  assert.equal(fs.statSync(wf).mode & 0o777, 0o600, "user-words file is readable only by its owner")
  assert.equal(fs.statSync(stateFile(r.proj, r.env)).mode & 0o777, 0o600, "state file is readable only by its owner")
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "state dir is private")
  // The same sweep that expires sessions deletes user-words files older than 30 days.
  const old = path.join(dir, "user-words-deadbeef-old.md")
  const fresh = path.join(dir, "user-words-deadbeef-fresh.md")
  fs.writeFileSync(old, "old words")
  fs.writeFileSync(fresh, "fresh words")
  const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  fs.utimesSync(old, past, past)
  handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "done" }), r.env, Date.now())
  assert.equal(fs.existsSync(old), false, "a user-words file older than the retention window is deleted")
  assert.equal(fs.existsSync(fresh), true, "a recent user-words file is kept")
})

test("prune keeps the current session's words file and skips directories without warning", () => {
  const r = rig({ tokens: 120_000 })
  fs.writeFileSync(r.input().transcript_path, [u("live words"), asst({ input_tokens: 120_000, output_tokens: 0 })].join("\n") + "\n")
  handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "manual" }), r.env, 1000)
  const wf = userWordsFile(r.proj, "s1", r.env)
  const dir = path.dirname(wf)
  const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  fs.utimesSync(wf, past, past) // a long-lived session that has not compacted in a month
  const asDir = path.join(dir, "user-words-deadbeef-dir.md")
  fs.mkdirSync(asDir)
  fs.utimesSync(asDir, past, past)
  let err = ""
  const orig = process.stderr.write
  process.stderr.write = (c) => {
    err += c
    return true
  }
  try {
    handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "done" }), r.env, Date.now())
  } finally {
    process.stderr.write = orig
  }
  assert.equal(fs.existsSync(wf), true, "the live session's words file is not deleted")
  assert.equal(fs.existsSync(asDir), true, "a directory with the words-file name is never deleted")
  assert.doesNotMatch(err, /prune user-words/, "no warning on every save")
})

test("state dir: the leaf is 0700, but missing parent directories keep the default mode", () => {
  const r = rig({ tokens: 120_000 })
  const nested = path.join(r.root, "fresh", "a", "b", "state")
  const env = { ...r.env, APCC_CC_STATE_DIR: nested }
  handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "done" }), env, Date.now())
  const modeOf = (p) => fs.statSync(p).mode & 0o777
  assert.equal(modeOf(nested), 0o700, "the state dir itself is private")
  const defaultMode = 0o777 & ~process.umask()
  // Ancestors apcc had to create are not apcc's to close to the group: before this change
  // ~/.local and ~/.local/state came out owner-only on a fresh HOME.
  for (const p of [path.join(r.root, "fresh"), path.join(r.root, "fresh", "a"), path.join(r.root, "fresh", "a", "b")])
    assert.equal(modeOf(p), defaultMode, p)
})

test("e2e: precompact saves the user's words; restore makes reading them contract item 1", () => {
  const r = rig({ tokens: 120_000 })
  fs.writeFileSync(r.input().transcript_path, [u("make the UI great"), u("budget is tight"), asst({ input_tokens: 120_000, output_tokens: 0 })].join("\n") + "\n")
  handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "manual" }), r.env, 1000)
  const wf = userWordsFile(r.proj, "s1", r.env)
  assert.match(fs.readFileSync(wf, "utf8"), /make the UI great[\s\S]*budget is tight/)
  const ctx = handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 2000).hookSpecificOutput.additionalContext
  assert.match(ctx, /1\. The summary paraphrases[\s\S]*Read .*user-words.*all 2 of the user's messages/)
  assert.match(ctx, /budget is tight/)
  assert.doesNotMatch(ctx, /Continue from the next unfinished atomic step/)
  assert.ok(ctx.length <= 9_000)
  // /clear starts a new session id: a single recently active words file is offered as context only
  const clr = handle("restore", r.input({ session_id: "s2", hook_event_name: "SessionStart", source: "clear" }), r.env, 3000).hookSpecificOutput.additionalContext
  assert.ok(clr.includes(wf))
  assert.match(clr, /context only/)
  assert.doesNotMatch(clr, /open work/)
  assert.doesNotMatch(clr, /budget is tight/, "another session's words are never printed inline after /clear")
  // two recently active sessions: ambiguous, so none is named
  fs.writeFileSync(path.join(path.dirname(wf), path.basename(wf).replace(/-[^-]+\.md$/, "-other.md")), "# other session\n\n## t\nDelete the staging database\n")
  const amb = handle("restore", r.input({ session_id: "s3", hook_event_name: "SessionStart", source: "clear" }), r.env, 3000)
  assert.ok(!JSON.stringify(amb).includes("staging database"))
  assert.ok(!JSON.stringify(amb).includes(path.basename(wf)))
  // an old file is not offered either
  for (const f of fs.readdirSync(path.dirname(wf)).filter((f) => f.includes("user-words")))
    fs.utimesSync(path.join(path.dirname(wf), f), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))
  const old = handle("restore", r.input({ session_id: "s4", hook_event_name: "SessionStart", source: "clear" }), r.env, 3000)
  assert.ok(!JSON.stringify(old ?? {}).includes("staging database"))
})

import { decideGate, MAX_GATE_DENIALS, GATE_GRACE_CALLS, HARD_ZONE_TOKENS } from "./apcc.mjs"

test("gate: allows until the final reminder was ignored, then only persist/read calls", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000, proj: "/r" }
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "pnpm build" } }).allow, false)
  assert.equal(decideGate({ ...base, tool: "Edit", toolInput: { file_path: "/x/src/a.ts" } }).allow, false)
  assert.equal(decideGate({ ...base, tool: "Read", toolInput: {} }).allow, true)
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd note abc 'x'" } }).allow, true)
  assert.equal(decideGate({ ...base, tool: "Write", toolInput: { file_path: "/r/.opencode/context/session-notes.md" } }).allow, true)
  const done = decideGate({ ...base, tool: "Bash", toolInput: { command: "echo '| a |' >> .opencode/context/index.md" } })
  assert.equal(done.completes, true)
  assert.equal(decideGate({ ...base, st: { ...st, nudges: 0 }, tool: "Bash", toolInput: { command: "ls" } }).allow, true)
  assert.equal(decideGate({ ...base, tokens: 50_000, tool: "Bash", toolInput: { command: "ls" } }).allow, true)
  assert.equal(decideGate({ ...base, st: { ...st, persistedEpoch: st.epoch }, tool: "Bash", toolInput: { command: "ls" } }).allow, true)
  assert.equal(decideGate({ ...base, st: { ...st, gateDenials: MAX_GATE_DENIALS }, tool: "Bash", toolInput: { command: "ls" } }).allow, true)
})

test("an early persist goes stale: it does not suppress the threshold nudge or read as DONE", () => {
  const st = { ...freshSession(0), persistedEpoch: 0, persistedTokens: 70_000, units: 0 }
  assert.match(persistStatus(st, 75_000), /^NOT NEEDED \(the model declined to persist/)
  assert.match(persistStatus(st, 125_000), /^NOT DONE \(last persist was at ~70k/)
  assert.equal(decideNudge({ tokens: 105_000, threshold: 100_000, st, now: 1, compactAt: 127_000 }), 1)
  assert.equal(decideNudge({ tokens: 105_000, threshold: 100_000, st: { ...st, persistedTokens: 100_000 }, now: 1, compactAt: 127_000 }), null)
})

test("gate engages after the FIRST nudge plus a short grace, not only after the second", () => {
  // The second nudge fires REARM_TOKENS (15k) after the first: that is the compaction point,
  // so a gate that waited for it could never engage before compaction.
  const st = { ...freshSession(0), nudges: 1 }
  const ls = { tool: "Bash", toolInput: { command: "npm run build" } }
  const threshold = 132_000
  const at = (calls, tokens = threshold + 9_000) => decideGate({ st: { ...st, nudgeCalls: calls }, tokens, threshold, ...ls }).allow
  assert.equal(at(1), true) // grace: finish the atomic step, however far one Read moved the meter
  assert.equal(at(GATE_GRACE_CALLS), true)
  assert.equal(at(GATE_GRACE_CALLS + 1), false)
  assert.equal(decideGate({ st: { ...st, nudges: 0, nudgeCalls: 9 }, tokens: threshold + 9_000, threshold, ...ls }).allow, true) // never told yet
})

test("gate: in the last stretch before compaction the denial cap no longer releases it", () => {
  const st = { ...freshSession(0), nudges: 2, gateDenials: MAX_GATE_DENIALS }
  const ls = { tool: "Bash", toolInput: { command: "npm run build" } }
  const threshold = 132_000
  const compactAt = 147_000
  const proj = "/r"
  assert.equal(decideGate({ st, tokens: 134_000, threshold, compactAt, proj, ...ls }).allow, true) // cap still protects against a deadlock early on
  assert.equal(decideGate({ st, tokens: compactAt - HARD_ZONE_TOKENS, threshold, compactAt, proj, ...ls }).allow, false)
  // persist writes stay allowed, so the hard zone cannot deadlock the session
  assert.equal(decideGate({ st, tokens: 145_000, threshold, compactAt, proj, tool: "Write", toolInput: { file_path: "/r/.opencode/context/session-notes.md" } }).allow, true)
  assert.equal(decideGate({ st, tokens: 145_000, threshold, compactAt, proj, tool: "Read", toolInput: {} }).allow, true)
})

test("gate: creating the persist dir without a trailing slash and editing .gitignore are allowed in the hard zone", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: "/r" }
  const ok = (tool, toolInput) => decideGate({ ...base, tool, toolInput }).allow
  assert.equal(ok("Bash", { command: "mkdir -p .opencode/context" }), true, "the README's prepare command")
  assert.equal(ok("Bash", { command: "mkdir -p .opencode/context/" }), true)
  assert.equal(ok("Write", { file_path: "/r/.gitignore" }), true)
  assert.equal(ok("Edit", { file_path: "/r/.gitignore" }), true)
  assert.equal(ok("Bash", { command: "echo '.opencode/' >> .gitignore" }), true)
  // Still not a licence to delete the persist dir or to work anywhere else.
  assert.equal(ok("Bash", { command: "rm -rf .opencode/context" }), false)
  assert.equal(ok("Write", { file_path: "/r/src/a.ts" }), false)
})

test("gate: the persist-dir setup allowance takes no -m mode, so the dir cannot be made 777 or 0000", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: "/r" }
  const ok = (command) => decideGate({ ...base, tool: "Bash", toolInput: { command } }).allow
  assert.equal(ok("mkdir -p .opencode/context"), true)
  assert.equal(ok("mkdir --parents .opencode/context/"), true)
  for (const c of [
    "mkdir -p -m 777 .opencode/context",
    "mkdir -p -m 0000 .opencode/context",
    "mkdir -p -m 700 .opencode/context",
    "mkdir -p -m 777 .opencode/context/",
    "mkdir --mode=777 .opencode/context/",
  ])
    assert.equal(ok(c), false, c)
})

test("gate: .gitignore and persist paths must resolve inside this project, and must not escape their persist dir with ..", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: "/work/proj" }
  const ok = (tool, toolInput) => decideGate({ ...base, tool, toolInput }).allow
  // Inside the project: the relative form the nudge asks for, or an absolute path under it.
  assert.equal(ok("Write", { file_path: ".gitignore" }), true)
  assert.equal(ok("Edit", { file_path: "/work/proj/.gitignore" }), true)
  assert.equal(ok("Write", { file_path: "/work/proj/sub/.gitignore" }), true)
  // Another repo's or another tool's ignore rules are not this project's setup.
  assert.equal(ok("Write", { file_path: "/tmp/other-repo/.gitignore" }), false)
  assert.equal(ok("Edit", { file_path: "/home/someone/.claude/.gitignore" }), false)
  assert.equal(ok("Write", { file_path: "../proj2/.gitignore" }), false)
  // Persist writes stay inside the project and inside their own persist dir.
  assert.equal(ok("Write", { file_path: ".opencode/context/session-notes.md" }), true)
  assert.equal(ok("Write", { file_path: "/work/proj/.opencode/context/session-notes.md" }), true)
  assert.equal(ok("Write", { file_path: "/other/.opencode/context/x.md" }), false)
  assert.equal(ok("Write", { file_path: "docs/research/a.md" }), true)
  // `..` that leaves the persist dir (the project's own root is not the persist dir either).
  assert.equal(ok("Bash", { command: "mkdir -p .opencode/context/../../etc/x" }), false)
  assert.equal(ok("Write", { file_path: ".opencode/context/../../etc/x" }), false)
  assert.equal(ok("Bash", { command: "cat > docs/research/../../etc/x <<'EOF'\nx\nEOF" }), false)
  assert.equal(ok("Bash", { command: "bd note p-1 --stdin <<'EOF'\nsee ../docs\nEOF" }), true)
})

test("gate: the .gitignore setup allowance is exactly one echo/printf append, nothing before or after it", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: "/r" }
  const ok = (command) => decideGate({ ...base, tool: "Bash", toolInput: { command } }).allow
  // The one shape the nudge asks for.
  assert.equal(ok("echo '.opencode/' >> .gitignore"), true)
  assert.equal(ok("echo .opencode/ >>.gitignore"), true)
  assert.equal(ok("printf '%s\\n' .opencode/ >> .gitignore"), true)
  // A destructive or outward-facing prefix must not ride along, and no second command/redirect.
  for (const c of [
    "cp /dev/null ~/.bashrc && echo '.opencode/' >> .gitignore",
    "sed -i '1,$d' ~/.ssh/config && echo '.opencode/' >> .gitignore",
    "echo x > /etc/passwd >> .gitignore",
    "git push --force && echo '.opencode/' >> .gitignore",
    "bash -c 'cp /dev/null ~/.bashrc; echo x >> .gitignore'",
    "echo x >> .gitignore >> .gitignore",
    "echo x > .gitignore", // truncation wipes the user's existing rules
    "echo $(id) >> .gitignore",
    "echo `id` >> .gitignore",
    "echo x >> .gitignore; rm -rf /",
    "echo x >> .gitignore\nrm -rf /",
    "cd /tmp && echo x >> .gitignore",
  ])
    assert.equal(ok(c), false, c)
})

test("gate: tools listed in APCC_GATE_ALLOW_TOOLS stay allowed while the gate blocks", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000 }
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "npm run build" } }).allow, false)
  const env = { APCC_GATE_ALLOW_TOOLS: "mcp__chat__, mcp__other__" }
  assert.equal(decideGate({ ...base, tool: "mcp__chat__post_message", toolInput: { text: "x" } }).allow, false)
  assert.equal(decideGate({ ...base, env, tool: "mcp__chat__post_message", toolInput: { text: "x" } }).allow, true)
  assert.equal(decideGate({ ...base, env, tool: "mcp__github__create_pull_request", toolInput: {} }).allow, false)
})

test("remote-only: the repo copy stays silent outside cloud sessions", () => {
  const r = rig({ tokens: 120_000 })
  const local = { ...r.env, APCC_CC_REMOTE_ONLY: "1" }
  assert.equal(handle("nudge", r.input(), local, 1000), null)
  const cloud = { ...local, CLAUDE_CODE_REMOTE: "true" }
  assert.ok(handle("nudge", r.input(), cloud, 2000).hookSpecificOutput.additionalContext.includes("[apcc]"))
})

test("gate: read-only git status/diff/log stay allowed so the recovery contract's git route works", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000 } // hard zone
  const ok = (command) => decideGate({ ...base, tool: "Bash", toolInput: { command } }).allow
  assert.equal(ok("git status"), true)
  assert.equal(ok("git status --short"), true)
  assert.equal(ok("git diff --stat"), true)
  assert.equal(ok("git log --oneline -5"), true)
  assert.equal(ok("git status; rm -rf /"), false)
  assert.equal(ok("git diff --output=/tmp/x"), false)
  assert.equal(ok("git checkout -- src"), false)
  // These options run a program from git config (diff.external / a textconv filter), so they are
  // not reads. The --no- forms disable them and stay allowed.
  for (const c of ["git diff --ext-diff", "git diff --textconv", "git log --ext-diff", "git log --textconv --stat"]) assert.equal(ok(c), false, c)
  assert.equal(ok("git diff --no-ext-diff"), true)
  assert.equal(ok("git diff --no-textconv"), true)
})

test("gate: read-only bd queries stay allowed so recovery can re-read beads", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000 }
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd show proj-abc1" } }).allow, true)
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd show proj-abc1 2>&1 | head -60" } }).allow, true)
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd list --status in_progress" } }).allow, true)
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd show x; pnpm build" } }).allow, false)
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd show x && rm -rf src" } }).allow, false)
  assert.equal(decideGate({ ...base, tool: "Bash", toolInput: { command: "bd close x" } }).allow, false)
})

test("threshold honours CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (host compacts at (window - 20k) * pct)", () => {
  const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80" }
  // live cloud thread 2026-10-21: last readings before compaction 127,978 and 127,449
  assert.equal(resolveThreshold(env, {}), 113_000)
  assert.ok(resolveThreshold(env, {}) < 127_449)
  assert.equal(resolveThreshold({ ...env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "95" }, {}), 132_000) // usual point is lower
  assert.equal(resolveThreshold({ ...env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "junk" }, {}), 132_000)
})

test("a persist write near the threshold counts before the gate engages", () => {
  const r = rig({ tokens: 95_000 }) // threshold 100k (rig), inside the 12k freshness window
  const env = r.env
  handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bd note abc --stdin" } }), env, 1000)
  r.setTokens(101_000)
  assert.equal(handle("nudge", r.input(), env, 2000), null) // covered: no nudge
  const far = rig({ tokens: 60_000 })
  handle("gate", far.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bd note abc --stdin" } }), far.env, 1000)
  far.setTokens(101_000)
  assert.ok(handle("nudge", far.input(), far.env, 2000).hookSpecificOutput.additionalContext.includes("[apcc]")) // too early to count
})

test("persist writes seen by the gate count as units, so precompact reports DONE without a marker", () => {
  const r = rig({ tokens: 101_000 })
  const gate = (command) => handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }), r.env, 1000)
  gate("bd note abc --stdin")
  gate("echo '| d | s | x | y |' >> .opencode/context/index.md")
  handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "auto" }), r.env, 2000)
  const st = JSON.parse(fs.readFileSync(stateFile(r.proj, r.env), "utf8")).sessions.s1
  assert.equal(st.units, 2)
  assert.equal(st.compactStatus, "DONE")
})

test("gate: bd update --notes (overwrite) is denied at any context size, appends pass", () => {
  const r = rig({ tokens: 1_000 })
  const gate = (command, extra = {}) => handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra }), r.env, 0)
  for (const c of ['bd update proj-1 --notes "x"', "bd update proj-1 --notes=x", "cd a && bd update proj-1 --status open --notes x"])
    assert.equal(gate(c)?.hookSpecificOutput?.permissionDecision, "deny", c)
  assert.equal(gate('bd update proj-1 --notes "x"', { agent_id: "sub-1" })?.hookSpecificOutput?.permissionDecision, "deny")
  for (const c of [
    'bd update proj-1 --append-notes "x"',
    "echo x | bd note proj-1 --stdin",
    'bd create --title t --notes "first"',
    'bd update proj-1 --append-notes "never use bd update --notes here"',
    "bd update proj-1 --append-notes 'the gate blocks --notes'",
    "bd note proj-1 --stdin <<'EOF'\nbd update proj-1 --notes x is forbidden\nEOF",
  ])
    assert.notEqual(gate(c)?.hookSpecificOutput?.permissionDecision, "deny", c)
  assert.equal(gate('bd update proj-1 --title "a b" --notes x')?.hookSpecificOutput?.permissionDecision, "deny")
  // quoted text handed to a shell interpreter is the program, not data (blind review of 0696b8f)
  for (const c of ['bash -c "bd update proj-1 --notes x"', "sh -c 'bd update proj-1 --notes x'", 'eval "bd update proj-1 --notes x"', "bash -s <<'EOF'\nbd update proj-1 --notes x\nEOF", "bash <<'EOF'\nbd update proj-1 --notes x\nEOF", "echo 'bd update proj-1 --notes x' | sh"])
    assert.equal(gate(c)?.hookSpecificOutput?.permissionDecision, "deny", c)
})

test("stop: every main-session stop is counted with its time; subagent stops are not", () => {
  const r = rig({ tokens: 1_000 })
  handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "done" }), r.env, 5)
  handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "done" }), r.env, 9)
  handle("stop", r.input({ hook_event_name: "SubagentStop", agent_id: "sub-1", last_assistant_message: "done" }), r.env, 12)
  const st = JSON.parse(fs.readFileSync(stateFile(r.proj, r.env), "utf8")).sessions.s1
  assert.equal(st.stops, 2)
  assert.equal(st.lastStopAt, 9)
})

test("gate: a PERSISTED marker ending a post_message reply is recorded (the Stop hook never sees it)", () => {
  const r = rig({ tokens: 1_000 })
  writeNotes(r, 4)
  handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "mcp__chat__post_message", tool_input: { text: "Done.\n\nPERSISTED: 2 units (a, b)" } }), r.env, 5)
  handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "" }), r.env, 6)
  const st = JSON.parse(fs.readFileSync(stateFile(r.proj, r.env), "utf8")).sessions.s1
  assert.equal(st.units, 2)
  assert.equal(st.persistedEpoch, st.epoch)
})

// ---- fail loud, never silent ----

test("warn: a missing file stays quiet; any other error is one line on stderr", () => {
  let captured = ""
  const orig = process.stderr.write
  process.stderr.write = (chunk) => {
    captured += chunk
    return true
  }
  try {
    warn("read settings", Object.assign(new Error("no such file, open x"), { code: "ENOENT" }))
    assert.equal(captured, "") // expected absence: a project with no settings/state must stay quiet
    warn("read state", Object.assign(new Error("permission denied, open y"), { code: "EACCES" }))
  } finally {
    process.stderr.write = orig
  }
  assert.equal(captured, "apcc: read state: permission denied, open y\n")
})

test("hook script: invalid JSON on stdin exits 1 and says why on stderr", () => {
  const script = fileURLToPath(new URL("./apcc.mjs", import.meta.url))
  const r = spawnSync(process.execPath, [script], { input: "{not json", encoding: "utf8" })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /^apcc: /)
  assert.ok(r.stderr.trim().length > 0)
})

test("envList splits, trims and drops empties", () => {
  assert.deepEqual(envList(" a, b ,,c "), ["a", "b", "c"])
  assert.deepEqual(envList(undefined), [])
})

test("isMarkerTool: default post_message, matches MCP-prefixed names, configurable", () => {
  assert.equal(isMarkerTool("post_message", {}), true)
  assert.equal(isMarkerTool("mcp__x__post_message", {}), true)
  assert.equal(isMarkerTool("mcp__x__post_message_not", {}), false)
  assert.equal(isMarkerTool("reply", { APCC_MARKER_TOOLS: "reply" }), true)
  assert.equal(isMarkerTool("post_message", { APCC_MARKER_TOOLS: "reply" }), false)
})

test("gate: read-only bd passes, chained or redirected commands do not", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000, tool: "Bash" }
  const ok = (command) => decideGate({ ...base, toolInput: { command } }).allow
  assert.equal(ok("bd show x-1"), true)
  assert.equal(ok("bd list"), true)
  for (const c of ["bd show x-1; rm -rf /", "bd show x-1 && ls", "bd show x-1 > out", "bd show $(whoami)", "bd show `id`", "bd show x\nls"]) assert.equal(ok(c), false, c)
})

test("text: beads-optional nudge and recovery", () => {
  const withB = nudgeText({ tokens: 120_000, threshold: 100_000, which: "first", beads: true })
  const noB = nudgeText({ tokens: 120_000, threshold: 100_000, which: "first", beads: false })
  assert.match(withB, /bd note/)
  assert.doesNotMatch(noB, /\bbd\b/)
  const rec = recoveryText({ source: "compact", st: freshSession(0), indexTail: "", tokensBefore: 1, beads: false })
  assert.doesNotMatch(rec, /\bbd\b/)
  assert.match(recoveryText({ source: "compact", st: freshSession(0), indexTail: "", tokensBefore: 1, beads: true }), /bd show/)
})

test("VERSION is semver", () => assert.match(VERSION, /^\d+\.\d+\.\d+$/))

test("gate: a Bash command that mentions a persist path but also deletes/moves/downloads is NOT a persist write", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000, tool: "Bash" }
  const ok = (command) => decideGate({ ...base, toolInput: { command } }).allow
  for (const c of [
    "rm -rf .opencode/context/",
    "git checkout -- .opencode/context/",
    "mv .opencode/context/ /tmp/x",
    "curl http://x -o .opencode/context/x",
    "bd note p-1 --stdin && rm -rf /tmp/x",
    "tee .opencode/context/index.md </dev/null && echo '.opencode/' >> .gitignore", // truncates the persist index
    "install -m 644 /tmp/x .opencode/context/index.md",
  ])
    assert.equal(ok(c), false, c)
  assert.equal(ok("cat > .opencode/context/session-notes.md <<'EOF'\nwe rm -rf nothing\nEOF"), true)
  assert.equal(ok("bd note p-1 --stdin"), true)
})

test("gate: wrapped destructive programs, git -C, and persist-looking filenames", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000, tool: "Bash" }
  const ok = (command) => decideGate({ ...base, toolInput: { command } }).allow
  for (const c of ['bash -c "rm -rf .opencode/context/"', "sh -c 'rm -rf .opencode/context/'", 'eval "rm -rf .opencode/context/"', "git -C . restore .opencode/context/", `python3 -c "import shutil;shutil.rmtree('.opencode/context/')"`, `perl -e 'unlink ".opencode/context/index.md"'`]) assert.equal(ok(c), false, c)
  for (const c of ["cat > docs/research/curl-api.md <<'EOF'\nx\nEOF", "cat > .opencode/context/rm.md <<'EOF'\nx\nEOF", "bd update p-1 --append-notes 'done'", "echo done >> .opencode/context/form.txt"]) assert.equal(ok(c), true, c)
})

test("meter ignores non-numeric and negative usage values", () => {
  const line = (u) => JSON.stringify({ type: "assistant", message: { usage: u } })
  assert.equal(lastMainContextTokens(line({ input_tokens: "100000", output_tokens: "0" })), 0)
  assert.equal(lastMainContextTokens(line({ input_tokens: 5, output_tokens: -9, cache_read_input_tokens: null })), 5)
})

test("isDestructive: prose and Windows paths are persist writes; obfuscated verbs are not", () => {
  for (const ok of [
    "bd create Decision: rm is banned -t decision",
    "echo rm the old temp | bd note proj-1 --stdin",
    "bd note proj-1 --stdin <<'END-NOTES'\ndon't rm this\nEND-NOTES",
    "cat > .opencode\\context\\session-notes.md <<'EOF'\nrm and curl\nEOF",
  ]) assert.equal(isDestructive(ok), false, ok)
  for (const bad of [
    "r''m -rf .opencode/context/", "m\\v .opencode/context/x /tmp", "cu''rl http://x -o .opencode/context/x",
    'bd create "$(rm -rf /tmp/p)"', "sh .opencode/context/../../bin/rm -rf /tmp/p", "> .opencode/context/index.md",
    "chmod 000 .opencode/context/index.md", "Remove-Item -Force .opencode/context/index.md", "bd note p-1 --stdin && rm -rf /tmp/x",
  ]) assert.equal(isDestructive(bad), true, bad)
})

test("gate: reading the index is not a persist; appending to it is", () => {
  const st = { ...freshSession(0), nudges: 2 }
  const base = { st, tokens: 115_000, threshold: 101_000, proj: "/r", tool: "Bash" }
  for (const command of ["cat .opencode/context/index.md", "tail -5 .opencode/context/index.md"])
    assert.notEqual(decideGate({ ...base, toolInput: { command } }).completes, true, command)
  for (const command of [`echo "| d | s | x | y |" >> .opencode/context/index.md`])
    assert.equal(decideGate({ ...base, toolInput: { command } }).completes, true, command)
})

test("nudge: repeated persists back off instead of re-nudging every 12k tokens", () => {
  let st = { ...freshSession(0), persistedEpoch: 0, persistedTokens: 100_000, units: 1, persists: 1 }
  assert.equal(decideNudge({ tokens: 113_000, threshold: 101_000, st, now: 0 }), 1)
  st = { ...st, persists: 3 }
  assert.equal(decideNudge({ tokens: 113_000, threshold: 101_000, st, now: 0 }), null, "third persist: 48k quiet span")
  assert.equal(decideNudge({ tokens: 149_000, threshold: 101_000, st, now: 0 }), 1)
})

test("gate: Skill, AskUserQuestion, TodoWrite and ToolSearch are never blocked", () => {
  const st = { ...freshSession(0), nudges: 2 }
  for (const tool of ["Skill", "AskUserQuestion", "TodoWrite", "ToolSearch"])
    assert.equal(decideGate({ st, tokens: 115_000, threshold: 101_000, proj: "/r", tool, toolInput: {} }).allow, true, tool)
})

test("threshold: never later than 5k before the host's compaction point, even on a small window", () => {
  for (const w of [50_000, 60_000, 66_000, 100_000, 180_000]) {
    const t = resolveThreshold({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(w) }, {})
    const cp = w - 33_000
    assert.ok(t <= Math.max(cp - 5_000, 1_000), `window ${w}: threshold ${t} vs compaction point ${cp}`)
  }
})

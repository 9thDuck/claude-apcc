// Regression tests for the independent audit findings (2026-11-06). Each one drives the real
// handle() the way the host does and fails on the behaviour the audit reproduced.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decideGate, handle, GATE_GRACE_CALLS, isDestructive } from "./apcc.mjs"

const asst = (n) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: n, output_tokens: 0 } } })

// A tracked project whose directory name is `dir` (the audit's path-character cases).
function rigAt(dir, tokens = 100_000, tracked = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-fix-"))
  const proj = path.join(root, dir)
  fs.mkdirSync(tracked ? path.join(proj, ".opencode", "context") : proj, { recursive: true })
  const transcript = path.join(root, "t.jsonl")
  const setTokens = (n) => fs.writeFileSync(transcript, asst(n) + "\n")
  setTokens(tokens)
  const env = { CLAUDE_PROJECT_DIR: proj, APCC_CC_STATE_DIR: path.join(root, "state"), CLAUDE_CONFIG_DIR: path.join(root, "cfg"), CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000", PATH: path.join(root, "nobin") }
  const input = (extra = {}) => ({ session_id: "s1", transcript_path: transcript, cwd: proj, hook_event_name: "PreToolUse", ...extra })
  return { root, proj, env, input, setTokens }
}
const gate = (r, tool_name, tool_input, now) => handle("gate", r.input({ tool_name, tool_input }), r.env, now)
const denied = (res) => res?.hookSpecificOutput?.permissionDecision === "deny"
// Spends the post-nudge grace so the next gate call meets the armed gate.
const pastGrace = (r) => { for (let i = 0; i < GATE_GRACE_CALLS; i++) gate(r, "Read", {}, 0) }

// finding 1
for (const dir of ["My Projects/app", "código/app", "a+b/app"]) {
  test(`gate: absolute persist writes are allowed when the project path is "${dir}" and the gate is in the hard zone`, () => {
    const r = rigAt(dir, 133_000)
    assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 2)) // first nudge
    r.setTokens(145_000) // hard zone for a 180k window: the denial cap does not release the gate
    pastGrace(r)
    const ctx = path.join(r.proj, ".opencode", "context")
    assert.ok(denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 3)), "ordinary edit is blocked")
    assert.ok(!denied(gate(r, "Write", { file_path: path.join(ctx, "session-notes.md") }, 4)), "absolute notes write")
    assert.ok(!denied(gate(r, "Bash", { command: `echo '| d | s | n | x |' >> "${path.join(ctx, "index.md")}"` }, 5)), "quoted absolute index append")
    assert.ok(!denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 6)), "persist recorded, work resumes")
  })
}

test("gate: persist-path allowance still refuses traversal, look-alike dirs, other projects and symlinks out", () => {
  const r = rigAt("My Projects/app")
  const outside = path.join(r.root, "outside")
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(r.proj, ".opencode", "context", "link"))
  const st = { epoch: 0, nudges: 1, nudgeCalls: 9, persistedEpoch: -1, gateDenials: 0 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: r.proj }
  const ctx = path.join(r.proj, ".opencode", "context")
  const w = (file_path) => decideGate({ ...base, tool: "Write", toolInput: { file_path } }).allow
  assert.equal(w(path.join(ctx, "a.md")), true)
  assert.equal(w(path.join(ctx, "sub", "deep", "a.md")), true)
  assert.equal(w(path.join(ctx, "..", "..", "src", "a.ts")), false)
  assert.equal(w(path.join(r.proj, ".opencode", "context-evil", "a.md")), false)
  assert.equal(w(path.join(r.proj, "x", ".opencode", "context", "a.md")), false)
  assert.equal(w(path.join(ctx, "link", "a.md")), false)
  assert.equal(w(path.join(r.root, "other", ".opencode", "context", "a.md")), false)
  assert.equal(w(ctx), false)
  const b = (command) => decideGate({ ...base, tool: "Bash", toolInput: { command } }).allow
  assert.equal(b(`echo x >> "${path.join(ctx, "index.md")}"`), true)
  assert.equal(b(`echo x >> "${path.join(ctx, "..", "..", "src", "a.ts")}"`), false)
  assert.equal(b(`echo x >> "${path.join(ctx, "link", "a.md")}"`), false)
  assert.equal(b(`echo x >> "${path.join(r.proj, ".opencode", "context-evil", "i.md")}"`), false)
  assert.equal(b(`rm "${path.join(ctx, "index.md")}"`), false)
  // quoted traversal whose first segment holds a space must not be taken for prose
  assert.equal(b(`echo pwn >> "src dir/.opencode/context/../../../a.ts"`), false)
  assert.equal(b(`echo pwn >> 'a b/docs/research/../../../x.ts'`), false)
  assert.equal(b(`echo pwn >> "./src dir/.opencode/context/../../../a.ts"`), false)
  assert.equal(b(`cat "${path.join(r.proj, "src", "a.ts")}" > "${path.join(r.proj, "docs", "research", "..", "..", "x")}"`), false)
})

// finding 2
const stopWith = (r, text, now) => handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: text }), r.env, now)
const recover = (r, now) => {
  handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "auto" }), r.env, now)
  return handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, now + 1).hookSpecificOutput.additionalContext
}

test("a PERSISTED claim with no write behind it is not a persist: recovery says unverified and the gate stays armed", () => {
  const r = rigAt("proj", 133_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1))
  stopWith(r, "all saved\n\nPERSISTED: 3 units (plan, decision, next)", 2)
  r.setTokens(145_000)
  pastGrace(r)
  assert.ok(denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 3)), "gate still armed")
  const ctx = recover(r, 4)
  assert.doesNotMatch(ctx, /: DONE/)
  assert.match(ctx, /not verified/i)
})

test("a PERSISTED claim backed by a write to the notes, the index or a bead this context counts", () => {
  const notes = (r) => ["Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }]
  const index = () => ["Bash", { command: "echo '| d | s | n | x |' >> .opencode/context/index.md" }]
  const bead = () => ["Bash", { command: "bd note proj-1 'progress'" }]
  for (const write of [notes, index, bead]) {
    const r = rigAt("proj", 133_000)
    handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
    assert.ok(!denied(gate(r, ...write(r), 2)))
    stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 3)
    assert.match(recover(r, 4), /: DONE/, write.name)
  }
})

test("a write from before the last compaction does not back a claim made in the next context", () => {
  const r = rigAt("proj", 133_000)
  gate(r, "Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, 1)
  recover(r, 2)
  r.setTokens(133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 5)
  stopWith(r, "PERSISTED: 2 units (a, b)", 6)
  assert.match(recover(r, 7), /not verified/i)
})

// finding 3
test("a big jump past the grace tokens does not deny the in-flight edit after the first nudge; the gate engages after two calls", () => {
  const r = rigAt("proj", 125_000)
  assert.equal(handle("nudge", r.input({ hook_event_name: "PostToolUse" }), r.env, 0), null)
  r.setTokens(139_000) // one large Read: 125k -> 139k, already beyond threshold + 5k
  assert.ok(handle("nudge", r.input({ hook_event_name: "PostToolUse" }), r.env, 1), "first nudge")
  const edit = { file_path: path.join(r.proj, "src", "a.ts") }
  assert.ok(!denied(gate(r, "Edit", edit, 2)), "the step the nudge says to finish")
  assert.ok(!denied(gate(r, "Edit", edit, 3)), "second call")
  assert.ok(denied(gate(r, "Edit", edit, 4)), "then the gate is armed")
  assert.ok(!denied(gate(r, "Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, 5)), "persisting is never blocked")
})

// finding 6
const userLine = (text) => JSON.stringify({ type: "user", timestamp: "2026-11-06T10:00:00Z", message: { role: "user", content: text } })

test("untracked project: the user's words are saved at compaction and pointed to on restore, with no write into the project and no gate", () => {
  const r = rigAt("proj", 140_000, false)
  fs.writeFileSync(path.join(r.root, "t.jsonl"), [userLine("never touch the billing table"), asst(140_000)].join("\n") + "\n")
  const before = fs.readdirSync(r.proj)
  assert.equal(handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "auto" }), r.env, 1), null)
  const words = fs.readdirSync(path.join(r.root, "state")).filter((f) => f.includes("user-words"))
  assert.equal(words.length, 1, "words file in the state dir")
  const ctx = handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 2).hookSpecificOutput.additionalContext
  assert.ok(ctx.includes(path.join(r.root, "state", words[0])), "restore points at the words file")
  assert.match(ctx, /never touch the billing table/)
  assert.match(ctx, /nothing was persisted/i)
  assert.deepEqual(fs.readdirSync(r.proj), before, "nothing written into the project")
  assert.equal(handle("gate", r.input({ tool_name: "Edit", tool_input: { file_path: path.join(r.proj, "a.ts") } }), r.env, 3), null, "never gated")
  assert.equal(handle("precompact", r.input({ hook_event_name: "PreCompact", agent_id: "sub" }), { ...r.env }, 4), null)
  assert.equal(handle("precompact", r.input({ hook_event_name: "PreCompact" }), { ...r.env, APCC_CC_UNTRACKED: "0" }, 5), null)
})

test("PERSISTED: none stays an opt-out, and recovery says the model declined to persist", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  stopWith(r, "nothing to save\n\nPERSISTED (manual): none", 2)
  r.setTokens(145_000)
  assert.ok(!denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 3)))
  const ctx = recover(r, 4)
  assert.match(ctx, /declined to persist/i)
  assert.doesNotMatch(ctx, /: DONE/)
})

// finding 11
test("armed gate: plain reads, persist-dir setup and stopping a background job pass; delegation and the network stay blocked", () => {
  const r = rigAt("proj")
  const st = { epoch: 0, nudges: 1, nudgeCalls: 9, persistedEpoch: -1, gateDenials: 0 }
  const base = { st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: r.proj }
  const allow = (tool, toolInput) => decideGate({ ...base, tool, toolInput }).allow
  const sh = (command) => allow("Bash", { command })
  for (const c of ["pwd", "ls", "ls -la .opencode/context", "cat README.md", "mkdir -p docs/research", "mkdir -p docs/research/", "mkdir -p .opencode/context/",
    "mkdir -p .opencode/context && echo '.opencode/' >> .gitignore"]) assert.equal(sh(c), true, c)
  assert.equal(allow("KillShell", { shell_id: "b1" }), true)
  assert.equal(allow("TaskStop", { task_id: "b1" }), true)
  assert.equal(allow("Agent", { prompt: "persist for me" }), false)
  assert.equal(allow("WebFetch", { url: "https://example.com" }), false)
  // still blocked: anything that changes files outside the persist dirs
  for (const c of ["ls > src/a.ts", "ls; rm -rf src", "cat a | sh", "ls $(rm x)", "pwd && rm src/a.ts", "mkdir -p src/new", "mkdir -p docs/research/../../src",
    "mkdir -p -m 777 docs/research", "mkdir -p .opencode/context && echo 'x' >> src/a.ts", "mkdir -p .opencode/context && rm -rf src",
    "mkdir -p .opencode/context && echo '.opencode/' >> .gitignore && rm -rf src", "mkdir -p .opencode/context && echo '.opencode/' > .gitignore"]) assert.equal(sh(c), false, c)
})

// review follow-up 1: a claim is backed only by a real persist write made after the latest first nudge
test("a throwaway or command-output redirect into the persist dir does not back a PERSISTED claim", () => {
  for (const command of ["npm test >> .opencode/context/out.log", "cat src/a.ts >> .opencode/context/copy.md", "{ npm test; } >> .opencode/context/out.log", "ls -la 2>&1 >> .opencode/context/out.log", "git log --oneline > .opencode/context/log.txt"]) {
    const r = rigAt("proj", 133_000)
    assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1))
    gate(r, "Bash", { command }, 2)
    stopWith(r, "saved\n\nPERSISTED: 3 units (plan, decision, next)", 3)
    r.setTokens(145_000)
    pastGrace(r)
    assert.ok(denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 4)), `gate stays armed after: ${command}`)
    assert.match(recover(r, 5), /not verified/i, command)
  }
})

test("a persist write from early in the context, before the first nudge, does not back a later claim", () => {
  const r = rigAt("proj", 5_000)
  gate(r, "Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, 1)
  r.setTokens(133_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 2))
  stopWith(r, "saved\n\nPERSISTED: 3 units (plan, decision, next)", 3)
  r.setTokens(145_000)
  pastGrace(r)
  assert.ok(denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 4)), "gate stays armed")
  assert.match(recover(r, 5), /not verified/i)
})

test("a real write after the nudge verifies a claim even when an older write exists", () => {
  const r = rigAt("proj", 5_000)
  gate(r, "Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, 1)
  r.setTokens(133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 2)
  gate(r, "Bash", { command: "printf '%s\\n' '- 2026-11-06 plan: ship the fix, next run the gates' >> .opencode/context/session-notes.md" }, 3)
  stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 4)
  assert.match(recover(r, 5), /: DONE/)
})

// review follow-up 2: a new first nudge starts a fresh grace
test("the second persist cycle gets its own grace even when its first nudge lands before any tool call", () => {
  const r = rigAt("proj", 133_000)
  const edit = { file_path: path.join(r.proj, "src", "a.ts") }
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1))
  for (let i = 0; i < 4; i++) gate(r, "Read", {}, 2 + i) // grace spent, counter well past it
  gate(r, "Bash", { command: "echo '- 2026-11-06 cycle one: plan and decisions saved to notes' >> .opencode/context/session-notes.md" }, 6)
  stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 7)
  r.setTokens(147_000) // grew by more than a persist stays fresh, with no tool call in between
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 8), "second first-nudge")
  assert.ok(!denied(gate(r, "Edit", edit, 9)), "grace call 1")
  assert.ok(!denied(gate(r, "Edit", edit, 10)), "grace call 2")
})

// review follow-up 4: a persist delegated to a subagent in the same project backs the main thread's claim
test("a subagent's persist write backs the claim, without spending the main thread's grace or being gated", () => {
  const r = rigAt("proj", 133_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1))
  const sub = (tool_name, tool_input, now) => handle("gate", r.input({ tool_name, tool_input, agent_id: "a1" }), r.env, now)
  const notes = path.join(r.proj, ".opencode", "context", "session-notes.md")
  for (let i = 0; i < 5; i++) assert.equal(sub("Read", {}, 2 + i), null, "subagent reads are not counted as main-thread calls")
  assert.equal(sub("Write", { file_path: notes }, 8), null, "never gated")
  assert.equal(sub("Bash", { command: "npm test >> .opencode/context/out.log" }, 9), null)
  assert.equal(gate(r, "Read", {}, 10), null, "main grace call 1 still available")
  assert.equal(gate(r, "Read", {}, 11), null, "main grace call 2 still available")
  stopWith(r, "delegated and saved\n\nPERSISTED: 2 units (plan, next)", 12)
  assert.match(recover(r, 13), /: DONE/)
})

test("a subagent's throwaway write or a write into another project does not back a claim", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  const sub = (tool_name, tool_input, now) => handle("gate", r.input({ tool_name, tool_input, agent_id: "a1" }), r.env, now)
  sub("Bash", { command: "npm test >> .opencode/context/out.log" }, 2)
  sub("Write", { file_path: path.join(r.root, "other", ".opencode", "context", "session-notes.md") }, 3)
  stopWith(r, "PERSISTED: 2 units (plan, next)", 4)
  assert.match(recover(r, 5), /not verified/i)
})

// review 2, F7: only the main thread's reply can claim a persist
test("a PERSISTED line in a subagent's Stop does not release the main thread's gate", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  handle("gate", r.input({ tool_name: "Write", tool_input: { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, agent_id: "a1" }), r.env, 2)
  handle("stop", r.input({ hook_event_name: "Stop", agent_id: "a1", last_assistant_message: "PERSISTED: 4 units (a, b, c, d)" }), r.env, 3)
  r.setTokens(145_000)
  pastGrace(r)
  assert.ok(denied(gate(r, "Edit", { file_path: path.join(r.proj, "src", "a.ts") }, 4)), "the main thread has not claimed anything")
})

// review 2, F6: a prose index line is not a path just because it mentions "a/../b"
test("gate: an index line that quotes a relative path with '..' is allowed; a redirect target with '..' still is not", () => {
  const r = rigAt("proj")
  const st = { epoch: 0, nudges: 1, nudgeCalls: 9, persistedEpoch: -1, gateDenials: 0 }
  const b = (command) => decideGate({ st, tokens: 145_000, threshold: 132_000, compactAt: 147_000, proj: r.proj, tool: "Bash", toolInput: { command } }).allow
  assert.equal(b(`echo "| 2026-11-06 | imports | .opencode/context/session-notes.md | fixed src/../lib import |" >> .opencode/context/index.md`), true)
  assert.equal(b(`echo "| fixed src/../lib | .opencode/context/x |" >> "src dir/.opencode/context/../../a.ts"`), false)
  assert.equal(b(`echo x >> "src dir/.opencode/context/../../a.ts"`), false)
})

// review 2, F3/F4: freshness is judged by the token reading of the write against the latest nudge
test("a persist write made just before the first nudge still backs the claim made after it", () => {
  const r = rigAt("proj", 125_000) // below the 132k threshold, inside the fresh span
  gate(r, "Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, 1)
  r.setTokens(133_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "PostToolUse" }), r.env, 2), "the nudge fires on the next tool result")
  stopWith(r, "saved\n\nPERSISTED (manual): 1 unit (x)", 3)
  assert.match(recover(r, 4), /: DONE/)
})

test("a delta nudge needs a write after it: the earlier persist cannot back a bare delta claim", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  gate(r, "Bash", { command: "echo 'cycle one saved' >> .opencode/context/session-notes.md" }, 2)
  stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 3)
  r.setTokens(140_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 4), "delta nudge")
  stopWith(r, "PERSISTED: 1 unit (delta)", 5)
  r.setTokens(146_000)
  assert.match(recover(r, 6), /NOT DONE/)
})

test("a delta nudge answered with a real write is verified", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  gate(r, "Bash", { command: "echo 'cycle one saved' >> .opencode/context/session-notes.md" }, 2)
  stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 3)
  r.setTokens(140_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 4)
  gate(r, "Bash", { command: "echo 'delta: tax.ts done' >> .opencode/context/session-notes.md" }, 5)
  stopWith(r, "PERSISTED: 1 unit (delta)", 6)
  r.setTokens(146_000)
  assert.match(recover(r, 7), /: DONE/)
})

// review 2, F2: honest persist forms back a claim
test("honest Bash persist forms verify a claim: quoted ';', brace groups, heredocs, python/node writers", () => {
  const nl = "\n"
  const forms = [
    `printf '%s\\n' "state: refactor half done; next tax.ts" >> .opencode/context/session-notes.md`,
    `{ echo "state: refactor half done"; echo "next: tax.ts"; } >> .opencode/context/session-notes.md`,
    `echo "a && b | c" >> .opencode/context/session-notes.md`,
    "cat >> .opencode/context/session-notes.md <<'EOF'" + nl + "echo done" + nl + "cat later" + nl + "EOF",
    `mkdir -p .opencode/context && echo "plan saved" >> .opencode/context/session-notes.md`,
    `python3 -c "open('.opencode/context/session-notes.md','a').write('plan saved')"`,
    `node -e "require('fs').appendFileSync('.opencode/context/session-notes.md','plan saved')"`,
    `echo "| 2026-11-06 | x | .opencode/context/session-notes.md | y |" >> .opencode/context/index.md`,
  ]
  for (const command of forms) {
    const r = rigAt("proj", 133_000)
    handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
    gate(r, "Bash", { command }, 2)
    stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 3)
    assert.match(recover(r, 4), /: DONE/, command)
  }
})

// review 2, F1: backticks that bash does not execute are text, not a command substitution
test("isDestructive: backticks in quoted heredoc bodies, single quotes and escaped form are note text; live substitution still counts", () => {
  const nl = "\n"
  for (const ok of [
    "bd note ab-1 --stdin <<'EOF'" + nl + "Done: ran `npm install`, moved rounding to `money.ts`" + nl + "EOF",
    "cat >> .opencode/context/session-notes.md <<'EOF'" + nl + "ran `npm install` then `rm` the stale lock" + nl + "EOF",
    "cat >> .opencode/context/session-notes.md <<EOF" + nl + "ran \\`npm install\\` and it's fine" + nl + "EOF",
    "echo '- fixed `install` step' >> .opencode/context/index.md",
    'echo "- fixed \\`install\\` step" >> .opencode/context/index.md',
  ]) assert.equal(isDestructive(ok), false, ok)
  for (const bad of [
    "bd note ab-1 --stdin <<EOF" + nl + "ran `rm -rf src`" + nl + "EOF",
    'echo "$(rm -rf src)" >> .opencode/context/index.md',
    'echo "`rm -rf src`" >> .opencode/context/index.md',
    "echo `rm -rf src` >> .opencode/context/index.md",
    "bd note ab-1 \"it's $(rm -rf src)\"",
  ]) assert.equal(isDestructive(bad), true, bad)
})

test("gate: a refused persist command that only looks destructive is named in the deny text and points to Write", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  pastGrace(r)
  const res = gate(r, "Bash", { command: "echo 'ok' >> .opencode/context/index.md && rm -rf src" }, 2)
  assert.ok(denied(res))
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /looks destructive[\s\S]*Write/)
})

// review 3, finding 1: a persist write followed by a plain read-back is still a persist write
test("a persist write chained with or followed by a plain read-back still verifies a claim", () => {
  const nl = "\n"
  const forms = [
    `echo "state: refactor half done; next tax.ts" >> .opencode/context/session-notes.md && tail -n 3 .opencode/context/session-notes.md`,
    "cat >> .opencode/context/session-notes.md <<'EOF'" + nl + "state: half done" + nl + "EOF" + nl + "cat .opencode/context/session-notes.md",
  ]
  for (const command of forms) {
    const r = rigAt("proj", 133_000)
    handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
    gate(r, "Bash", { command }, 2)
    stopWith(r, "saved\n\nPERSISTED: 1 unit (x)", 3)
    assert.match(recover(r, 4), /: DONE/, command)
  }
})

// review 3, finding 2: the "not backed" text applies only while an unbacked claim is the latest word
test("the not-backed deny text does not outlive a later real persist and a fresh cycle", () => {
  const r = rigAt("proj", 133_000)
  handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 1)
  pastGrace(r)
  stopWith(r, "PERSISTED: 1 unit (bare)", 2)
  const first = gate(r, "Bash", { command: "npm test" }, 3)
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /not backed/)
  gate(r, "Write", { file_path: path.join(r.proj, ".opencode", "context", "session-notes.md") }, 4)
  stopWith(r, "PERSISTED: 1 unit (real)", 5)
  r.setTokens(150_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 6), "new first nudge")
  pastGrace(r)
  const later = gate(r, "Bash", { command: "npm test" }, 7)
  assert.ok(denied(later), "gate armed again")
  assert.doesNotMatch(later.hookSpecificOutput.permissionDecisionReason, /not backed/)
})

// review 3, finding 3: a subagent write made before the main thread has any token reading is old by the time of a later claim
test("a subagent write from before the first main-thread reading does not back a later claim", () => {
  const r = rigAt("proj", 5_000)
  const notes = path.join(r.proj, ".opencode", "context", "session-notes.md")
  handle("gate", r.input({ tool_name: "Write", tool_input: { file_path: notes }, agent_id: "a1" }), r.env, 1)
  r.setTokens(133_000)
  assert.ok(handle("nudge", r.input({ hook_event_name: "UserPromptSubmit" }), r.env, 2))
  stopWith(r, "PERSISTED: 2 units (x)", 3)
  r.setTokens(145_000)
  assert.match(recover(r, 4), /NOT DONE/)
})

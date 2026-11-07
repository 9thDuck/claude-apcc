#!/usr/bin/env node
// A worked example: one session's life with apcc, driven through the real hook (hooks/apcc.mjs) with
// the same JSON payloads Claude Code sends. No model is involved: the "model" steps (writing the
// notes, ending a reply with the marker) are played by this script, so what you see is exactly what the
// hook injects, denies and restores at each stage. Nothing outside a temp directory is touched.
//
//   node examples/walkthrough.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "apcc.mjs")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-example-"))
const proj = path.join(root, "my-app")
const transcript = path.join(root, "session.jsonl")
fs.mkdirSync(path.join(proj, ".opencode", "context"), { recursive: true })

const WINDOW = 150_000 // pretend autoCompactWindow; the host then compacts at ~117k
// Claude Code's transcript is JSONL: user lines (apcc keeps these verbatim) and assistant lines with usage.
const lines = []
const say = (text) => lines.push(JSON.stringify({ type: "user", timestamp: new Date(Date.UTC(2026, 0, 1, 9, lines.length)).toISOString(), message: { role: "user", content: text } }))
const setTokens = (n) => fs.writeFileSync(transcript, [...lines, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: n, output_tokens: 0 } } })].join("\n") + "\n")

function fire(event, payload) {
  const r = spawnSync(process.execPath, [hook, event], {
    input: JSON.stringify({ session_id: "example-1", transcript_path: transcript, cwd: proj, ...payload }),
    env: { APCC_PERSIST_THRESHOLD_TOKENS: "100000", PATH: "/usr/bin:/bin", HOME: root, CLAUDE_PROJECT_DIR: proj, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(WINDOW), APCC_CC_STATE_DIR: path.join(root, "state") },
    encoding: "utf8",
  })
  const out = r.stdout.trim()
  if (!out) return "(no output: apcc stays quiet)"
  try {
    const j = JSON.parse(out)
    return j.hookSpecificOutput?.additionalContext ?? j.hookSpecificOutput?.permissionDecisionReason ?? j.systemMessage ?? j.reason ?? out
  } catch {
    return out
  }
}
const step = (title, body) => console.log(`\n=== ${title}\n${String(body).replaceAll(proj, "/home/you/my-app").replaceAll(path.join(root, "state"), "~/.local/state/apcc-cc")}`)

say("Refactor the billing module. Constraint: never change the public API of billing/index.ts.")
setTokens(8_000)
step("1. You state a constraint early (UserPromptSubmit, 8k tokens)", fire("nudge", { hook_event_name: "UserPromptSubmit", prompt: "Refactor the billing module. Constraint: never change the public API of billing/index.ts." }))
console.log("   -> no output; apcc reads your messages from the transcript and keeps them verbatim in its own state directory.")

setTokens(100_000)
step("2. Context passes the persist threshold: apcc asks the model to persist (UserPromptSubmit, 100k tokens)", fire("nudge", { hook_event_name: "UserPromptSubmit", prompt: "continue" }))

say("continue")
setTokens(112_000)
// The nudge grants two tool calls to finish the atomic step in flight; the third meets the gate.
for (let i = 0; i < 2; i++) fire("gate", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(proj, "billing", "tax.ts") } })
step("3. The model ignored it, used its two grace calls and keeps working near the compaction point: the gate blocks (PreToolUse Bash, 112k tokens)", fire("gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }))

const notes = path.join(proj, ".opencode", "context", "session-notes.md")
fs.writeFileSync(notes, "# session notes\n- Task: refactor billing module.\n- Constraint (from user): never change the public API of billing/index.ts.\n- Decision: keep Invoice.total() as is; move rounding into money.ts.\n- Next: update billing/tax.ts to call money.round().\n")
step("4. The model writes its notes first (PreToolUse Write session-notes.md): allowed even at the gate", fire("gate", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: notes, content: "..." } }))
const index = path.join(proj, ".opencode", "context", "index.md")
fs.writeFileSync(index, "| 2026-11-06 | billing-refactor | .opencode/context/session-notes.md | refactor billing; API constraint; rounding moved to money.ts; next tax.ts |\n")
step("5. Then the index line, last (PreToolUse Write index.md): allowed, and recorded as the persist", fire("gate", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: index, content: "..." } }))
step("6. The model ends its reply with the marker (Stop)", fire("stop", { hook_event_name: "Stop", last_assistant_message: "Notes saved.\n\nPERSISTED: 1 units (billing-refactor)" }))
step("7. Tools work again (PreToolUse Bash)", fire("gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }))

step("8. The host auto-compacts (PreCompact)", fire("precompact", { hook_event_name: "PreCompact", trigger: "auto" }))
setTokens(12_000)
step("9. The new context starts (SessionStart, source=compact): apcc injects the recovery contract", fire("restore", { hook_event_name: "SessionStart", source: "compact" }))
console.log(`\n(temp dir ${root} can be deleted)`)

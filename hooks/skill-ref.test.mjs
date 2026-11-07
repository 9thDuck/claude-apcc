// The hook names the persist skill in its nudge and recovery text, and the name depends on how
// apcc was installed: a plugin namespaces every component under the plugin name, while the script
// install copies the skill into the user's skill directory as `persisting-context`.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nudgeText, recoveryText, freshSession, handle } from "./apcc.mjs"

test("nudge and recovery name the skill by mode", () => {
  const n = nudgeText({ tokens: 140_000, threshold: 135_000, which: 1, skill: "apcc:persisting-context" })
  assert.match(n, /^Skill: apcc:persisting-context$/m)
  const r = recoveryText({ source: "compact", st: freshSession(0), indexTail: "", tokensBefore: 1, skill: "apcc:persisting-context" })
  assert.match(r, /^Skill: apcc:persisting-context$/m)
  // Default (no argument) is the script-install name, and never leaks the plugin namespace.
  const d = nudgeText({ tokens: 140_000, threshold: 135_000, which: 1 })
  assert.match(d, /^Skill: persisting-context$/m)
  assert.doesNotMatch(d, /apcc:persisting-context/)
})

function rig(envExtra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-skill-"))
  const proj = path.join(root, "proj")
  fs.mkdirSync(path.join(proj, ".beads"), { recursive: true })
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const transcript = path.join(root, "t.jsonl")
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 120_000, output_tokens: 0 } } }) + "\n")
  const env = {
    CLAUDE_PROJECT_DIR: proj,
    APCC_CC_STATE_DIR: path.join(root, "state"),
    CLAUDE_CONFIG_DIR: path.join(root, "cfg"),
    APCC_PERSIST_THRESHOLD_TOKENS: "100000",
    PATH: bin,
    ...envExtra,
  }
  const input = (extra = {}) => ({ session_id: "s1", transcript_path: transcript, cwd: proj, hook_event_name: "UserPromptSubmit", ...extra })
  return { root, proj, env, input }
}

test("e2e as a plugin: nudge and recovery name apcc:persisting-context", () => {
  const r = rig({ CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), "plugin root") })
  const ctx = handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext
  assert.match(ctx, /^Skill: apcc:persisting-context$/m)
  const rec = handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 1000)
  assert.match(rec.hookSpecificOutput.additionalContext, /^Skill: apcc:persisting-context$/m)
})

test("e2e as a script install: nudge and recovery name persisting-context, not the namespace", () => {
  const r = rig()
  const ctx = handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext
  assert.match(ctx, /^Skill: persisting-context$/m)
  assert.doesNotMatch(ctx, /apcc:persisting-context/)
  const rec = handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 1000)
  assert.match(rec.hookSpecificOutput.additionalContext, /^Skill: persisting-context$/m)
  assert.doesNotMatch(rec.hookSpecificOutput.additionalContext, /apcc:persisting-context/)
})

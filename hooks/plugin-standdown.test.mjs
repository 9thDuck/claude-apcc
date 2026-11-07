// A plugin install and a script install both run the hooks, and the host does not dedupe a
// plugin's copy of the same handler. When both are present the plugin steps aside: silent for
// every event except one startup message per session telling the user how to remove the script.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handle, scriptInstallPresent, stateFile, SCRIPT_INSTALL_REL } from "./apcc.mjs"

// A real script install writes the runtime file AND wires it in settings.json. A leftover file
// with no settings entry does not run anything, so it must not make the plugin stand down.
function putInstall(dir) {
  const p = path.join(dir, SCRIPT_INSTALL_REL)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, "// script install\n")
}
function wire(dir) {
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${path.join(dir, SCRIPT_INSTALL_REL)}" stop` }] }] } }),
  )
}
function tempCfg(withInstall) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-standdown-"))
  const cfg = path.join(root, "cfg")
  fs.mkdirSync(cfg, { recursive: true })
  if (withInstall) {
    putInstall(cfg)
    wire(cfg)
  }
  return { root, cfg }
}

test("scriptInstallPresent: true only when settings.json wires the script install's hook file", () => {
  assert.equal(scriptInstallPresent({ CLAUDE_CONFIG_DIR: tempCfg(false).cfg }), false)
  assert.equal(scriptInstallPresent({ CLAUDE_CONFIG_DIR: tempCfg(true).cfg }), true)
  // A runtime file alone is not an install: nothing would run it.
  const leftover = tempCfg(false)
  putInstall(leftover.cfg)
  assert.equal(scriptInstallPresent({ CLAUDE_CONFIG_DIR: leftover.cfg }), false)
  // No CLAUDE_CONFIG_DIR: the user level is ~/.claude, taken from HOME (never the real home here).
  const h = tempCfg(true)
  fs.mkdirSync(path.join(h.root, ".claude"), { recursive: true })
  fs.cpSync(h.cfg, path.join(h.root, ".claude"), { recursive: true })
  assert.equal(scriptInstallPresent({ HOME: h.root }), true)
})

test("scriptInstallPresent: a --project install is found under the project's .claude", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-standdown-proj-"))
  const proj = path.join(root, "proj")
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true })
  putInstall(path.join(proj, ".claude"))
  wire(path.join(proj, ".claude"))
  const env = { CLAUDE_CONFIG_DIR: path.join(root, "cfg") }
  assert.equal(scriptInstallPresent(env), false, "user level has no install")
  assert.equal(scriptInstallPresent(env, proj), true, "the project-level install counts when the project dir is passed")
  assert.equal(scriptInstallPresent(env, path.join(root, "elsewhere")), false, "another project does not")
})

function rig({ plugin = true, install = true, projectInstall = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-standdown-e2e-"))
  const cfg = path.join(root, "cfg")
  fs.mkdirSync(cfg, { recursive: true })
  if (install) {
    putInstall(cfg)
    wire(cfg)
  }
  const proj = path.join(root, "proj")
  fs.mkdirSync(path.join(proj, ".beads"), { recursive: true })
  if (projectInstall) {
    fs.mkdirSync(path.join(proj, ".claude"), { recursive: true })
    putInstall(path.join(proj, ".claude"))
    wire(path.join(proj, ".claude"))
  }
  const bin = path.join(root, "bin")
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const transcript = path.join(root, "t.jsonl")
  fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 120_000, output_tokens: 0 } } }) + "\n")
  const env = {
    CLAUDE_PROJECT_DIR: proj,
    CLAUDE_CONFIG_DIR: cfg,
    APCC_CC_STATE_DIR: path.join(root, "state"),
    APCC_PERSIST_THRESHOLD_TOKENS: "100000",
    PATH: bin,
    ...(plugin ? { CLAUDE_PLUGIN_ROOT: path.join(root, "plugin root") } : {}),
  }
  const input = (extra = {}) => ({ session_id: "s1", transcript_path: transcript, cwd: proj, hook_event_name: "UserPromptSubmit", ...extra })
  return { root, env, input }
}

test("e2e: plugin + script install -> the plugin is silent for every event except startup", () => {
  const r = rig()
  assert.equal(handle("nudge", r.input(), r.env, 0), null)
  assert.equal(handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), r.env, 1), null)
  assert.equal(handle("stop", r.input({ hook_event_name: "Stop", last_assistant_message: "saved.\nPERSISTED: 1 unit (a)" }), r.env, 2), null)
  assert.equal(handle("precompact", r.input({ hook_event_name: "PreCompact", trigger: "auto" }), r.env, 3), null)
  assert.equal(handle("restore", r.input({ hook_event_name: "SessionStart", source: "compact" }), r.env, 4), null)
})

test("e2e: plugin + script install -> exactly one startup message per session, with the uninstall command", () => {
  const r = rig()
  const first = handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 0)
  assert.deepEqual(Object.keys(first), ["systemMessage"])
  assert.match(first.systemMessage, /standing down/)
  assert.match(first.systemMessage, /node scripts\/install\.mjs --uninstall/)
  assert.equal(handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 1000), null)
  const other = handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup", session_id: "s2" }), r.env, 2000)
  assert.match(other.systemMessage, /standing down/)
})

test("e2e: plugin + a --project script install -> the plugin stands down, using the payload cwd", () => {
  const r = rig({ install: false, projectInstall: true })
  // The plugin's hook process often has no CLAUDE_PROJECT_DIR; the payload's cwd names the project.
  const env = { ...r.env }
  delete env.CLAUDE_PROJECT_DIR
  assert.equal(handle("nudge", r.input(), env, 0), null)
  assert.equal(handle("gate", r.input({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }), env, 1), null)
  const first = handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), env, 2)
  assert.match(first.systemMessage, /standing down/)
})

test("e2e: plugin alone, or the script install alone, keeps working normally", () => {
  const pluginOnly = rig({ install: false })
  assert.match(handle("nudge", pluginOnly.input(), pluginOnly.env, 0).hookSpecificOutput.additionalContext, /Persist now/)
  const scriptOnly = rig({ plugin: false })
  assert.match(handle("nudge", scriptOnly.input(), scriptOnly.env, 0).hookSpecificOutput.additionalContext, /Persist now/)
})

test("e2e: a leftover runtime copy with no wired hooks does not stand the plugin down", () => {
  const r = rig({ install: false })
  putInstall(r.env.CLAUDE_CONFIG_DIR) // copied before an aborted settings write
  assert.equal(scriptInstallPresent(r.env), false)
  assert.match(handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext, /Persist now/)
  const startup = handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 1)
  assert.doesNotMatch(startup?.systemMessage ?? "", /standing down/)
})

test("e2e: settings.json wires a hook file that was deleted -> the plugin runs and says the script install is broken", () => {
  const r = rig()
  fs.rmSync(path.join(r.env.CLAUDE_CONFIG_DIR, SCRIPT_INSTALL_REL)) // wired, but nothing there to run
  assert.equal(scriptInstallPresent(r.env), false)
  assert.match(handle("nudge", r.input(), r.env, 0).hookSpecificOutput.additionalContext, /Persist now/)
  const startup = handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 1)
  assert.match(startup.systemMessage, /script install is broken/)
  assert.match(startup.systemMessage, /node scripts\/install\.mjs/)
  assert.doesNotMatch(startup.systemMessage, /standing down/)
  assert.equal(handle("restore", r.input({ hook_event_name: "SessionStart", source: "startup" }), r.env, 2), null, "warned once per session")
})

test("e2e: an untracked project gets no stand-down message and no state write", () => {
  const r = rig()
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-standdown-untracked-"))
  const env = { ...r.env, CLAUDE_PROJECT_DIR: proj }
  assert.equal(handle("restore", { session_id: "s1", cwd: proj, source: "startup" }, env, 0), null)
  assert.equal(fs.existsSync(stateFile(proj, env)), false, "untracked projects stay untouched, state included")
})

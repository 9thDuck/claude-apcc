// A plugin cannot set autoCompactWindow, so at startup apcc tells the user once per session when
// no window is visible (env, user, project or local settings) and never writes any settings.
// The setting must be found wherever the host would find it, local winning over project over user.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handle, BEADS_NO_BD_LINE, SCRIPT_INSTALL_REL } from "./apcc.mjs"

const HINT =
  'apcc: autoCompactWindow not found; add "autoCompactWindow": 180000 to settings.json so the persist threshold matches your compaction point.'

function rig({ scriptInstall = false, beads = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-window-"))
  const cfg = path.join(root, "cfg")
  fs.mkdirSync(cfg, { recursive: true })
  const proj = path.join(root, "proj")
  fs.mkdirSync(path.join(proj, ".opencode", "context"), { recursive: true })
  if (beads) fs.mkdirSync(path.join(proj, ".beads"))
  if (scriptInstall) {
    // A real script install is the runtime file plus a settings entry that wires it.
    const file = path.join(cfg, SCRIPT_INSTALL_REL)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "// script install\n")
    fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${file}" stop` }] }] } }))
  }
  const env = {
    CLAUDE_PROJECT_DIR: proj,
    CLAUDE_CONFIG_DIR: cfg,
    APCC_CC_STATE_DIR: path.join(root, "state"),
    PATH: path.join(root, "empty-bin"), // no bd
  }
  const input = (extra = {}) => ({ session_id: "s1", cwd: proj, hook_event_name: "SessionStart", source: "startup", ...extra })
  const writeSetting = (where, value) => {
    const f = where === "user" ? path.join(cfg, "settings.json") : path.join(proj, ".claude", where === "local" ? "settings.local.json" : "settings.json")
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify({ autoCompactWindow: value }))
    return f
  }
  return { root, cfg, proj, env, input, writeSetting }
}

test("startup with no window anywhere: exactly one hint, once per session", () => {
  const r = rig()
  const first = handle("restore", r.input(), r.env, 0)
  assert.equal(first?.systemMessage, HINT)
  assert.equal(handle("restore", r.input(), r.env, 1000), null, "same session is silent the second time")
  const again = handle("restore", r.input({ session_id: "s2" }), r.env, 2000)
  assert.equal(again?.systemMessage, HINT, "a new session gets its own hint")
})

test("a window in the environment silences the hint", () => {
  const r = rig()
  assert.equal(handle("restore", r.input(), { ...r.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" }, 0), null)
})

test("a window in user settings silences the hint", () => {
  const r = rig()
  r.writeSetting("user", 180000)
  assert.equal(handle("restore", r.input(), r.env, 0), null)
})

test("a window in project settings silences the hint", () => {
  const r = rig()
  r.writeSetting("project", 180000)
  assert.equal(handle("restore", r.input(), r.env, 0), null)
})

test("a window in project-local settings silences the hint", () => {
  const r = rig()
  r.writeSetting("local", 180000)
  assert.equal(handle("restore", r.input(), r.env, 0), null)
})

test("settings precedence is local, then project, then user", async () => {
  const { readSettings } = await import("./apcc.mjs")
  const r = rig()
  r.writeSetting("user", 100_000)
  r.writeSetting("project", 150_000)
  r.writeSetting("local", 180_000)
  assert.equal(readSettings(r.env, r.proj).autoCompactWindow, 180_000)
  fs.rmSync(path.join(r.proj, ".claude", "settings.local.json"))
  assert.equal(readSettings(r.env, r.proj).autoCompactWindow, 150_000)
  fs.rmSync(path.join(r.proj, ".claude", "settings.json"))
  assert.equal(readSettings(r.env, r.proj).autoCompactWindow, 100_000)
})

test("resume and compact never show the hint", () => {
  const r = rig()
  assert.equal(handle("restore", r.input({ source: "resume" }), r.env, 0), null)
  const c = handle("restore", r.input({ source: "compact" }), r.env, 1000)
  assert.equal(c?.systemMessage, undefined)
  assert.ok(!JSON.stringify(c ?? {}).includes("autoCompactWindow not found"))
})

test("the kill switch silences the hint", () => {
  const r = rig()
  assert.equal(handle("restore", r.input(), { ...r.env, APCC_CC: "0" }, 0), null)
})

test("a wired script install sets the window itself, so no hint", () => {
  const r = rig({ scriptInstall: true })
  assert.equal(handle("restore", r.input(), r.env, 0), null)
})

test("beads-without-bd and no-window combine into one startup systemMessage", () => {
  const r = rig({ beads: true })
  const first = handle("restore", r.input(), r.env, 0)
  assert.equal(typeof first?.systemMessage, "string")
  assert.ok(first.systemMessage.includes(BEADS_NO_BD_LINE), first.systemMessage)
  assert.ok(first.systemMessage.includes(HINT), first.systemMessage)
  assert.equal(handle("restore", r.input(), r.env, 1000), null, "both warnings are already spent")
})

test("the hint never writes a settings file", () => {
  const r = rig()
  assert.ok(handle("restore", r.input(), r.env, 0)?.systemMessage)
  assert.equal(fs.existsSync(path.join(r.cfg, "settings.json")), false)
  assert.equal(fs.existsSync(path.join(r.proj, ".claude")), false)
})

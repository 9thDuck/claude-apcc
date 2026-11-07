// The script installer must not wire a second copy of the hooks when the plugin is installed:
// the host runs the plugin's handler separately, so restore and nudge would fire twice.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { scriptInstallPresent } from "./apcc.mjs"

const install = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install.mjs")

// installed_plugins.json records installs as `name@marketplace`; the real file nests them under
// "plugins". The guard accepts both shapes.
function cfg(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-install-guard-"))
  const dir = path.join(root, "cfg")
  fs.mkdirSync(path.join(dir, "plugins"), { recursive: true })
  const f = path.join(dir, "plugins", "installed_plugins.json")
  if (body !== undefined) fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body))
  return { root, dir }
}

const run = (dir, ...args) =>
  spawnSync(process.execPath, [install, ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: path.dirname(dir) },
    encoding: "utf8",
  })

const runProject = (dir, cwd, ...args) =>
  spawnSync(process.execPath, [install, "--project", ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, HOME: path.dirname(dir) },
    cwd,
    encoding: "utf8",
  })

function project(c) {
  const cwd = path.join(c.root, "proj")
  fs.mkdirSync(cwd, { recursive: true })
  return cwd
}

test("installer refuses when the plugin is installed, and does not write settings", () => {
  const c = cfg({ version: 2, plugins: { "apcc@apcc": [{ scope: "user", version: "1.0.0" }] } })
  const r = run(c.dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /installed as a plugin/)
  assert.match(r.stdout + r.stderr, /--force/)
  assert.equal(fs.existsSync(path.join(c.dir, "settings.json")), false)
})

test("installer refuses on a top-level apcc@ key too", () => {
  const c = cfg({ "apcc@apcc": [] })
  assert.equal(run(c.dir).status, 1)
})

test("--force installs anyway", () => {
  const c = cfg({ version: 2, plugins: { "apcc@apcc": [{}] } })
  const r = run(c.dir, "--force")
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(c.dir, "settings.json"), "utf8"))
  assert.ok(Array.isArray(settings.hooks?.UserPromptSubmit))
})

test("--project refuses when the plugin is installed at the user level", () => {
  const c = cfg({ version: 2, plugins: { "apcc@apcc": [{}] } })
  const cwd = project(c)
  const r = runProject(c.dir, cwd)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /installed as a plugin/)
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "settings.json")), false)
})

test("--project refuses when the plugin is installed at the project level", () => {
  const c = cfg(undefined)
  const cwd = project(c)
  fs.mkdirSync(path.join(cwd, ".claude", "plugins"), { recursive: true })
  fs.writeFileSync(path.join(cwd, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "apcc@apcc": [{}] } }))
  const r = runProject(c.dir, cwd)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /installed as a plugin/)
  assert.equal(fs.existsSync(path.join(cwd, ".claude", "settings.json")), false)
})

test("--project --force installs anyway", () => {
  const c = cfg({ version: 2, plugins: { "apcc@apcc": [{}] } })
  const cwd = project(c)
  const r = runProject(c.dir, cwd, "--force")
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8"))
  assert.ok(Array.isArray(settings.hooks?.UserPromptSubmit))
})

test("--uninstall always works", () => {
  const c = cfg({ version: 2, plugins: { "apcc@apcc": [{}] } })
  const r = run(c.dir, "--uninstall")
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout + r.stderr, /installed as a plugin/)
})

test("--project prints the resolved target and warns when run from a subdirectory of a project", () => {
  const c = cfg(undefined)
  const root = project(c)
  fs.mkdirSync(path.join(root, ".git"))
  const sub = path.join(root, "sub")
  fs.mkdirSync(sub)
  const r = runProject(c.dir, sub)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /--project target: /)
  assert.ok(r.stdout.includes(path.join(sub, ".claude")), "the resolved target is printed")
  assert.match(r.stdout + r.stderr, /warning: .*has no \.git/)
  assert.ok(fs.existsSync(path.join(sub, ".claude", "settings.json")), "it still installs where it was told to")
})

test("--project run from the project root prints the target and does not warn", () => {
  const c = cfg(undefined)
  const root = project(c)
  fs.mkdirSync(path.join(root, ".git"))
  const r = runProject(c.dir, root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /--project target: /)
  assert.doesNotMatch(r.stdout + r.stderr, /warning:/)
})

test("the installer and the hook agree on where the script install puts the runtime", () => {
  const c = cfg({ version: 2, plugins: { "other@market": [{}] } })
  assert.equal(run(c.dir).status, 0)
  assert.equal(scriptInstallPresent({ CLAUDE_CONFIG_DIR: c.dir }), true)
})

test("other plugins do not block the script install", () => {
  const c = cfg({ version: 2, plugins: { "other@market": [{}] } })
  assert.equal(run(c.dir).status, 0)
})

test("an unreadable installed_plugins.json is reported, not crashed on", () => {
  const c = cfg("{not json")
  const r = run(c.dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /could not read .*installed_plugins\.json/)
})

test("an unknown option exits 2 and installs nothing", () => {
  const c = cfg()
  const r = run(c.dir, "--frobnicate")
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.equal(fs.existsSync(path.join(c.dir, "settings.json")), false)
  assert.equal(fs.existsSync(path.join(c.dir, "hooks")), false)
})

test("--help and -h print usage to stdout, exit 0 and install nothing", () => {
  for (const f of ["--help", "-h"]) {
    const c = cfg()
    const r = run(c.dir, f)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /Usage:.*install\.mjs/)
    assert.match(r.stdout, /--dry-run/)
    assert.equal(fs.existsSync(path.join(c.dir, "settings.json")), false)
    assert.equal(fs.existsSync(path.join(c.dir, "hooks")), false)
  }
})

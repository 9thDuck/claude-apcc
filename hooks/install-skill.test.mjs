// The script installer ships the persist skill too. It writes an ownership marker as the first
// body line (the frontmatter must stay first for the skill loader), never overwrites a skill the
// user wrote themselves, and removes only its own copy on --uninstall.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const install = path.join(here, "..", "scripts", "install.mjs")
const srcFile = path.join(here, "..", "skills", "persisting-context", "SKILL.md")
const version = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version
const marker = `<!-- installed by apcc ${version} -->`
const MARKER_RE = /^<!-- installed by apcc [^>]+ -->$/m

const bodyOf = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, "").trimStart()

// The installer refuses without `bd` on PATH, so the tests put a stub first on PATH.
const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-stub-bd-"))
fs.writeFileSync(path.join(stubBin, "bd"), "#!/bin/sh\n", { mode: 0o755 })

function cfg() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-install-skill-"))
  const dir = path.join(root, "cfg")
  fs.mkdirSync(dir, { recursive: true })
  return { root, dir }
}

function run(dir, args = [], opts = {}) {
  return spawnSync(process.execPath, [install, ...args], {
    env: { ...process.env, PATH: stubBin + path.delimiter + process.env.PATH, CLAUDE_CONFIG_DIR: dir, HOME: path.dirname(dir), ...opts.env },
    cwd: opts.cwd,
    encoding: "utf8",
  })
}

const skillDir = (dir) => path.join(dir, "skills", "persisting-context")
const skillFile = (dir) => path.join(skillDir(dir), "SKILL.md")

test("skill source itself carries no install marker", () => {
  assert.doesNotMatch(fs.readFileSync(srcFile, "utf8"), MARKER_RE)
})

test("install copies the skill with the version marker as the first body line", () => {
  const c = cfg()
  const r = run(c.dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const text = fs.readFileSync(skillFile(c.dir), "utf8")
  // The frontmatter must stay first; the marker is the first line after it.
  assert.match(text, /^---\n/)
  const fm = text.match(/^---\n[\s\S]*?\n---\n/)
  assert.ok(fm, "installed skill keeps valid frontmatter at the top")
  assert.equal(text.slice(fm[0].length).trimStart().split("\n")[0], marker)
  const srcBody = bodyOf(fs.readFileSync(srcFile, "utf8"))
  assert.ok(text.includes(srcBody), "the shipped body is copied verbatim")
})

test("--uninstall removes the skill dir only because the marker is present", () => {
  const c = cfg()
  assert.equal(run(c.dir).status, 0)
  assert.ok(fs.existsSync(skillFile(c.dir)))
  const u = run(c.dir, ["--uninstall"])
  assert.equal(u.status, 0, u.stdout + u.stderr)
  assert.equal(fs.existsSync(skillFile(c.dir)), false)
  assert.equal(fs.existsSync(skillDir(c.dir)), false, "the skill dir is removed, not just the file")
})

test("a pre-existing skill without the marker is kept byte-identical by install and uninstall", () => {
  const c = cfg()
  fs.mkdirSync(skillDir(c.dir), { recursive: true })
  const mine = "---\nname: persisting-context\ndescription: my own copy, do not touch\n---\n\n# mine\n"
  fs.writeFileSync(skillFile(c.dir), mine)
  const r = run(c.dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /existing persisting-context skill kept/)
  assert.match(r.stdout + r.stderr, /diff it against skills\/persisting-context\/SKILL\.md/)
  assert.equal(fs.readFileSync(skillFile(c.dir), "utf8"), mine)
  const u = run(c.dir, ["--uninstall"])
  assert.equal(u.status, 0, u.stdout + u.stderr)
  assert.equal(fs.readFileSync(skillFile(c.dir), "utf8"), mine)
})

test("--dry-run writes no skill and no settings", () => {
  const c = cfg()
  const r = run(c.dir, ["--dry-run"])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout + r.stderr, /would write .*SKILL\.md/)
  assert.equal(fs.existsSync(skillFile(c.dir)), false)
  assert.equal(fs.existsSync(path.join(c.dir, "settings.json")), false)
})

test("--project installs the skill under ./.claude in the current directory", () => {
  const c = cfg()
  const cwd = path.join(c.root, "proj")
  fs.mkdirSync(cwd)
  const r = run(c.dir, ["--project"], { cwd })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const f = path.join(cwd, ".claude", "skills", "persisting-context", "SKILL.md")
  assert.ok(fs.existsSync(f), `missing ${f}`)
  assert.match(fs.readFileSync(f, "utf8"), MARKER_RE)
  assert.equal(fs.existsSync(path.join(c.dir, "skills")), false, "user scope untouched by --project")
})

// `npm test` must not pass a quoted glob to `node --test`: older Node releases do not expand it
// and the run can silently test nothing. The runner lists the files itself and passes explicit
// paths, which every supported Node accepts.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, "..")
const runner = path.join(root, "scripts", "test.mjs")

// A tree with the runner copied in and the given files under it, for black-box runs.
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-runner-"))
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true })
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true })
  fs.copyFileSync(runner, path.join(dir, "scripts", "test.mjs"))
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), body)
  }
  return dir
}
// A `node --test` child inside this test process would see NODE_TEST_CONTEXT and refuse to run
// files (Node treats it as a recursive runner). Run it as a plain process, like `npm test` does.
const cleanEnv = () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  return env
}
const runIn = (dir, ...args) =>
  spawnSync(process.execPath, [path.join(dir, "scripts", "test.mjs"), ...args], { cwd: dir, encoding: "utf8", env: cleanEnv() })

test("npm test runs the explicit-file runner, not a shell/node glob", () => {
  const script = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts.test
  assert.equal(script, "node scripts/test.mjs")
  assert.doesNotMatch(script, /[*?[\]]/)
})

const walkTests = (dir, out = []) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walkTests(p, out)
    else if (ent.name.endsWith(".test.mjs")) out.push(p)
  }
  return out
}

test("the runner lists every hooks/**/*.test.mjs file by explicit path", () => {
  const r = spawnSync(process.execPath, [runner, "--list"], { encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  const listed = r.stdout.trim().split("\n").filter(Boolean).map((f) => path.basename(f)).sort()
  const actual = walkTests(here).map((f) => path.basename(f)).sort()
  assert.deepEqual(listed, actual)
})

test("an empty hooks/ directory fails loudly instead of falling back to cwd discovery", () => {
  // A passing test outside hooks/ must not be run by a run that tests nothing.
  const dir = tree({ "outside.test.mjs": 'import test from "node:test"\ntest("outside", () => {})\n' })
  const r = runIn(dir)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stderr, /no .*test files/i)
  assert.doesNotMatch(r.stdout, /outside/)
})

test("the runner finds tests in subdirectories of hooks/", () => {
  const dir = tree({ "hooks/sub/deep.test.mjs": 'import test from "node:test"\ntest("deep", () => {})\n' })
  const list = runIn(dir, "--list")
  assert.equal(list.status, 0, list.stderr)
  assert.match(list.stdout, /hooks[/\\]sub[/\\]deep\.test\.mjs/)
  const run = runIn(dir)
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /deep/)
})

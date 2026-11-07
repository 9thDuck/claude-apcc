#!/usr/bin/env node
// Run every hooks/*.test.mjs by explicit path.
//
// `node --test "hooks/*.test.mjs"` depends on Node expanding the quoted glob; older releases do
// not, and the run can pass while testing nothing. Listing the files here works on Node 18, 20 and
// 22 alike. `--list` prints the paths the runner would use (used by hooks/test-runner.test.mjs).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const hooksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks")

// Every *.test.mjs under hooks/, subdirectories included.
function collect(dir) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (e.code === "ENOENT") return out
    throw e
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...collect(p))
    else if (ent.isFile() && ent.name.endsWith(".test.mjs")) out.push(p)
  }
  return out.sort()
}

const files = collect(hooksDir)

// With no paths, `node --test` falls back to its own cwd discovery: the run passes while testing
// something outside hooks/, or exits 0 testing nothing. Fail loudly instead.
if (!files.length) {
  console.error(`test: no test files (*.test.mjs) found under ${hooksDir}`)
  process.exit(1)
}

if (process.argv.includes("--list")) {
  for (const f of files) console.log(f)
  process.exit(0)
}

const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
process.exit(r.status ?? 1)

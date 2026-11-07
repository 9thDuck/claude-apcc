// The hook must run its CLI when reached through a path the plugin cache and local
// checkouts really produce: one with a space, and one behind a symlink. A false main
// check exits 0 and does nothing, silently.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { VERSION } from "./apcc.mjs"

const src = new URL("./apcc.mjs", import.meta.url)
const runVersion = (p) => execFileSync(process.execPath, [p, "--version"], { encoding: "utf8" }).trim()

test("entry guard runs when the path contains a space", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apcc space "))
  try {
    const p = path.join(dir, "apcc.mjs")
    fs.copyFileSync(src, p)
    assert.equal(runVersion(p), VERSION)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("entry guard runs through a symlink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-link-"))
  try {
    const p = path.join(dir, "linked-apcc.mjs")
    fs.symlinkSync(src, p)
    assert.equal(runVersion(p), VERSION)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

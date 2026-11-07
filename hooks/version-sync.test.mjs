// One source of truth for the version: package.json. Every copy must agree, and the
// marketplace entry must not pin a version of its own (the manifest version wins).
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { VERSION } from "./apcc.mjs"

const j = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url)))

test("version copies agree", () => {
  const v = j("package.json").version
  assert.equal(j(".claude-plugin/plugin.json").version, v)
  assert.equal(VERSION, v)
  const top = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").match(/^##\s*\[?(\d+\.\d+\.\d+)/m)?.[1]
  assert.equal(top, v)
  for (const p of j(".claude-plugin/marketplace.json").plugins) assert.equal(p.version, undefined)
})

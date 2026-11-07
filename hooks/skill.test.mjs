import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The shipped skill must stay generic: no this-laptop paths, token numbers, owner-tool names
// or skills apcc does not ship, and every `bd` line conditional on beads being usable.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "persisting-context")
const file = path.join(dir, "SKILL.md")

function read() {
  return fs.readFileSync(file, "utf8")
}

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(m, "SKILL.md must start with --- frontmatter ---")
  const fields = {}
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "")
  }
  return { fields, body: text.slice(m[0].length) }
}

test("skill: skills/persisting-context/SKILL.md exists", () => {
  assert.ok(fs.existsSync(file), `missing ${file}`)
})

test("skill: frontmatter name matches the directory and description is non-empty", () => {
  const { fields } = frontmatter(read())
  assert.equal(fields.name, path.basename(dir))
  assert.ok(fields.description && fields.description.length > 20, "description must describe the skill")
})

test("skill: no laptop-specific paths, token numbers, owner-tool names or unshipped skills", () => {
  const text = read()
  for (const banned of [
    /~\/\.claude\/hooks/,
    /\b(?:132|137|15|180|33|5|10)k\b/,
    /opencode apcc plugin/i,
    /\bsession-end\b/i,
    /\bhandoff\b/i,
  ])
    assert.doesNotMatch(text, banned, `laptop-specific content left in SKILL.md: ${banned}`)
})

test("skill: every line mentioning `bd ` sits under or beside conditional wording", () => {
  const { body } = frontmatter(read())
  const COND = /\b(if|when|only|optional|requires?|unless|conditional)\b/i
  const offenders = []
  let heading = ""
  const lines = body.split("\n")
  lines.forEach((line, i) => {
    if (/^#{1,6}\s/.test(line)) heading = line
    if (!/\bbd\s/.test(line)) return
    const near = `${lines[i - 1] ?? ""} ${lines[i + 1] ?? ""}`
    if (COND.test(line) || COND.test(heading) || COND.test(near)) return
    offenders.push(line)
  })
  assert.deepEqual(offenders, [])
})

test("skill: the manual marker instruction matches the parser grammar exactly", () => {
  const { body } = frontmatter(read())
  assert.match(body, /PERSISTED \(manual\): <n> units/)
  assert.doesNotMatch(body, /PERSISTED \(manual\): \.\.\./)
})

test("skill: beads keeps only `bd note` and `bd create`, and carries the context route", () => {
  const { body } = frontmatter(read())
  assert.match(body, /\bbd note\b/)
  assert.match(body, /\bbd create\b/)
  for (const banned of [/--ephemeral/, /discovered-from/, /-t decision/, /\bbd dep\b/, /\bbd prime\b/, /\bbd show\b/])
    assert.doesNotMatch(body, banned)
  assert.match(body, /\.opencode\/context\/index\.md/)
  assert.match(body, /\.opencode\/context\/session-notes\.md/)
  assert.match(body, /PERSISTED: <n> units/)
})

#!/usr/bin/env node
// Installs claude-apcc: copies hooks/apcc.mjs into <claude-dir>/hooks/apcc/ and merges six hook
// entries into settings.json. Idempotent (re-running replaces only our entries), reversible
// (--uninstall), and it backs up a settings.json it cannot parse instead of overwriting it.
//
//   node scripts/install.mjs [--project] [--window 180000] [--dry-run] [--uninstall] [--force]
//
// --project installs into ./.claude (this repo only); default is ~/.claude (all projects).
// CLAUDE_CONFIG_DIR is honoured for the user-level install.
// --force installs even when the apcc plugin is already installed (the two would double-fire).
//
// It also ships skills/persisting-context/SKILL.md. The installed copy carries an ownership
// marker as the first body line (after the frontmatter, which must stay first); a skill without
// that marker is the user's own and is never overwritten or removed.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { EVENTS } from "../hooks/apcc.mjs"

const MARK = "claude-apcc" // appears in every command we write, so we can find and replace our own entries
const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, "..", "hooks", "apcc.mjs")
const version = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version
const skillSrc = path.join(here, "..", "skills", "persisting-context", "SKILL.md")

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d)

if (flag("--help") || flag("-h")) {
  console.log(`Usage: node scripts/install.mjs [options]

Installs the apcc hooks into ~/.claude (user level) or the current project.

Options:
  --project         install into ./.claude instead of ~/.claude
  --dry-run         show what would change, write nothing
  --uninstall       remove the apcc hooks and skill copy
  --force           install even if the apcc plugin is installed
  --window <tokens> set autoCompactWindow (default 180000)
  -h, --help        show this help`)
  process.exit(0)
}

const KNOWN = new Set(["--project", "--dry-run", "--uninstall", "--window", "--force"])
const unknown = argv.filter((a) => a.startsWith("--") && !KNOWN.has(a))
if (unknown.length) {
  console.error(`install: unknown option ${unknown.join(" ")}. Options: --project --dry-run --uninstall --force --window <tokens>. Nothing was changed.`)
  process.exit(2)
}

const project = flag("--project")
const dry = flag("--dry-run")
const uninstall = flag("--uninstall")
const window = Number(opt("--window", "180000"))
if (!Number.isInteger(window) || window < 50_000) {
  console.error("install: --window must be an integer >= 50000 (tokens)")
  process.exit(2)
}

const claudeDir = project
  ? path.join(process.cwd(), ".claude")
  : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
const hookDir = path.join(claudeDir, "hooks", "apcc", MARK)
const hookFile = path.join(hookDir, "apcc.mjs")
const settingsFile = path.join(claudeDir, "settings.json")
const skillDir = path.join(claudeDir, "skills", "persisting-context")
const skillFile = path.join(skillDir, "SKILL.md")

const log = (m) => console.log("[install] " + m)

// --project resolves against the working directory, not the project root, and the hook's stand-down
// check looks at the root. Say where the install is going, and warn (do not fail) when the cwd
// looks like a subdirectory of a project.
if (project) {
  log(`--project target: ${claudeDir}`)
  const markers = [".git", ".opencode", ".claude"]
  const looksLikeProject = (d) => markers.some((m) => fs.existsSync(path.join(d, m)))
  const cwd = process.cwd()
  if (!looksLikeProject(cwd)) {
    let p = path.dirname(cwd)
    for (;;) {
      if (looksLikeProject(p)) {
        console.error(
          `[install] warning: ${cwd} has no .git, .opencode or .claude, but ${p} does; --project installs into the current directory (${claudeDir}). Run it from ${p} if you meant that project.`,
        )
        break
      }
      const up = path.dirname(p)
      if (up === p) break
      p = up
    }
  }
}

// Ownership marker. The skill loader needs the frontmatter first, so the marker is the first
// line after it, not literally line one of the file.
const SKILL_MARK = "<!-- installed by apcc "
const skillMarker = `${SKILL_MARK}${version} -->`
const hasSkillMarker = (text) => /^<!-- installed by apcc [^>]+ -->$/m.test(text)

function withMarker(text) {
  const fm = text.match(/^---\n[\s\S]*?\n---\n/)
  const rest = (fm ? text.slice(fm[0].length) : text).replace(/^\n+/, "")
  return `${fm ? fm[0] : ""}${skillMarker}\n\n${rest}`
}

// A plugin install runs the same hooks, and Claude Code does not dedupe a plugin's copy of the
// same handler: wiring the script install on top would fire every handler twice. Refuse unless
// --force. --uninstall must always work, so a leftover script install can be cleaned up.
function pluginInstalled() {
  // --project writes into ./.claude but a plugin may be installed at the user level (or the reverse):
  // both copies would still fire every handler, so check both the target and the user config dir.
  const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
  const dirs = [...new Set([claudeDir, userDir].map((d) => path.resolve(d)))]
  for (const dir of dirs) {
    const f = path.join(dir, "plugins", "installed_plugins.json")
    let v
    try {
      v = JSON.parse(fs.readFileSync(f, "utf8"))
    } catch (e) {
      if (e.code !== "ENOENT") log(`could not read ${f} (${e.message}); assuming no plugin install`)
      continue
    }
    // Installs are keyed `name@marketplace`; the host nests them under "plugins", older shapes do not.
    const keys = [...Object.keys(v ?? {}), ...Object.keys(v?.plugins ?? {})]
    if (keys.some((k) => k.startsWith("apcc@"))) return true
  }
  return false
}
if (pluginInstalled() && !uninstall && !flag("--force")) {
  console.error("[install] apcc is installed as a plugin; the script install would double-fire. Use the plugin, or pass --force.")
  process.exit(1)
}
const act = (m, fn) => {
  log((dry ? "(dry-run) would " : "") + m)
  if (!dry) fn()
}

function readSettings() {
  if (!fs.existsSync(settingsFile)) return {}
  const raw = fs.readFileSync(settingsFile, "utf8")
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object")
    return v
  } catch (e) {
    const bak = settingsFile + ".unparseable-" + Date.now()
    log(`settings.json is not valid JSON (${e.message}); backing it up to ${bak} and refusing to overwrite`)
    if (!dry) fs.copyFileSync(settingsFile, bak)
    process.exit(1)
  }
}

// Our files always live at .../hooks/apcc/claude-apcc/apcc.mjs; compare with separators normalised so a
// Windows-written entry is still ours, and a user's own hook in some other checkout is not.
const OURS = `/hooks/apcc/${MARK}/apcc.mjs`
const ours = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => String(h?.command ?? "").replace(/\\/g, "/").includes(OURS))

function refuseOddShape(settings) {
  const odd = (m) => {
    const bak = settingsFile + ".unexpected-shape-" + Date.now()
    log(`settings.json has an unexpected "hooks" shape (${m}); backing it up to ${bak} and refusing to change it`)
    if (!dry) fs.copyFileSync(settingsFile, bak)
    process.exit(1)
  }
  if (settings.hooks === undefined) return
  if (settings.hooks === null || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) odd("hooks is not an object")
  for (const [ev] of EVENTS) {
    const list = settings.hooks[ev]
    if (list === undefined) continue
    if (!Array.isArray(list)) odd(`hooks.${ev} is not an array`)
    for (const e of list) if (e && typeof e === "object" && e.hooks !== undefined && !Array.isArray(e.hooks)) odd(`an entry in hooks.${ev} has a non-array "hooks"`)
  }
}

function strip(settings) {
  for (const [ev] of EVENTS) {
    const list = settings.hooks?.[ev]
    if (!Array.isArray(list)) continue
    const kept = list.filter((e) => !ours(e))
    if (kept.length) settings.hooks[ev] = kept
    else delete settings.hooks[ev]
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
}

const settings = readSettings()
refuseOddShape(settings)
strip(settings)

if (uninstall) {
  log("leaving autoCompactWindow in place (remove it by hand if you want the default back)")
  if (fs.existsSync(settingsFile)) act(`write ${settingsFile} without claude-apcc hooks`, () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n"))
  else log("no settings.json, nothing to unwire")
  act(`remove ${hookDir}`, () => {
    fs.rmSync(hookDir, { recursive: true, force: true })
    for (const d of [path.dirname(hookDir), path.dirname(path.dirname(hookDir))]) if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d)
  })
  if (fs.existsSync(skillFile)) {
    if (hasSkillMarker(fs.readFileSync(skillFile, "utf8"))) act(`remove ${skillDir}`, () => fs.rmSync(skillDir, { recursive: true, force: true }))
    else log(`keeping ${skillFile} (no apcc marker, so it is yours)`)
  }
  log("done")
  process.exit(0)
}

act(`copy hook to ${hookFile}`, () => {
  fs.mkdirSync(hookDir, { recursive: true })
  fs.copyFileSync(src, hookFile)
})

if (fs.existsSync(skillFile) && !hasSkillMarker(fs.readFileSync(skillFile, "utf8"))) {
  log("existing persisting-context skill kept; diff it against skills/persisting-context/SKILL.md")
} else {
  act(`write ${skillFile}`, () => {
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(skillFile, withMarker(fs.readFileSync(skillSrc, "utf8")))
  })
}

// A wrapper that fails LOUD if the hook file vanished: a missing file would otherwise make every
// hook exit 1 with a stack trace, which looks like a broken Claude Code rather than a missing install.
const cmd = (handler) =>
  `node -e "const f=process.argv[1];if(!require('fs').existsSync(f)){process.stderr.write('claude-apcc: hook missing at '+f+' - rerun scripts/install.mjs\\n');process.exit(1)}" "${hookFile}" && node "${hookFile}" ${handler}`

settings.hooks ??= {}
for (const [ev, handler] of EVENTS) {
  settings.hooks[ev] ??= []
  settings.hooks[ev].push({ hooks: [{ type: "command", command: cmd(handler), timeout: 10 }] })
}

if (settings.autoCompactWindow === undefined) {
  settings.autoCompactWindow = window
  log(`setting autoCompactWindow=${window} (without it the host compacts far past any sensible persist point)`)
} else {
  log(`keeping your existing autoCompactWindow=${settings.autoCompactWindow}`)
}

act(`write ${settingsFile}`, () => {
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n")
})

if (!dry) {
  const probe = spawnSync("node", [hookFile, "--version"], { encoding: "utf8" })
  if (probe.status !== 0) {
    console.error("[install] FAILED probe: installed hook does not run:\n" + probe.stderr)
    process.exit(1)
  }
  log(`probe ok: claude-apcc ${probe.stdout.trim()} runs from ${hookFile}`)
}
log("done. Restart Claude Code sessions to pick up the hooks. Run `node scripts/verify.mjs` to exercise them end to end.")
log("Use at your own risk and judgement: provided as is, without warranty; the author is not liable for any loss or damage. See LICENSE.")

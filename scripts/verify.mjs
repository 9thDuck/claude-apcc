#!/usr/bin/env node
// End-to-end verification. Runs the REAL hook as separate processes (stdin JSON in, stdout/stderr/exit
// code out), exactly as Claude Code does, against an isolated HOME / state dir / project. It never reads
// or writes your real settings or state.
//
//   node scripts/verify.mjs [path/to/apcc.mjs]     default: hooks/apcc.mjs in this repo
//   node scripts/verify.mjs --plugin [source/]     also run hooks/hooks.json exactly as the host
//                                                  does: exec form, no shell, plugin path with a
//                                                  space, reached through a symlink
//
// Every check prints PASS/FAIL with the evidence; exit 1 if any FAIL. Set VERIFY_LOG=file to also write the log.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const pluginIdx = argv.indexOf("--plugin")
const pluginMode = pluginIdx !== -1
const pluginRootArg = pluginMode && argv[pluginIdx + 1] && !argv[pluginIdx + 1].startsWith("--") ? path.resolve(argv[pluginIdx + 1]) : null
const hookArg = argv.filter((a, i) => !a.startsWith("--") && !(pluginRootArg && i === pluginIdx + 1))[0]
const hook = path.resolve(hookArg || path.join(here, "..", "hooks", "apcc.mjs"))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "apcc-verify-"))
// Deterministic PATH: a fake `bd` is visible only where the checks put it. The no-bd
// sandbox has an empty directory, so a real bd on the machine cannot change the result.
const bin = path.join(root, "bin")
fs.mkdirSync(bin, { recursive: true })
fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
const noBin = path.join(root, "nobin")
fs.mkdirSync(noBin, { recursive: true })
const logLines = []
let fails = 0
let n = 0

const say = (m) => {
  console.log(m)
  logLines.push(m)
}

function mkProject(name, { beads }) {
  const proj = path.join(root, name)
  fs.mkdirSync(beads ? path.join(proj, ".beads") : path.join(proj, ".opencode", "context"), { recursive: true })
  const transcript = path.join(root, name + ".jsonl")
  return { proj, transcript }
}

const setTokens = (p, tokens) => fs.writeFileSync(p.transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: tokens, output_tokens: 0 } } }) + "\n")

function run(p, event, extra = {}, envExtra = {}) {
  const input = { session_id: "verify-1", transcript_path: p.transcript, cwd: p.proj, ...extra }
  const env = {
    PATH: bin,
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "home", ".claude"),
    CLAUDE_PROJECT_DIR: p.proj,
    APCC_CC_STATE_DIR: path.join(root, "state"),
    APCC_PERSIST_THRESHOLD_TOKENS: "100000",
    ...envExtra,
  }
  const r = spawnSync(process.execPath, [hook, event], { input: JSON.stringify(input), env, encoding: "utf8" })
  let json = null
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null
  } catch {}
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json, text: JSON.stringify(json ?? "") }
}

function check(name, ok, evidence) {
  n++
  if (!ok) fails++
  say(`${ok ? "PASS" : "FAIL"} ${String(n).padStart(2, "0")} ${name}`)
  say(`       evidence: ${String(evidence).slice(0, 300).replace(/\n/g, "\\n")}`)
}

// ---- plugin mode: run the plugin's hooks the way the host does ----
// A plugin install lives under a cache path that is long, can contain a space, and may be reached
// through a symlink. hooks/hooks.json must therefore use the exec form (command + args, no shell),
// and CLAUDE_PLUGIN_ROOT must expand cleanly there. A broken hooks.json (wrong script path) must
// fail this mode rather than pass silently.
function verifyPlugin(srcRoot) {
  say(`claude-apcc verify --plugin  source=${srcRoot}`)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "apcc plugin "))
  try {
    const real = path.join(base, "plugin root")
    fs.mkdirSync(real, { recursive: true })
    for (const d of ["hooks", ".claude-plugin", "skills"]) {
      const from = path.join(srcRoot, d)
      if (!fs.existsSync(from)) {
        check(`plugin: ${d}/ exists in the source`, false, from)
        continue
      }
      fs.cpSync(from, path.join(real, d), { recursive: true })
    }
    const link = path.join(base, "plugin link")
    fs.symlinkSync(real, link, "dir")
    const pluginRoot = link
    check(
      "plugin: CLAUDE_PLUGIN_ROOT contains a space and is reached through a symlink",
      pluginRoot.includes(" ") && fs.lstatSync(pluginRoot).isSymbolicLink() && fs.realpathSync(pluginRoot) === fs.realpathSync(real),
      `root=${pluginRoot} real=${fs.realpathSync(pluginRoot)}`
    )

    // Realistic payloads: a tracked project with a fake `bd` on PATH, and a transcript over threshold.
    const proj = path.join(base, "proj")
    fs.mkdirSync(path.join(proj, ".beads"), { recursive: true })
    const bin = path.join(base, "bin")
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, "bd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const transcript = path.join(base, "t.jsonl")
    fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 120_000, output_tokens: 0 } } }) + "\n")
    const env = {
      // The host spawns `node` from PATH; keep this node's directory plus the fake bd only.
      PATH: path.dirname(process.execPath) + path.delimiter + bin,
      HOME: path.join(base, "home"),
      CLAUDE_CONFIG_DIR: path.join(base, "home", ".claude"),
      CLAUDE_PROJECT_DIR: proj,
      APCC_CC_STATE_DIR: path.join(base, "state"),
      APCC_PERSIST_THRESHOLD_TOKENS: "100000",
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    }

    const cfgFile = path.join(pluginRoot, "hooks", "hooks.json")
    if (!fs.existsSync(cfgFile)) {
      check("plugin: hooks/hooks.json is readable through the plugin path", false, cfgFile)
      return
    }
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"))
    const expand = (s) => String(s).replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
    const payloadFor = (event, i) => {
      const p = { session_id: `plugin-${event}-${i}`, transcript_path: transcript, cwd: proj, hook_event_name: event }
      if (event === "PostToolUse" || event === "PreToolUse") Object.assign(p, { tool_name: "Bash", tool_input: { command: "ls" } })
      if (event === "Stop") p.last_assistant_message = "Saved.\nPERSISTED: 2 units (a, b)"
      if (event === "PreCompact") p.trigger = "auto"
      if (event === "SessionStart") p.source = "compact"
      return p
    }

    let ran = 0
    for (const [event, groups] of Object.entries(cfg.hooks ?? {})) {
      let i = 0
      for (const group of groups) {
        for (const h of group.hooks ?? []) {
          const command = expand(h.command)
          const args = (h.args ?? []).map(expand)
          const handler = args[args.length - 1]
          const r = spawnSync(command, args, { input: JSON.stringify(payloadFor(event, i++)), env, encoding: "utf8" })
          ran++
          // Exit 2 would block tools; a missing script path ("Cannot find module") is a broken install.
          const stderr = String(r.stderr ?? "")
          const ranOk = (r.status === 0 || r.status === 1) && !/Cannot find module|MODULE_NOT_FOUND|ENOENT/.test(stderr)
          check(`plugin: ${event} -> ${handler} runs in the exec form (space + symlink path)`, ranOk, `${command} ${args.join(" ")} exit=${r.status} err=${stderr.trim().slice(0, 160)}`)
          if (!ranOk) continue
          let json = null
          try {
            json = r.stdout.trim() ? JSON.parse(r.stdout) : null
          } catch {}
          if (handler === "nudge") {
            const ctx = json?.hookSpecificOutput?.additionalContext ?? ""
            check(`plugin: ${event} nudge injects the persist directive and names apcc:persisting-context`, /Persist now/.test(ctx) && /^Skill: apcc:persisting-context$/m.test(ctx), ctx.slice(0, 240))
          }
          if (event === "SessionStart") {
            const ctx = json?.hookSpecificOutput?.additionalContext ?? ""
            check(`plugin: ${event} restore injects the recovery contract and names apcc:persisting-context`, /Recovery contract/.test(ctx) && /^Skill: apcc:persisting-context$/m.test(ctx), ctx.slice(0, 240))
          }
        }
      }
    }
    check("plugin: every hooks.json event was exercised", ran >= 6, `ran=${ran}`)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

if (pluginMode) verifyPlugin(pluginRootArg || path.join(here, ".."))

say(`claude-apcc verify  hook=${hook}  sandbox=${root}  node=${process.version}`)
const ver = spawnSync(process.execPath, [hook, "--version"], { encoding: "utf8" })
check("hook runs and reports a version", ver.status === 0 && /^\d+\.\d+\.\d+/.test(ver.stdout), `exit=${ver.status} out=${ver.stdout.trim()} err=${ver.stderr.trim()}`)

// ---- project with beads ----
const b = mkProject("with-beads", { beads: true }) // PATH has the fake bd, as a beads user would
setTokens(b, 40_000)
let r = run(b, "nudge", { hook_event_name: "UserPromptSubmit" })
check("below threshold: silent, exit 0", r.code === 0 && r.out === "", `exit=${r.code} out='${r.out}'`)

setTokens(b, 110_000)
r = run(b, "nudge", { hook_event_name: "UserPromptSubmit" })
check("crossing the threshold injects ONE 'Persist now' directive", r.code === 0 && /Persist now/.test(r.text) && r.json?.hookSpecificOutput?.hookEventName === "UserPromptSubmit", r.text)
check("beads project: nudge tells the model to write a bead note", /bd note/.test(r.text), r.text)

r = run(b, "nudge", { hook_event_name: "PostToolUse" })
check("immediately after, no second nudge (backoff)", r.code === 0 && r.out === "", `out='${r.out}'`)

setTokens(b, 125_000)
// After the first nudge the gate gives a few tool calls to finish the atomic step; spend them.
const pastGrace = (proj, extra = {}, envExtra = {}) => {
  for (let i = 0; i < 2; i++) run(proj, "gate", { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "x" }, ...extra }, envExtra)
}
pastGrace(b)
r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } })
check("gate blocks a work tool once the nudge was ignored near the limit", r.json?.hookSpecificOutput?.permissionDecision === "deny", r.text)
check("beads project: gate deny reason names `bd note`", /bd note \//.test(r.text), r.text)

r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bd show proj-1" } })
check("gate lets read-only `bd show` through (recovery needs it)", r.code === 0 && r.out === "", `out='${r.out}'`)

r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bd show proj-1; rm -rf x" } })
check("gate does NOT let a chained command ride on `bd show`", r.json?.hookSpecificOutput?.permissionDecision === "deny", r.text)

r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf .opencode/context/" } })
check("a destructive command aimed at the persist dir is not a persist write", r.json?.hookSpecificOutput?.permissionDecision === "deny", r.text)

// separate session so the denial counter of the checks above does not release this gate
const s2 = { session_id: "verify-2" }
run(b, "nudge", { hook_event_name: "UserPromptSubmit", ...s2 })
pastGrace(b, s2)
r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bd note proj-1 --stdin && rm -rf /tmp/x" }, ...s2 })
check("a destructive command dressed as `bd note` is denied", r.json?.hookSpecificOutput?.permissionDecision === "deny", r.text)
r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" }, ...s2 })
check("...and the denied command did NOT count as a persist (gate still closed)", r.json?.hookSpecificOutput?.permissionDecision === "deny", r.text)

r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 'bd update proj-1 --notes "x"' } })
check("`bd update --notes` (history overwrite) is denied", r.json?.hookSpecificOutput?.permissionDecision === "deny" && /append/i.test(r.text), r.text)

r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "mcp__chat__post_message", tool_input: { text: "x" } }, { APCC_GATE_ALLOW_TOOLS: "mcp__chat__" })
check("APCC_GATE_ALLOW_TOOLS exempts configured tools from the gate", r.code === 0 && r.out === "", `out='${r.out}'`)

// A bare marker is only a claim: it counts once a write to the notes, the index or a bead was seen.
r = run(b, "stop", { hook_event_name: "Stop", last_assistant_message: "Saved.\nPERSISTED: 3 units (bead note, session-notes, decision)" })
check("a PERSISTED claim with no write behind it does not release the gate", !/3 unit/.test(r.text), r.text)
r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } })
check("...and the gate still denies after the bare claim, saying the line was not backed", r.json?.hookSpecificOutput?.permissionDecision === "deny" && /not backed|no write/i.test(r.text), r.text)
r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(b.proj, ".opencode", "context", "session-notes.md") } })
check("a write under the persist dir is allowed while gated", r.code === 0 && r.out === "", `out='${r.out}'`)
r = run(b, "stop", { hook_event_name: "Stop", last_assistant_message: "Saved.\nPERSISTED: 3 units (bead note, session-notes, decision)" })
check("end-anchored PERSISTED marker is recorded once a persist write was seen", r.code === 0 && /3 unit/.test(r.text), r.text)

r = run(b, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } })
check("after persisting, the gate opens again", r.code === 0 && r.out === "", `out='${r.out}'`)

r = run(b, "stop", { hook_event_name: "Stop", last_assistant_message: "I will write PERSISTED: 9 units soon, but not yet." })
check("a PERSISTED mention that is not the end of the reply is ignored", !/9 unit/.test(r.text), r.text)

// ---- compaction + recovery ----
const transcriptWithUser = JSON.stringify({ type: "user", message: { role: "user", content: "Never touch the billing module. Budget limit is $20." } }) + "\n"
fs.appendFileSync(b.transcript, transcriptWithUser)
r = run(b, "precompact", { hook_event_name: "PreCompact", trigger: "auto" })
check("PreCompact never blocks compaction (exit 0, no deny)", r.code === 0 && !/"decision"\s*:\s*"block"/.test(r.out), `exit=${r.code} out=${r.out.slice(0, 200)}`)
const uw = path.join(b.proj, ".opencode", "context")
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)) : [])
const wordsFile = [...walk(uw), ...walk(path.join(root, "state"))].find((f) => /user-words-/.test(f))
check("PreCompact saved the user's words verbatim to a file", !!wordsFile && /billing module/.test(fs.readFileSync(wordsFile, "utf8")), wordsFile || "no user-words-* file found")

r = run(b, "restore", { hook_event_name: "SessionStart", source: "compact" })
check("restore after compact injects the recovery contract", /Recovery contract/i.test(r.text), r.text)
check("recovery points the model at the user's saved words", /billing module|user-words|verbatim/i.test(r.text), r.text)
check("beads project: recovery says to re-read beads", /bd show/.test(r.text), r.text)

// ---- project without beads ----
const nb = mkProject("no-beads", { beads: false })
setTokens(nb, 110_000)
r = run(nb, "nudge", { hook_event_name: "UserPromptSubmit" })
check("no-beads project: still nudges", /Persist now/.test(r.text), r.text)
check("no-beads project: nudge never mentions `bd` commands", !/\bbd (note|create|show)/.test(r.text), r.text)
r = run(nb, "restore", { hook_event_name: "SessionStart", source: "compact" })
check("no-beads project: recovery never tells the model to run `bd`", /Recovery contract/i.test(r.text) && !/\bbd (note|create|show)/.test(r.text), r.text)

// ---- .beads present but bd not on PATH: route to .opencode/context, never to bd ----
const nbd = mkProject("beads-without-bd", { beads: true })
const noBd = { PATH: noBin }
setTokens(nbd, 110_000)
r = run(nbd, "nudge", { hook_event_name: "UserPromptSubmit" }, noBd)
check(".beads without bd: nudge says bd is not on PATH and routes to .opencode/context", /`\.beads\/` found but `bd` is not on PATH, using \.opencode\/context instead/.test(r.text), r.text)
check(".beads without bd: nudge never mentions `bd note`", !/\bbd note/.test(r.text), r.text)
setTokens(nbd, 125_000)
pastGrace(nbd, {}, noBd)
r = run(nbd, "gate", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } }, noBd)
check(".beads without bd: gate denies work and its reason has no `bd note`", r.json?.hookSpecificOutput?.permissionDecision === "deny" && !/\bbd note/.test(r.text), r.text)
r = run(nbd, "restore", { hook_event_name: "SessionStart", source: "startup", session_id: "verify-nbd" }, noBd)
check(".beads without bd: startup message tells the user bd is not on PATH", /not on PATH/.test(r.text), r.text)
r = run(nbd, "restore", { hook_event_name: "SessionStart", source: "startup", session_id: "verify-nbd" }, noBd)
check(".beads without bd: the startup message is once per session", r.code === 0 && r.out === "", `out='${r.out}'`)

// ---- scope + safety ----
const un = path.join(root, "plain")
fs.mkdirSync(un, { recursive: true })
const up = { proj: un, transcript: path.join(root, "plain.jsonl") }
setTokens(up, 150_000)
r = run(up, "nudge", { hook_event_name: "UserPromptSubmit" })
check("untracked project: no nudge even past the threshold", r.code === 0 && r.out === "", `out='${r.out}'`)
r = run(up, "restore", { hook_event_name: "SessionStart", source: "startup", session_id: "verify-untracked" })
check("untracked project: startup hint says how to switch apcc on", /mkdir -p \.opencode\/context/.test(r.text), r.text)
check("untracked project: nothing written into the project", !fs.existsSync(path.join(un, ".opencode")), "")

setTokens(b, 190_000)
const sub = run(b, "nudge", { hook_event_name: "PostToolUse", agent_id: "sub-1" })
check("subagent calls are ignored", sub.code === 0 && sub.out === "", `out='${sub.out}'`)

r = run(nb, "nudge", { hook_event_name: "UserPromptSubmit" }, { APCC_CC: "0" })
check("kill switch APCC_CC=0 silences everything", r.code === 0 && r.out === "", `out='${r.out}'`)

// corrupt state must fail loud (stderr) but never block (exit 0 or 1, never 2)
const stateDir = path.join(root, "state")
for (const f of walk(stateDir)) if (f.endsWith(".json")) fs.writeFileSync(f, "{not json")
setTokens(nb, 120_000)
r = run(nb, "nudge", { hook_event_name: "UserPromptSubmit" })
check("corrupt state file: hook survives and never exits 2 (which would block tools)", r.code !== 2, `exit=${r.code} err=${r.err.slice(0, 160)}`)

const bad = spawnSync(process.execPath, [hook, "nudge"], { input: "{{{ not json", env: { PATH: bin, HOME: root }, encoding: "utf8" })
check("garbage stdin: loud on stderr, exit 1 (non-blocking), not 2", bad.status === 1 && bad.stderr.length > 0, `exit=${bad.status} err=${bad.stderr.slice(0, 120)}`)

say(`\n${n - fails}/${n} checks passed${fails ? `, ${fails} FAILED` : ""}`)
if (process.env.VERIFY_LOG) fs.writeFileSync(process.env.VERIFY_LOG, logLines.join("\n") + "\n")
fs.rmSync(root, { recursive: true, force: true })
process.exit(fails ? 1 : 0)

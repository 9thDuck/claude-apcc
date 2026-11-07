// The plugin manifests and the auto-loaded hooks file must agree with the runtime's
// EVENTS table: one event, one handler, exec form so paths with spaces still work.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url)))

test("hooks.json matches EVENTS one to one and uses the exec form", async () => {
  const cfg = read("hooks/hooks.json")
  const { EVENTS } = await import("./apcc.mjs")
  assert.ok(Array.isArray(EVENTS), "apcc.mjs exports EVENTS")
  assert.equal(cfg.description, "apcc: persist -> gate -> restore (the host compacts)")
  assert.deepEqual(Object.keys(cfg.hooks).sort(), EVENTS.map(([e]) => e).sort())
  for (const [event, handler] of EVENTS) {
    const entries = cfg.hooks[event]
    assert.equal(entries.length, 1, `${event} has one entry`)
    const h = entries[0].hooks[0]
    assert.equal(h.type, "command")
    assert.equal(h.command, "node")
    assert.deepEqual(h.args, ["${CLAUDE_PLUGIN_ROOT}/hooks/apcc.mjs", handler])
    assert.equal(h.timeout, 10)
  }
  assert.ok(fs.existsSync(new URL("../hooks/apcc.mjs", import.meta.url)), "the hook runtime the manifest points at exists")
})

test("plugin and marketplace manifests name the plugin apcc", () => {
  const plugin = read(".claude-plugin/plugin.json")
  assert.equal(plugin.name, "apcc")
  assert.ok(!plugin.name.startsWith("claude-"), "plugin name must not be Anthropic-reserved")
  assert.equal(plugin.version, read("package.json").version)

  const market = read(".claude-plugin/marketplace.json")
  assert.equal(market.name, "apcc")
  assert.equal(market.plugins.length, 1)
  assert.equal(market.plugins[0].name, "apcc")
  assert.equal(market.plugins[0].source, "./")
  assert.equal(market.plugins[0].version, undefined, "the manifest version wins; do not pin it twice")
})

import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import { isolatedEnvironment } from "./fixtures/auto-debate-runtime.ts"
import * as fixture from "./fixtures/auto-debate-runtime.ts"

const root = "/tmp/opencode/auto-debate-fixture-unit"
const paths = {
  home: join(root, "home"),
  xdgConfig: join(root, "xdg-config"),
  xdgData: join(root, "xdg-data"),
  xdgCache: join(root, "xdg-cache"),
  xdgState: join(root, "xdg-state"),
  temporary: join(root, "tmp"),
  events: join(root, "native-events.jsonl"),
}

test("native fixture excludes managed and ancestor config and confines dependency caches", () => {
  const environment = isolatedEnvironment(paths)
  assert.equal(environment.OPENCODE_TEST_MANAGED_CONFIG_DIR, join(root, "managed-config"))
  assert.equal(environment.OPENCODE_TEST_HOME, paths.home)
  assert.equal(environment.OPENCODE_DISABLE_PROJECT_CONFIG, "1")
  assert.equal(environment.OPENCODE_CONFIG, join(root, "project", "opencode.json"))
  assert.equal(environment.OPENCODE_CONFIG_DIR, join(root, "project", ".opencode"))
  assert.equal(environment.npm_config_cache, join(paths.xdgCache, "npm"))
  assert.equal(environment.npm_config_userconfig, join(paths.home, ".npmrc"))
  assert.equal(environment.npm_config_globalconfig, join(paths.home, "npm-globalrc"))
  assert.equal(environment.npm_config_logs_dir, join(paths.xdgCache, "npm-logs"))
  assert.equal(environment.npm_config_prefix, join(paths.home, "npm-prefix"))
  assert.equal(environment.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1")
  assert.equal(environment.OPENCODE_DISABLE_MODELS_FETCH, "1")
  assert.equal(environment.OPENAI_API_KEY, undefined)
  assert.equal(environment.OPENCODE_CONFIG_CONTENT, undefined)
})

test("native fixture refuses a home or cache outside its disposable workspace", () => {
  assert.throws(() => isolatedEnvironment({ ...paths, home: "/home/shared" }), /isolat|disposable/i)
  assert.throws(() => isolatedEnvironment({ ...paths, xdgCache: "/tmp/shared-cache" }), /isolat|disposable/i)
  assert.throws(() => isolatedEnvironment({ ...paths, events: "/tmp/shared/native-events.jsonl" }), /isolat|disposable/i)
})

test("overlap observation waits for dispatch readiness and uses one shared status snapshot", async () => {
  let readyReads = 0
  let statusReads = 0
  const result = await fixture.observeBusyTogether(["one", "two", "three"], async () => ++readyReads >= 3,
    async () => {
      statusReads++
      assert.ok(readyReads >= 3)
      return { one: { type: "busy" }, two: { type: "busy" }, three: { type: "busy" } }
    }, 1000)
  assert.equal(result, true)
  assert.equal(statusReads, 1)
})

test("barrier guards expose a native participant failure instead of waiting for a missing final barrier", () => {
  assert.throws(() => fixture.assertPendingNativePrompts([
    { type: "runtime-probe-child-settled", sessionID: "one", ok: false, errorMessage: "prompt rejected", time: 1 },
  ], ["one"]), /prompt rejected/)
  assert.doesNotThrow(() => fixture.assertPendingNativePrompts([
    { type: "runtime-probe-child-settled", sessionID: "unrelated", ok: false, time: 1 },
  ], ["one"]))
})

test("cancellation classification ignores fake-provider completions but detects a native restart", () => {
  const quiet = { events: [], requests: [], messages: [], confirmed: { child: 10 },
    finalResponses: [{ marker: "cancel-busy", time: 11 }] }
  assert.equal(fixture.nativeCancellationEffects(quiet), false)
  assert.equal(fixture.nativeCancellationEffects({ ...quiet, events: [
    { type: "session.status", sessionID: "child", status: "busy", time: 11 },
  ] }), true)
  assert.equal(fixture.nativeCancellationEffects({ ...quiet, requests: [
    { sessionID: "child", time: 11 },
  ] }), true)
})

test("cancellation effects are compared with each child's own abort confirmation", () => {
  assert.equal(fixture.nativeCancellationEffects({ confirmed: { early: 10, later: 20 }, requests: [], messages: [],
    events: [{ type: "tool.execute.after", sessionID: "later", time: 15 }] }), false)
})

test("same-millisecond native effects cannot establish safe post-cancellation quiescence", () => {
  const quiet = { events: [], requests: [], messages: [], confirmed: { child: 100 } }
  assert.equal(fixture.nativeCancellationEffects({ ...quiet, events: [
    { type: "session.status", sessionID: "child", status: "busy", time: 100 },
  ] }), true)
  assert.equal(fixture.nativeCancellationEffects({ ...quiet, events: [
    { type: "tool.execute.after", sessionID: "child", time: 100 },
  ] }), true)
  assert.equal(fixture.nativeCancellationEffects({ ...quiet, requests: [
    { sessionID: "child", time: 100 },
  ] }), true)
  assert.equal(fixture.nativeCancellationEffects({ ...quiet, messages: [
    { sessionID: "child", time: 100, final: true },
  ] }), true)
})

test("strictly earlier native effects do not trigger a post-confirmation failure", () => {
  assert.equal(fixture.nativeCancellationEffects({ confirmed: { child: 100 },
    events: [{ type: "session.status", sessionID: "child", status: "busy", time: 99 }],
    requests: [{ sessionID: "child", time: 99 }],
    messages: [{ sessionID: "child", time: 99, final: true }],
  }), false)
})

test("parent-return evidence cannot pass without a completed native launch tool", () => {
  const panels = ["one", "two", "three"]
  assert.equal(fixture.nativeParentReturnedBeforeChildren([], [], panels, "parent"), false)
  const messages = [{ parts: [{ type: "tool", tool: "auto_debate_probe_launch", state: { status: "completed" } }] }]
  const events = [{ type: "tool.execute.after", tool: "auto_debate_probe_launch", sessionID: "parent", time: 1 }]
  assert.equal(fixture.nativeParentReturnedBeforeChildren(messages, events, panels, "parent"), true)
  assert.equal(fixture.nativeParentReturnedBeforeChildren(messages, [...events,
    { type: "runtime-probe-child-settled", sessionID: "one", time: 0 }], panels, "parent"), false)
})

test("native startup barriers recognise direct probes but never markers quoted inside checkpoint data", () => {
  assert.equal(fixture.nativeStartupKind("AUTO_DEBATE_RECONCILIATION_DELIVERY: result"), "delivery")
  assert.equal(fixture.nativeStartupKind("AUTO_DEBATE_RECONCILIATION_PENDING: startup"), "recovery")
  assert.equal(fixture.nativeStartupKind("AUTO_DEBATE_CANCEL_PENDING: original race"), "adapter")
  assert.equal(fixture.nativeStartupKind("AUTO_DEBATE_RAW_NATIVE_START: original counterexample"), "raw")
  assert.equal(fixture.nativeStartupKind('opencode-debate/checkpoint/v1\n{"text":"AUTO_DEBATE_RECONCILIATION_DELIVERY"}'), undefined)
  assert.equal(fixture.nativeStartupKind("Quoted peer data: AUTO_DEBATE_CANCEL_PENDING"), undefined)
})

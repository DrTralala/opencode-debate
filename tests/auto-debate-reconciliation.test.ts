import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { createRuntime } from "../src/auto-debate/opencode.ts"
import type { ConversationState, Discussion } from "../src/auto-debate/types.ts"
import { checkpointClient } from "./fixtures/checkpoint-client.ts"

type RecordValue = Record<string, unknown>
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
function discussion(f: ReturnType<typeof checkpointClient>): Discussion {
  return { id: "discussion", owner: f.owner, config: { enabled: false, maxRounds: 3, persistTranscripts: false },
    brief: { question: "Question?", objective: "Decision", facts: [], assumptions: [], constraints: [], alternatives: [],
      uncertainty: "unknown", neededOutcome: "Decision" }, panel: [], status: "running", generation: 0, cycle: 1,
    results: [], evaluations: [], pendingTurns: [], followups: [] }
}
async function setup(delivery = false) {
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  const d = discussion(f)
  const state: ConversationState = { version: 1, override: false, discussions: [d], outbox: [] }
  if (delivery) {
    d.status = "awaiting-evaluation"
    d.results.push({ cycle: 1, rounds: 2, status: "complete", reason: "unanimous-stop", turns: [], failures: [], consensus: true })
    state.outbox.push(...["one", "two"].map((id) => ({ id, discussionID: d.id, cycle: 1, state: "pending" as const })))
  }
  await runtime.load(f.owner)
  await runtime.save(f.owner, state)
  return { ...f, runtime, state, d }
}
async function panel(f: Awaited<ReturnType<typeof setup>>) {
  for (let index = 0; index < 3; index++) f.d.panel.push(await f.runtime.createParticipant(f.owner,
    { agent: `member-${index}`, description: "neutral", model: "fake/fake-model" }, []))
  await f.runtime.save(f.owner, f.state)
}
function records(f: ReturnType<typeof checkpointClient>) {
  const store = [...f.sessions.values()].find((value) => (value.metadata as RecordValue | undefined)?.["opencode-debate-checkpoint-store"])
  return f.histories.get(String(store!.id))!
}
function payload(message: RecordValue) {
  const text = (message.parts as RecordValue[])[0].text as string
  return JSON.parse(JSON.parse(text.slice(text.indexOf("\n") + 1)).payload) as RecordValue
}
function rewrite(message: RecordValue, change: (value: RecordValue) => void) {
  const part = (message.parts as RecordValue[])[0]
  const value = payload(message)
  change(value)
  const text = JSON.stringify(value)
  part.text = "opencode-debate/checkpoint/v1\n" + JSON.stringify({ payload: text,
    digest: createHash("sha256").update(text).digest("hex") })
}
const batch = { id: "batch", outboxIDs: ["one", "two"], text: "Results discussion cycle 1" }

test("lost owner delivery response reconciles exact content and survives restart without another send", async () => {
  const f = await setup(true)
  const send = f.session.promptAsync
  f.session.promptAsync = async (request) => { await send(request); throw new Error("lost response") }
  const result = await f.runtime.deliver(f.owner, batch)
  assert.equal(result.state, "persisted")
  const recovered = createRuntime(f.input)
  await recovered.load(f.owner)
  assert.deepEqual(await recovered.reconcileDeliveries(f.owner), [result])
  assert.deepEqual(await recovered.deliver(f.owner, batch), result)
  assert.equal(f.calls.filter((call) => call.method === "promptAsync").length, 1)
  assert.equal(f.calls.filter((call) => call.method === "abort").length, 0)
  const native = f.histories.get(f.owner.sessionID)!
  assert.equal(native.length, 1)
  assert.equal((native[0].parts as RecordValue[])[0].text, batch.text)
})

test("an invisible async fork remains uncertain across restart and duplicate batches cannot redispatch", async () => {
  const f = await setup(true)
  const send = f.session.promptAsync
  let request: Parameters<typeof send>[0] | undefined
  let sends = 0
  f.session.promptAsync = async (value) => { sends++; request = value; throw new Error("accepted but response lost") }
  const result = await f.runtime.deliver(f.owner, batch)
  assert.equal(result.state, "uncertain")
  const recovered = createRuntime(f.input)
  await recovered.load(f.owner)
  assert.equal((await recovered.reconcileDeliveries(f.owner))[0].state, "uncertain")
  assert.equal((await recovered.deliver(f.owner, batch)).state, "uncertain")
  await assert.rejects(recovered.deliver(f.owner, { ...batch, text: "different" }), /identity|immutable|different|conflict/i)
  await assert.rejects(recovered.deliver(f.owner, { ...batch, id: "other-batch" }), /reserved|batch|conflict/i)
  assert.equal(sends, 1)
  await send(request!) // Original remote fork eventually persists; no new adapter submission.
  assert.equal((await recovered.reconcileDeliveries(f.owner))[0].state, "persisted")
  assert.equal(sends, 1)
})

test("busy owner preserves intent-only proof and a busy race produces a durable no-call seal", async () => {
  const f = await setup(true)
  f.statuses[f.owner.sessionID] = { type: "busy" }
  const intent = await f.runtime.deliver(f.owner, batch)
  assert.equal(intent.state, "not-dispatched")
  assert.equal(intent.state === "not-dispatched" && intent.proof, "intent-only")
  const recovered = createRuntime(f.input)
  await recovered.load(f.owner)
  assert.deepEqual(await recovered.reconcileDeliveries(f.owner), [intent])
  delete f.statuses[f.owner.sessionID]
  const status = f.session.status
  let reads = 0
  f.session.status = async () => {
    // Store status uses the same endpoint; trigger only after an armed receipt is visible.
    const entries = (payload(records(f).at(-1)!).runtimeProof as { entries: RecordValue[] }).entries
    if (entries.some((entry) => entry.kind === "delivery-dispatch-open") && ++reads === 1) f.statuses[f.owner.sessionID] = { type: "busy" }
    return status()
  }
  const sealed = await recovered.deliver(f.owner, batch)
  assert.equal(sealed.state, "not-dispatched")
  assert.equal(sealed.state === "not-dispatched" && sealed.proof, "sealed-before-call")
  assert.equal(f.calls.some((call) => call.method === "promptAsync"), false)
})

test("proof-backed paused panel explicitly continues on the same sessions while automatic mode is off", async () => {
  const f = await setup()
  await panel(f)
  for (let round = 1; round <= 2; round++) await Promise.all(f.d.panel.map((member) => f.runtime.prompt(member, `round ${round}`)))
  f.d.status = "paused"
  f.d.results.push({ cycle: 1, rounds: 2, status: "complete", reason: "unanimous-stop", turns: [], failures: [], consensus: true })
  f.d.evaluations.push({ cycle: 1, conclusion: "Continue", caveats: [], rationale: "New context", next: "continue" })
  await f.runtime.save(f.owner, f.state)
  const recovered = createRuntime(f.input)
  const state = (await recovered.load(f.owner))!
  const ids = state.discussions[0].panel.map((member) => member.sessionID)
  const before = f.modelCalls()
  for (const member of state.discussions[0].panel) assert.deepEqual(await recovered.reconcileParticipant(f.owner, member),
    { sessionID: member.sessionID, state: "exhausted", canContinue: true })
  assert.equal(f.modelCalls(), before)
  await assert.rejects(recovered.prompt(state.discussions[0].panel[0], "not explicitly resumed"), /paused|resume|continu/i)
  state.discussions[0].status = "running"
  state.discussions[0].cycle = 2
  state.discussions[0].followups.push({ cycle: 2, feedback: "changed context" })
  await recovered.save(f.owner, state)
  await Promise.all(state.discussions[0].panel.map((member) => recovered.prompt(member, "dependent feedback: changed context")))
  assert.deepEqual(state.discussions[0].panel.map((member) => member.sessionID), ids)
  assert.equal(f.calls.filter((call) => call.method === "create").length, 4) // one store and original panel only
  assert.equal(f.modelCalls(), before + 3)
})

test("lost participant startup cannot be adopted from idle, final-looking history or abort acknowledgement", async () => {
  const f = await setup()
  await panel(f)
  const member = f.d.panel[0]
  const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    if (request.path.id === member.sessionID) throw new Error("lost startup transport")
    return prompt(request)
  }
  await assert.rejects(f.runtime.prompt(member, "unknown start"), /lost startup/)
  f.session.prompt = prompt
  f.d.status = "interrupted"
  f.d.cancellation = { pendingSessionIDs: [member.sessionID], errors: ["startup unconfirmed"] }
  await f.runtime.save(f.owner, f.state)
  const recovered = createRuntime(f.input)
  await recovered.load(f.owner)
  const inspected = await recovered.reconcileParticipant(f.owner, member)
  assert.ok(inspected.state === "uncertain" || (inspected.state === "fenced" && inspected.cessation === "unconfirmed"))
  await assert.rejects(recovered.abort(member), /unconfirmed|uncertain/i)
  assert.equal(f.calls.filter((call) => call.method === "abort" && call.id === member.sessionID).length, 1)
  await assert.rejects(recovered.prompt(member, "must never resume"), /stopp|uncertain|provenance|fenc/i)
  assert.deepEqual((await recovered.load(f.owner))!.discussions[0].cancellation, f.d.cancellation)
})

test("manager snapshots serialize with runtime closure receipts without dropping proof or changing owner history", async () => {
  const f = await setup()
  await panel(f)
  const entered = gate(); const release = gate()
  const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    if (request.path.id === f.d.panel[0].sessionID) { entered.release(); await release.promise }
    return prompt(request)
  }
  const result = f.runtime.prompt(f.d.panel[0], "held turn")
  await entered.promise
  await f.runtime.save(f.owner, { ...f.state, override: true })
  release.release()
  await result
  await f.runtime.save(f.owner, { ...f.state, override: false })
  const messages = records(f)
  const entries = messages.map((message) => (payload(message).runtimeProof as { entries: RecordValue[] }).entries)
  assert.ok(entries.at(-1)!.some((entry) => entry.kind === "participant-start-closed"))
  for (let index = 1; index < entries.length; index++) assert.deepEqual(entries[index].slice(0, entries[index - 1].length), entries[index - 1])
  assert.deepEqual(f.histories.get(f.owner.sessionID) ?? [], [])
  assert.deepEqual(f.sessions.get(f.owner.sessionID)!.metadata, { unrelated: { retained: true } })
  assert.equal((await createRuntime(f.input).load(f.owner))!.override, false)
})

test("checksum-valid removal or forgery of a receipt prefix fails recovery rather than adopting a safe-looking snapshot", async () => {
  for (const damage of ["remove", "forge-close"]) {
    const f = await setup()
    await panel(f)
    await f.runtime.prompt(f.d.panel[0], "completed")
    await f.runtime.save(f.owner, f.state)
    rewrite(records(f).at(-1)!, (value) => {
      const proof = value.runtimeProof as { entries: RecordValue[] }
      if (damage === "remove") proof.entries = []
      else proof.entries.push({ kind: "participant-start-closed", sessionID: f.d.panel[0].sessionID,
        messageID: "msg_unowned", startup: "synchronous-response", outcome: "answer", assistantID: "msg_fake" })
    })
    const recovered = createRuntime(f.input)
    await assert.rejects(recovered.load(f.owner), /receipt|proof|prefix|start|journal/i)
    await assert.rejects(recovered.save(f.owner, f.state), /unconfirmed|receipt|proof|journal|checkpoint/i)
  }
})

test("duplicate reconciliation observations cannot append two persistence receipts or quarantine the owner", async () => {
  const f = await setup(true)
  const send = f.session.promptAsync
  let request: Parameters<typeof send>[0] | undefined
  f.session.promptAsync = async (value) => { request = value; throw new Error("lost") }
  await f.runtime.deliver(f.owner, batch)
  await send(request!)
  const message = f.session.message
  const both = gate(); let arrived = 0
  f.session.message = async (value) => {
    const result = await message(value)
    if (++arrived === 2) both.release()
    await both.promise
    return result
  }
  const results = await Promise.all([f.runtime.reconcileDeliveries(f.owner), f.runtime.reconcileDeliveries(f.owner)])
  assert.ok(results.every((observations) => observations[0].state === "persisted"))
  assert.equal(((payload(records(f).at(-1)!).runtimeProof as { entries: RecordValue[] }).entries)
    .filter((entry) => entry.kind === "delivery-persisted").length, 1)
  await f.runtime.save(f.owner, f.state)
})

test("delivery coalescing cannot bypass owner directory validation", async () => {
  const f = await setup(true)
  const entered = gate(); const release = gate(); const send = f.session.promptAsync
  f.session.promptAsync = async (request) => { entered.release(); await release.promise; return send(request) }
  const delivery = f.runtime.deliver(f.owner, batch)
  await entered.promise
  const foreign = f.runtime.deliver({ ...f.owner, directory: "/foreign" }, batch)
  const rejection = assert.rejects(foreign, /directory|owner|immutable|reserved/i)
  release.release()
  await Promise.all([delivery, rejection])
})

test("optional manager delivery uncertainty survives checkpoint validation and restart", async () => {
  const f = await setup()
  f.d.deliveryUncertainCycles = [{ cycle: 1, reason: "Native result lookup remains uncertain" }]
  await f.runtime.save(f.owner, f.state)

  const recovered = createRuntime(f.input)
  const state = await recovered.load(f.owner)
  assert.deepEqual(state?.discussions[0].deliveryUncertainCycles, f.d.deliveryUncertainCycles)
})

test("stop during receipt persistence confirms a definitely never invoked participant starter and stays fenced after restart", async () => {
  const f = await setup()
  await panel(f)
  const member = f.d.panel[0]
  const entered = gate(); const release = gate(); const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    const result = await prompt(request)
    if (request.body.noReply === true) {
      const entries = (payload(result.data).runtimeProof as { entries: RecordValue[] }).entries
      if (entries.at(-1)?.kind === "participant-start-open") { entered.release(); await release.promise }
    }
    return result
  }
  const result = f.runtime.prompt(member, "never dispatch")
  const rejected = assert.rejects(result, /stopp|cancel/i)
  await entered.promise
  const stopped = f.runtime.abort(member)
  release.release()
  await Promise.all([rejected, stopped])
  assert.equal(f.calls.some((call) => call.method === "prompt" && call.id === member.sessionID), false)
  const restored = createRuntime(f.input)
  await restored.load(f.owner)
  assert.deepEqual(await restored.reconcileParticipant(f.owner, member), { sessionID: member.sessionID, state: "fenced", cessation: "confirmed" })
  await assert.rejects(restored.prompt(member, "must stay fenced"), /stopp|cancel/i)
})

test("completion without a durably acknowledged close cannot authorise paused recovery", async () => {
  const f = await setup()
  await panel(f)
  const prompt = f.session.prompt
  f.session.prompt = async (request) => {
    if (request.body.noReply === true) {
      const part = (request.body.parts as RecordValue[])[0]
      const wrapper = JSON.parse((part.text as string).split("\n")[1])
      const entries = JSON.parse(wrapper.payload).runtimeProof.entries
      if (entries.at(-1)?.kind === "participant-start-closed") throw new Error("terminal receipt lost before append")
    }
    return prompt(request)
  }
  await assert.rejects(f.runtime.prompt(f.d.panel[0], "completed remotely"), /terminal receipt lost/)
  f.session.prompt = prompt
  const restored = createRuntime(f.input)
  await restored.load(f.owner)
  assert.equal((await restored.reconcileParticipant(f.owner, f.d.panel[0])).state, "uncertain")
  await assert.rejects(restored.prompt(f.d.panel[0], "final history is not starter proof"), /stopp|provenance|uncertain/i)
})

test("reconciliation fails closed when a previously loaded checkpoint chain acquires a corrupt proof tail", async () => {
  const f = await setup(true)
  await f.runtime.deliver(f.owner, batch)
  rewrite(records(f).at(-1)!, (value) => { (value.runtimeProof as { entries: unknown[] }).entries = [] })
  await assert.rejects(f.runtime.reconcileDeliveries(f.owner), /proof|prefix|receipt|checkpoint/i)
  assert.equal(f.calls.filter((call) => call.method === "promptAsync").length, 1)
})

test("pre-protocol outbox ambiguity cannot be promoted to intent-only by an ordinary manager save", async () => {
  const f = await setup(true)
  rewrite(records(f)[0], (value) => { delete value.runtimeProof })
  const upgraded = createRuntime(f.input)
  await upgraded.load(f.owner)
  await upgraded.save(f.owner, f.state)
  const restored = createRuntime(f.input)
  await restored.load(f.owner)
  await assert.rejects(restored.deliver(f.owner, batch), /legacy|provenance|unknown/i)
  assert.equal(f.calls.some((call) => call.method === "promptAsync"), false)
})

test("a checksum-valid widened native participant permission list never authorises restored continuation", async () => {
  const f = await setup()
  await panel(f)
  for (const member of f.d.panel) await f.runtime.prompt(member, "completed turn")
  f.d.status = "paused"
  f.d.results.push({ cycle: 1, rounds: 2, status: "complete", reason: "unanimous-stop", turns: [], failures: [], consensus: false })
  f.d.evaluations.push({ cycle: 1, conclusion: "continue", caveats: [], rationale: "feedback", next: "continue" })
  await f.runtime.save(f.owner, f.state)
  const member = f.d.panel[0]
  f.sessions.get(member.sessionID)!.permission = [{ permission: "*", pattern: "*", action: "allow" }]
  const restored = createRuntime(f.input)
  await restored.load(f.owner)
  const observation = await restored.reconcileParticipant(f.owner, member)
  assert.equal(observation.state, "uncertain")
  await assert.rejects(restored.prompt(member, "must not widen permissions"), /stopp|uncertain|provenance/i)
})

test("changing the root primary agent cannot transfer another agent's checkpoint and restoration authority", async () => {
  const f = await setup()
  await panel(f)
  f.sessions.get(f.owner.sessionID)!.agent = "plan"
  const client = f.input.client as unknown as { app: { agents: () => Promise<unknown> } }
  client.app.agents = async () => ({ data: ["build", "plan"].map((name) => ({ name, mode: "primary", permission: [] })) })
  const restored = createRuntime(f.input)
  await assert.rejects(restored.load({ ...f.owner, agent: "plan" }), /owner|agent|binding/i)
})

test("failed recovery cannot downgrade a managed participant to retained-only dispatch or silently skip containment", async () => {
  const f = await setup()
  await panel(f)
  const member = f.d.panel[0]
  ;(records(f).at(-1)!.parts as RecordValue[])[0].text = "opencode-debate/checkpoint/v1\nbroken"
  await assert.rejects(f.runtime.load(f.owner), /corrupt|checkpoint/i)
  const before = f.modelCalls()
  await assert.rejects(f.runtime.prompt(member, "no unmanaged fallback"), /proof|provenance|checkpoint/i)
  assert.equal(f.modelCalls(), before)
  await assert.rejects(f.runtime.abort(member), /unconfirmed|proof|provenance/i)
  assert.equal(f.calls.filter((call) => call.method === "abort" && call.id === member.sessionID).length, 1)
})

for (const scenario of [
  { name: "rejected single-member origin append", count: 1, failure: "append" },
  { name: "rejected three-member origin append", count: 3, failure: "append" },
  { name: "ambiguous three-member origin append", count: 3, failure: "lost-response" },
  { name: "partial three-member binding validation", count: 3, failure: "lookup" },
]) {
  test(`${scenario.name} keeps every enrolled member out of retained-only dispatch`, async () => {
    const f = await setup()
    for (let index = 0; index < scenario.count; index++) f.d.panel.push(await f.runtime.createParticipant(f.owner,
      { agent: `binding-${index}`, description: "managed candidate", model: "fake/fake-model" }, []))
    const unenrolled = await f.runtime.createParticipant(f.owner,
      { agent: "unenrolled", description: "retained-only control", model: "fake/fake-model" }, [])
    const prompt = f.session.prompt
    const get = f.session.get
    f.session.prompt = async (request) => {
      if (request.body.noReply === true) {
        const text = ((request.body.parts as RecordValue[])[0].text as string)
        const entries = JSON.parse(JSON.parse(text.slice(text.indexOf("\n") + 1)).payload).runtimeProof.entries as RecordValue[]
        if (entries.some((entry) => entry.kind === "member-bound")) {
          if (scenario.failure === "lost-response") await prompt(request)
          if (scenario.failure !== "lookup") throw new Error("origin append unconfirmed")
        }
      }
      return prompt(request)
    }
    if (scenario.failure === "lookup") f.session.get = async (request) => {
      if (request.path.id === f.d.panel[1].sessionID) throw new Error("member binding lookup failed")
      return get(request)
    }
    await assert.rejects(f.runtime.save(f.owner, f.state), /origin append unconfirmed|member binding lookup failed/)
    f.session.prompt = prompt
    f.session.get = get
    const before = f.modelCalls()
    const outcomes = await Promise.all(f.d.panel.map((member) => f.runtime.prompt(member, "must not dispatch after failed binding")
      .then(() => "accepted", (error: unknown) => error instanceof Error ? error.message : "unknown rejection")))
    assert.equal(f.modelCalls(), before, "failed binding must not invoke any enrolled participant model")
    assert.ok(outcomes.every((outcome) => /proof|provenance|binding/i.test(outcome)))
    assert.equal(f.calls.filter((call) => call.method === "prompt" && f.d.panel.some((member) => member.sessionID === call.id)).length, 0)
    if (scenario.failure === "lost-response") {
      await assert.rejects(f.runtime.load(f.owner), /unconfirmed|checkpoint/i)
      const recovered = createRuntime(f.input)
      assert.deepEqual((await recovered.load(f.owner))!.discussions[0].panel, f.d.panel)
      for (const member of f.d.panel) assert.deepEqual(await recovered.reconcileParticipant(f.owner, member),
        { sessionID: member.sessionID, state: "exhausted", canContinue: false })
      assert.equal(f.modelCalls(), before, "fresh chain recovery must not automatically dispatch a running cycle")
    }
    assert.equal(await f.runtime.prompt(unenrolled, "retained-only control still works"), "final answer")
    assert.equal(f.modelCalls(), before + 1)
  })
}

test("managed enrolment blocks all panel members before awaited owner and member validation", async () => {
  const f = await setup()
  for (let index = 0; index < 3; index++) f.d.panel.push(await f.runtime.createParticipant(f.owner,
    { agent: `pending-${index}`, description: "pending binding", model: "fake/fake-model" }, []))
  const entered = gate(); const release = gate(); const get = f.session.get
  f.session.get = async (request) => {
    if (request.path.id === f.owner.sessionID) {
      entered.release()
      await release.promise
      throw new Error("owner validation failed during binding")
    }
    return get(request)
  }
  const saved = f.runtime.save(f.owner, f.state)
  const rejectedSave = assert.rejects(saved, /owner validation failed/)
  try {
    await entered.promise
    const outcomes = await Promise.all(f.d.panel.map((member) => f.runtime.prompt(member, "no pending-binding fallback")
      .then(() => "accepted", () => "rejected")))
    assert.equal(f.modelCalls(), 0)
    assert.deepEqual(outcomes, ["rejected", "rejected", "rejected"])
  } finally {
    release.release()
    await rejectedSave
  }
})

test("a retained-only starter awaiting lookup cannot cross a later managed enrolment fence", async () => {
  const f = await setup()
  const member = await f.runtime.createParticipant(f.owner,
    { agent: "enrolment-race", description: "pending lookup", model: "fake/fake-model" }, [])
  f.d.panel.push(member)
  const entered = gate(); const release = gate(); const get = f.session.get
  let first = true
  f.session.get = async (request) => {
    if (request.path.id === member.sessionID && first) {
      first = false
      entered.release()
      await release.promise
    }
    return get(request)
  }
  const outcome = f.runtime.prompt(member, "must not dispatch past enrolment").then(() => "accepted", () => "rejected")
  try {
    await entered.promise
    await assert.rejects(f.runtime.save(f.owner, f.state), /unjournalled startup|stopping/i)
  } finally {
    release.release()
  }
  assert.equal(await outcome, "rejected")
  assert.equal(f.modelCalls(), 0)
})

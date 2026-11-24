import assert from "node:assert/strict"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { discussionAudit } from "../src/auto-debate/audit.ts"
import { createManager } from "../src/auto-debate/manager.ts"
import { createRuntime } from "../src/auto-debate/opencode.ts"
import { privateOwnerKey } from "../src/auto-debate/private-store.ts"
import { isCompactionEligible, MaintenanceFailure, type CompactionResult } from "../src/auto-debate/storage.ts"
import type {
  CheckpointSnapshot, ConversationState, DeliveryIntent, DeliveryReconciliation, Discussion,
  Owner, PanelMember, ParticipantReconciliation, Rule, Runtime, RuntimeReceipt,
} from "../src/auto-debate/types.ts"
import type { DebateRegistry } from "../src/participants.ts"
import { privateStorageClient } from "./fixtures/private-storage-client.ts"

const owner = { sessionID: "parent-compaction", agent: "build", directory: "/compaction-workspace" }
const member: PanelMember = {
  participant: { agent: "one", description: "one", model: "fake/one" },
  sessionID: "child-1",
  runtimeAgent: "one",
}

function compactionSnapshot(options: {
  status: Discussion["status"]
  cancellation?: Discussion["cancellation"]
  outbox?: ConversationState["outbox"]
  uncertainty?: Discussion["deliveryUncertainCycles"]
  startOpen?: boolean
  missingProof?: boolean
  cancelledUnconfirmed?: boolean
}): CheckpointSnapshot {
  const discussion: Discussion = {
    id: "discussion-compaction", owner,
    config: { enabled: true, maxRounds: 3, persistTranscripts: false },
    brief: { question: "q", objective: "o", facts: [], assumptions: [], constraints: [],
      alternatives: [], uncertainty: "u", neededOutcome: "n" },
    panel: [member], status: options.status, generation: 0, cycle: 1,
    results: [{ cycle: 1, rounds: 1, status: options.status === "cancelled" ? "cancelled" : "complete",
      reason: "round-limit", turns: [], failures: [], consensus: false }],
    evaluations: [], pendingTurns: [], followups: [],
    ...(options.uncertainty === undefined ? {} : { deliveryUncertainCycles: options.uncertainty }),
    ...(options.cancellation === undefined ? {} : { cancellation: options.cancellation }),
  }
  const entries: RuntimeReceipt[] = [{
    kind: "member-bound", discussionID: discussion.id, member,
    nonce: "a".repeat(32), permission: [{ permission: "*", pattern: "*", action: "deny" }],
  }]
  if (!options.missingProof) {
    entries.push({ kind: "participant-start-open", sessionID: member.sessionID, messageID: "msg-start",
      discussionID: discussion.id, generation: 0, cycle: 1, textDigest: "b".repeat(64) })
    if (!options.startOpen) entries.push({ kind: "participant-start-closed", sessionID: member.sessionID,
      messageID: "msg-start", startup: "synchronous-response", outcome: "answer", assistantID: "assistant-1" })
    if (options.status === "cancelled") {
      entries.push({ kind: "participant-fenced", sessionID: member.sessionID })
      if (!options.cancelledUnconfirmed) entries.push({ kind: "participant-stop-confirmed", sessionID: member.sessionID })
    }
  }
  return {
    state: { version: 1, discussions: [discussion], outbox: options.outbox ?? [] },
    ...(options.missingProof ? {} : { runtimeProof: { version: 1, entries } }),
  }
}

test("compaction is eligible only for fully settled terminal stores", () => {
  assert.equal(isCompactionEligible(compactionSnapshot({ status: "resolved" })), true)
  assert.equal(isCompactionEligible(compactionSnapshot({ status: "cancelled",
    cancellation: { pendingSessionIDs: [], errors: [] } })), true)

  const cases: CheckpointSnapshot[] = [
    compactionSnapshot({ status: "running" }),
    compactionSnapshot({ status: "awaiting-evaluation" }),
    compactionSnapshot({ status: "paused" }),
    compactionSnapshot({ status: "interrupted" }),
    compactionSnapshot({ status: "cancelled", cancellation: { pendingSessionIDs: ["child-1"], errors: [] } }),
    compactionSnapshot({ status: "cancelled", outbox: [{ id: "out", discussionID: "discussion-compaction",
      cycle: 1, state: "pending" }] }),
    compactionSnapshot({ status: "resolved", uncertainty: [{ cycle: 1, reason: "unknown delivery" }] }),
    compactionSnapshot({ status: "resolved", startOpen: true }),
    compactionSnapshot({ status: "cancelled", cancelledUnconfirmed: true }),
    compactionSnapshot({ status: "resolved", missingProof: true }),
  ]
  for (const snapshot of cases) assert.equal(isCompactionEligible(snapshot), false)
})

type CompactionFixture = Awaited<ReturnType<typeof privateStorageClient>>

const compactionParticipants = ["one", "two", "three"].map((agent) => ({
  agent, description: `Participant ${agent}`, model: `fake/${agent}`,
}))
const compactionBrief = {
  question: "Which option is safest?", objective: "Choose safely",
  facts: ["A fact"], assumptions: [], constraints: ["No deployment"],
  alternatives: ["A", "B"], uncertainty: "Unknown impact", neededOutcome: "Recommendation",
}

function compactionRegistry(): DebateRegistry {
  return {
    participants: compactionParticipants,
    sets: { default: compactionParticipants.map((participant) => participant.agent) },
    defaultSet: "default",
    autoDebate: { enabled: true, maxRounds: 3, persistTranscripts: false },
  }
}

function compactionCanonicalise(raw: string, schema: "round1" | "round2"): string {
  if (schema === "round1") return JSON.stringify({ turn: raw })
  return JSON.stringify({ turn: raw, consensus_reached: false, recommend_stopping: true })
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function compactionOwnerDirectory(f: CompactionFixture, owner: Owner = f.owner): string {
  return join(f.stateRoot, "opencode-debate", privateOwnerKey(f.projectID, owner))
}

async function revisionNames(f: CompactionFixture, owner: Owner = f.owner): Promise<string[]> {
  return (await readdir(compactionOwnerDirectory(f, owner)))
    .filter((name) => /^\d{16}\.json$/.test(name)).sort()
}

async function revisionPayload(f: CompactionFixture, name: string, owner: Owner = f.owner) {
  const text = await readFile(join(compactionOwnerDirectory(f, owner), name), "utf8")
  return JSON.parse((JSON.parse(text) as { payload: string }).payload) as {
    revision: number
    compaction: { throughRevision: number; throughDigest: string } | null
    state: ConversationState
  }
}

function compactionManager(f: CompactionFixture) {
  const runtime = createRuntime(f.input, { storage: "auto" })
  const calls: CompactionResult[] = []
  const maintenance = {
    compactIfEligible: async (owner: Owner, predicate: (snapshot: CheckpointSnapshot) => boolean) => {
      const result = await runtime.compactIfEligible(owner, predicate)
      calls.push(result)
      return result
    },
  }
  let next = 0
  const manager = createManager({
    runtime,
    registry: compactionRegistry(),
    canonicalise: compactionCanonicalise,
    checkpoint: async () => {},
    id: () => `discussion-${++next}`,
    maintenance,
  })
  return { runtime, manager, calls }
}

async function waitForSettledAwaiting(
  runtime: ReturnType<typeof createRuntime>,
  manager: ReturnType<typeof createManager>,
  owner: Owner,
  id: string,
): Promise<Discussion> {
  return waitFor("a settled awaiting-evaluation discussion", async () => {
    const state = await runtime.load(owner)
    const discussion = state?.discussions.find((candidate) => candidate.id === id)
    const outbox = state?.outbox.find((item) => item.discussionID === id && item.cycle === 1)
    return discussion?.status === "awaiting-evaluation" && outbox?.state === "sent" ? discussion : undefined
  })
}

function cycleEvaluation() {
  return {
    cycle: 1, conclusion: "Act safely", caveats: [], rationale: "The saved evidence is sufficient.",
    next: "act" as const,
  }
}

test("terminal lifecycle compaction keeps full state and later saves append after the base", async () => {
  const f = await privateStorageClient()
  const { runtime, manager, calls } = compactionManager(f)
  try {
    const first = await manager.start(f.owner, compactionBrief)
    await waitForSettledAwaiting(runtime, manager, f.owner, first.id)
    const resolved = await manager.evaluate(f.owner, first.id, cycleEvaluation())
    assert.equal(resolved.status, "resolved")
    const expectedState = await runtime.load(f.owner)

    const names = await waitFor("terminal compaction", async () => {
      const value = await revisionNames(f)
      return value.length === 1 && calls.length === 1 ? value : undefined
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].status, "compacted")
    const payload = await revisionPayload(f, names[0])
    assert.ok(payload.compaction)
    assert.equal(payload.compaction.throughRevision, payload.revision - 1)
    assert.deepEqual(payload.state.discussions, [resolved])

    const loaded = await runtime.load(f.owner)
    assert.deepEqual(loaded, expectedState)
    assert.deepEqual(loaded?.discussions, [resolved])

    const audit = discussionAudit((await manager.status(f.owner, first.id))[0])
    assert.equal(audit.results.length, 1)
    assert.equal(audit.results[0].turns.length, 6)
    assert.deepEqual(audit.evaluations, resolved.evaluations)

    const baseRevision = Number(names[0].slice(0, 16))
    const second = await manager.start(f.owner, { ...compactionBrief, question: "A later question" })
    const appended = await waitFor("append after the compacted base", async () => {
      const value = await revisionNames(f)
      return value.length > 1 ? value : undefined
    })
    assert.ok(appended.includes(names[0]), "the compaction base must be retained")
    const highest = Math.max(...appended.map((name) => Number(name.slice(0, 16))))
    assert.ok(highest > baseRevision)
    assert.equal((await runtime.load(f.owner))?.discussions.some((item) => item.id === second.id), true)
    assert.deepEqual((await runtime.load(f.owner))?.discussions.find((item) => item.id === first.id), resolved)
  } finally {
    await manager.dispose()
    await f.cleanup()
  }
})

test("a mixed parent store with a running discussion is not compacted", async () => {
  const f = await privateStorageClient()
  const { runtime, manager, calls } = compactionManager(f)
  try {
    const first = await manager.start(f.owner, compactionBrief)
    await waitForSettledAwaiting(runtime, manager, f.owner, first.id)
    const second = await manager.start(f.owner, { ...compactionBrief, question: "Still running" })
    assert.equal(second.status, "running")
    const before = await revisionNames(f)
    await manager.evaluate(f.owner, first.id, cycleEvaluation())
    await waitFor("maintenance refusal for a mixed store", async () => calls.length === 1 ? true : undefined)
    assert.equal(calls[0].status, "not-eligible")

    const after = await revisionNames(f)
    for (const name of before) assert.ok(after.includes(name), `${name} must be retained`)
    for (const name of after) {
      assert.equal((await revisionPayload(f, name)).compaction, null)
    }
    const state = await runtime.load(f.owner)
    assert.equal(state?.discussions.find((item) => item.id === first.id)?.status, "resolved")
    assert.ok(["running", "awaiting-evaluation"].includes(
      state?.discussions.find((item) => item.id === second.id)?.status ?? ""))
  } finally {
    await manager.dispose()
    await f.cleanup()
  }
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

class GuardRuntime implements Runtime {
  readonly states = new Map<string, ConversationState>()
  readonly created: PanelMember[] = []
  readonly aborted: string[] = []
  saveAttempts = 0
  deliverAttempts = 0
  promptCalls = 0
  saveGate?: { entered: () => void; release: Promise<void> }
  deliverGate?: { entered: () => void; release: Promise<void> }
  createGate?: { entered: () => void; release: Promise<void> }
  private nextMember = 0

  async assertOwner(): Promise<{ agent: readonly Rule[]; session: readonly Rule[] }> {
    return { agent: [], session: [] }
  }
  async restrictions(): Promise<readonly Rule[]> { return [] }
  async createParticipant(_owner: Owner, participant: PanelMember["participant"]): Promise<PanelMember> {
    if (this.createGate) {
      const gate = this.createGate
      this.createGate = undefined
      gate.entered()
      await gate.release
    }
    const member = { participant: structuredClone(participant), runtimeAgent: participant.agent,
      sessionID: `guard-child-${++this.nextMember}` }
    this.created.push(member)
    return structuredClone(member)
  }
  async prompt(): Promise<string> { this.promptCalls++; return "answer" }
  async abort(member: PanelMember): Promise<void> { this.aborted.push(member.sessionID) }
  async parentIdle(): Promise<boolean> { return true }
  async deliver(_owner: Owner, intent: DeliveryIntent): Promise<DeliveryReconciliation> {
    this.deliverAttempts++
    if (this.deliverGate) {
      const gate = this.deliverGate
      this.deliverGate = undefined
      gate.entered()
      await gate.release
    }
    return { delivery: structuredClone(intent), messageID: `guard-${intent.id}`, state: "persisted" }
  }
  async reconcileDeliveries(): Promise<readonly DeliveryReconciliation[]> { return [] }
  async reconcileParticipant(_owner: Owner, member: PanelMember): Promise<ParticipantReconciliation> {
    return { sessionID: member.sessionID, state: "exhausted", canContinue: true }
  }
  async load(owner: Owner): Promise<ConversationState | undefined> {
    const state = this.states.get(owner.sessionID)
    return state === undefined ? undefined : structuredClone(state)
  }
  async save(owner: Owner, state: ConversationState): Promise<void> {
    this.saveAttempts++
    if (this.saveGate) {
      const gate = this.saveGate
      this.saveGate = undefined
      gate.entered()
      await gate.release
    }
    this.states.set(owner.sessionID, structuredClone(state))
  }
}

const guardOwner: Owner = { sessionID: "guard-owner", agent: "build", directory: "/guard-workspace" }

test("withMaintenance blocks new owner work and waits for lifecycle and idle work", async () => {
  const runtime = new GuardRuntime()
  const manager = createManager({
    runtime,
    registry: compactionRegistry(),
    canonicalise: compactionCanonicalise,
    checkpoint: async () => {},
    id: () => "guard-discussion",
  })
  try {
    const saveEntered = deferred()
    const saveRelease = deferred()
    runtime.saveGate = { entered: () => saveEntered.resolve(), release: saveRelease.promise }
    const start = manager.start(guardOwner, compactionBrief)
    await saveEntered.promise

    let entered = false
    const operationEntered = deferred()
    const operationRelease = deferred()
    const maintenance = manager.withMaintenance(guardOwner, async () => {
      entered = true
      operationEntered.resolve()
      await operationRelease.promise
    })
    await assert.rejects(manager.start(guardOwner, compactionBrief), /maintenance/i)
    await assert.rejects(manager.evaluate(guardOwner, "missing", cycleEvaluation()), /maintenance/i)
    await assert.rejects(manager.resume(guardOwner, "missing", "continue"), /maintenance/i)
    await assert.rejects(manager.cancel(guardOwner, "all", "explicit-stop"), /maintenance/i)
    await assert.rejects(manager.control(guardOwner, { action: "on" }), /maintenance/i)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(entered, false, "maintenance must wait for the blocked owner lifecycle")
    assert.equal(runtime.saveAttempts, 1)
    saveRelease.resolve()
    await assert.rejects(start, /maintenance/i)
    await operationEntered.promise
    assert.equal(entered, true)
    await assert.rejects(manager.start(guardOwner, compactionBrief), /maintenance/i)
    assert.equal(runtime.saveAttempts, 1, "rejected work must not mutate state")
    operationRelease.resolve()
    await maintenance
  } finally {
    await manager.dispose()
  }
})

test("withMaintenance waits for existing idle delivery work", async () => {
  const runtime = new GuardRuntime()
  const discussion: Discussion = {
    id: "idle-discussion", owner: guardOwner,
    config: { enabled: true, maxRounds: 3, persistTranscripts: false },
    brief: compactionBrief, panel: [], status: "awaiting-evaluation", generation: 0, cycle: 1,
    results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit",
      turns: [], failures: [], consensus: false }],
    evaluations: [], pendingTurns: [], followups: [],
  }
  runtime.states.set(guardOwner.sessionID, {
    version: 1, discussions: [discussion],
    outbox: [{ id: `auto-debate:${discussion.id}:cycle:1`, discussionID: discussion.id, cycle: 1, state: "pending" }],
  })
  const manager = createManager({
    runtime,
    registry: compactionRegistry(),
    canonicalise: compactionCanonicalise,
    checkpoint: async () => {},
    id: () => "unused",
  })
  try {
    await manager.status(guardOwner)
    const deliverEntered = deferred()
    const deliverRelease = deferred()
    runtime.deliverGate = { entered: () => deliverEntered.resolve(), release: deliverRelease.promise }
    const idle = manager.onIdle(guardOwner.sessionID)
    await deliverEntered.promise

    let entered = false
    const operationEntered = deferred()
    const maintenance = manager.withMaintenance(guardOwner, async () => {
      entered = true
      operationEntered.resolve()
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(entered, false, "maintenance must wait for idle delivery work")
    await assert.rejects(manager.start(guardOwner, compactionBrief), /maintenance/i)
    deliverRelease.resolve()
    await idle
    await operationEntered.promise
    assert.equal(entered, true)
    await maintenance
  } finally {
    await manager.dispose()
  }
})

test("compaction refuses a native backend with a legacy result", async () => {
  const f = await privateStorageClient()
  try {
    await createRuntime(f.input, { storage: "native" }).save(f.owner,
      { version: 1, discussions: [], outbox: [] })
    const runtime = createRuntime(f.input, { storage: "auto" })
    await runtime.load(f.owner)
    const result = await runtime.compactIfEligible(f.owner, () => true)
    assert.equal(result.status, "legacy")
  } finally {
    await f.cleanup()
  }
})

test("a compaction failure poisons later writes without rolling back a saved terminal state", async () => {
  const runtime = new GuardRuntime()
  const discussion: Discussion = {
    id: "failure-discussion", owner: guardOwner,
    config: { enabled: true, maxRounds: 3, persistTranscripts: false },
    brief: compactionBrief, panel: [], status: "awaiting-evaluation", generation: 0, cycle: 1,
    results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit",
      turns: [], failures: [], consensus: false }],
    evaluations: [], pendingTurns: [], followups: [],
  }
  runtime.states.set(guardOwner.sessionID, { version: 1, discussions: [discussion], outbox: [] })
  let compactions = 0
  const manager = createManager({
    runtime,
    registry: compactionRegistry(),
    canonicalise: compactionCanonicalise,
    checkpoint: async () => {},
    id: () => "unused",
    maintenance: {
      compactIfEligible: async () => {
        compactions++
        throw new MaintenanceFailure("publication", "injected publication/cleanup failure")
      },
    },
  })
  try {
    const resolved = await manager.evaluate(guardOwner, discussion.id, cycleEvaluation())
    assert.equal(resolved.status, "resolved")
    await waitFor("the injected maintenance failure", async () => compactions === 1 ? true : undefined)
    await assert.rejects(manager.control(guardOwner, { action: "on" }), /unconfirmed/i)
    assert.equal((await manager.status(guardOwner, discussion.id))[0].status, "resolved")
  } finally {
    await manager.dispose()
  }
})

test("eligibility requires the receipt to bind the same discussion and member identity", () => {
  const snapshot = compactionSnapshot({ status: "resolved" })
  const original = snapshot.state.discussions[0]

  const foreign = structuredClone(original)
  foreign.id = "discussion-other"
  const foreignSnapshot: CheckpointSnapshot = {
    ...snapshot,
    state: { ...snapshot.state, discussions: [original, foreign] },
  }
  assert.equal(isCompactionEligible(foreignSnapshot), false,
    "a receipt for one discussion cannot bind the same session in another")

  const changed = structuredClone(original)
  changed.id = "discussion-changed"
  changed.panel = [{ ...structuredClone(original.panel[0]), runtimeAgent: "different-runtime" }]
  const changedSnapshot: CheckpointSnapshot = {
    ...snapshot,
    state: { ...snapshot.state, discussions: [original, changed] },
  }
  assert.equal(isCompactionEligible(changedSnapshot), false,
    "a receipt must match the full member identity, not only the session ID")
})

test("a maintenance hold contains an already-created participant before rejecting start", async () => {
  const runtime = new GuardRuntime()
  const manager = createManager({
    runtime,
    registry: compactionRegistry(),
    canonicalise: compactionCanonicalise,
    checkpoint: async () => {},
    id: () => "guard-create",
  })
  try {
    const createEntered = deferred()
    const createRelease = deferred()
    runtime.createGate = { entered: () => createEntered.resolve(), release: createRelease.promise }
    const start = manager.start(guardOwner, compactionBrief)
    await createEntered.promise

    const maintenance = manager.withMaintenance(guardOwner, async () => {})
    await new Promise((resolve) => setImmediate(resolve))
    createRelease.resolve()
    await assert.rejects(start, /maintenance/i)
    await maintenance

    const created = runtime.created[0]
    const discussion = runtime.states.get(guardOwner.sessionID)!.discussions[0]
    assert.ok(discussion.panel.some((member) => member.sessionID === created.sessionID),
      "the created participant must be recorded in the saved panel")
    assert.deepEqual(runtime.aborted, [created.sessionID],
      "the created participant must be contained before the start rejects")
    assert.equal(runtime.created.length, 1, "maintenance must prevent further participant creation")
    assert.equal(runtime.promptCalls, 0, "no prompt may be dispatched after the hold is set")
  } finally {
    await manager.dispose()
  }
})

test("a pre-publication maintenance failure does not poison later manager writes", async () => {
  const runtime = new GuardRuntime()
  const discussion: Discussion = {
    id: "preflight-discussion", owner: guardOwner,
    config: { enabled: true, maxRounds: 3, persistTranscripts: false },
    brief: compactionBrief, panel: [], status: "awaiting-evaluation", generation: 0, cycle: 1,
    results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit",
      turns: [], failures: [], consensus: false }],
    evaluations: [], pendingTurns: [], followups: [],
  }
  runtime.states.set(guardOwner.sessionID, { version: 1, discussions: [discussion], outbox: [] })
  let compactions = 0
  const manager = createManager({
    runtime,
    registry: compactionRegistry(),
    canonicalise: compactionCanonicalise,
    checkpoint: async () => {},
    id: () => "unused",
    maintenance: {
      compactIfEligible: async () => {
        compactions++
        throw new Error("injected transient preflight lookup failure")
      },
    },
  })
  try {
    const resolved = await manager.evaluate(guardOwner, discussion.id, cycleEvaluation())
    assert.equal(resolved.status, "resolved")
    await waitFor("the injected preflight failure", async () => compactions === 1 ? true : undefined)
    await new Promise((resolve) => setImmediate(resolve))
    assert.match(await manager.control(guardOwner, { action: "on" }), /enabled/i)
    assert.equal((await manager.status(guardOwner, discussion.id))[0].status, "resolved")
  } finally {
    await manager.dispose()
  }
})

test("pre-compaction integrity failures still fail closed at storage", async () => {
  const f = await privateStorageClient()
  try {
    const runtime = createRuntime(f.input, { storage: "auto" })
    const initial = { version: 1 as const, discussions: [], outbox: [] }
    await runtime.save(f.owner, initial)
    const names = await revisionNames(f)
    assert.equal(names.length, 1)
    await writeFile(join(compactionOwnerDirectory(f), names[0]), "corrupt", { mode: 0o600 })

    let failure: unknown
    try { await runtime.compactIfEligible(f.owner, () => true) }
    catch (error) { failure = error }
    assert.equal((failure as { stage?: string } | undefined)?.stage, "preflight")
    await assert.rejects(runtime.save(f.owner, initial), /failed|json|corrupt/i)
  } finally {
    await f.cleanup()
  }
})

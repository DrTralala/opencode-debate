import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { createManager } from "../src/auto-debate/manager.ts"
import { DEFAULT_AUTO_DEBATE_CONFIG, parseControl } from "../src/auto-debate/state.ts"
import { checkpointTranscript } from "../src/auto-debate/transcripts.ts"
import type { DebateRegistry } from "../src/participants.ts"
import type {
  ConversationState,
  DeliveryIntent,
  DeliveryReconciliation,
  Discussion,
  Owner,
  PanelMember,
  ParticipantReconciliation,
  Rule,
  Runtime,
} from "../src/auto-debate/types.ts"

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

type PromptCall = { member: PanelMember; text: string; result: Deferred<string>; settled: boolean }
type DeliveryCall = { owner: Owner; intent: DeliveryIntent; callIndex: number }
type SaveAttempt = { callIndex: number; state: ConversationState; succeeded: boolean }

class FakeRuntime implements Runtime {
  readonly states = new Map<string, ConversationState>()
  readonly calls: { method: string; sessionID?: string }[] = []
  readonly saveLog: { callIndex: number; state: ConversationState }[] = []
  readonly saveAttempts: SaveAttempt[] = []
  readonly abortObservations: { sessionID: string; generation?: number; status?: Discussion["status"] }[] = []
  readonly promptCalls: PromptCall[] = []
  readonly deliveries: DeliveryCall[] = []
  readonly reconciliations = new Map<string, DeliveryReconciliation>()
  readonly participantStates = new Map<string, ParticipantReconciliation>()
  readonly created: PanelMember[] = []
  readonly aborted: string[] = []
  readonly failCreateAgents = new Set<string>()
  readonly failAbortSessions = new Set<string>()
  abortBlock?: { sessionID: string; entered: Deferred<void>; release: Deferred<void> }
  createBlock?: { entered: Deferred<void>; release: Deferred<void> }
  restrictionsBlock?: { entered: Deferred<void>; release: Deferred<void> }
  reconcileBlock?: { sessionIDs: ReadonlySet<string>; entered: Deferred<void>; release: Deferred<void> }
  saveBlock?: { predicate(state: ConversationState): boolean; entered: Deferred<void>; release: Deferred<void> }
  failSavePredicate?: (state: ConversationState) => boolean
  nextSaveFailures = 0
  ownerIdle = true
  deliverResult?: DeliveryReconciliation
  private promptWaiters: { count: number; signal: Deferred<void> }[] = []
  private saveWaiters: { count: number; signal: Deferred<void> }[] = []
  private deliveryWaiters: { count: number; signal: Deferred<void> }[] = []
  private stateWaiters: { ownerID: string; predicate(state: ConversationState): boolean; signal: Deferred<void> }[] = []
  private saveAttemptWaiters: { count: number; signal: Deferred<void> }[] = []
  private abortWaiters: { count: number; signal: Deferred<void> }[] = []
  private nextMemberID = 1
  private latestOwner?: Owner

  async assertOwner(owner: Owner): Promise<{ agent: readonly Rule[]; session: readonly Rule[] }> {
    this.latestOwner = structuredClone(owner)
    return { agent: [], session: [] }
  }
  async restrictions(_owner: Owner): Promise<readonly Rule[]> {
    if (this.restrictionsBlock) {
      this.restrictionsBlock.entered.resolve()
      await this.restrictionsBlock.release.promise
    }
    return []
  }
  async createParticipant(owner: Owner, participant: PanelMember["participant"], _restrictions: readonly Rule[]): Promise<PanelMember> {
    this.calls.push({ method: "createParticipant", sessionID: owner.sessionID })
    if (this.createBlock) { this.createBlock.entered.resolve(); await this.createBlock.release.promise }
    if (this.failCreateAgents.has(participant.agent)) throw new Error(`create failed for ${participant.agent}`)
    const member: PanelMember = {
      participant: structuredClone(participant), runtimeAgent: participant.agent, sessionID: `child-${this.nextMemberID++}`,
    }
    this.created.push(member)
    return structuredClone(member)
  }
  prompt(member: PanelMember, text: string): Promise<string> {
    this.calls.push({ method: "prompt", sessionID: member.sessionID })
    const call: PromptCall = { member: structuredClone(member), text, result: deferred<string>(), settled: false }
    this.promptCalls.push(call)
    for (const waiter of this.promptWaiters.splice(0)) if (this.promptCalls.length >= waiter.count) waiter.signal.resolve()
      else this.promptWaiters.push(waiter)
    return call.result.promise.then((value) => { call.settled = true; return value }, (error) => { call.settled = true; throw error })
  }
  async abort(member: PanelMember): Promise<void> {
    this.calls.push({ method: "abort", sessionID: member.sessionID })
    this.aborted.push(member.sessionID)
    for (const waiter of this.abortWaiters.splice(0)) if (this.aborted.length >= waiter.count) waiter.signal.resolve()
      else this.abortWaiters.push(waiter)
    const discussion = [...this.states.values()].flatMap((state) => state.discussions)
      .find((item) => item.panel.some((candidate) => candidate.sessionID === member.sessionID))
    this.abortObservations.push({ sessionID: member.sessionID, generation: discussion?.generation, status: discussion?.status })
    if (this.abortBlock?.sessionID === member.sessionID) {
      this.abortBlock.entered.resolve()
      await this.abortBlock.release.promise
    }
    if (this.failAbortSessions.has(member.sessionID)) throw new Error(`abort unconfirmed for ${member.sessionID}`)
  }
  async parentIdle(_owner: Owner): Promise<boolean> { this.calls.push({ method: "parentIdle" }); return this.ownerIdle }
  async deliver(owner: Owner, intent: DeliveryIntent): Promise<DeliveryReconciliation> {
    this.calls.push({ method: "deliver" })
    this.deliveries.push({ owner: structuredClone(owner), intent: structuredClone(intent), callIndex: this.calls.length - 1 })
    const result = this.deliverResult ?? { delivery: structuredClone(intent), messageID: `native-${intent.id}`, state: "persisted" as const }
    this.reconciliations.set(intent.id, structuredClone(result))
    for (const waiter of this.deliveryWaiters.splice(0)) if (this.deliveries.length >= waiter.count) waiter.signal.resolve()
      else this.deliveryWaiters.push(waiter)
    return structuredClone(result)
  }
  async reconcileDeliveries(_owner: Owner): Promise<readonly DeliveryReconciliation[]> {
    this.calls.push({ method: "reconcileDeliveries" })
    return structuredClone([...this.reconciliations.values()])
  }
  async reconcileParticipant(_owner: Owner, member: PanelMember): Promise<ParticipantReconciliation> {
    this.calls.push({ method: "reconcileParticipant", sessionID: member.sessionID })
    if (this.reconcileBlock?.sessionIDs.has(member.sessionID)) {
      this.reconcileBlock.entered.resolve()
      await this.reconcileBlock.release.promise
    }
    return structuredClone(this.participantStates.get(member.sessionID)
      ?? { sessionID: member.sessionID, state: "exhausted", canContinue: true })
  }
  async load(owner: Owner): Promise<ConversationState | undefined> {
    this.latestOwner = structuredClone(owner)
    this.calls.push({ method: "load", sessionID: owner.sessionID })
    const state = this.states.get(owner.sessionID)
    return state === undefined ? undefined : structuredClone(state)
  }
  async save(owner: Owner, state: ConversationState): Promise<void> {
    this.latestOwner = structuredClone(owner)
    this.calls.push({ method: "save", sessionID: owner.sessionID })
    const snapshot = structuredClone(state)
    const attempt: SaveAttempt = { callIndex: this.calls.length - 1, state: snapshot, succeeded: false }
    this.saveAttempts.push(attempt)
    for (const waiter of this.saveAttemptWaiters.splice(0)) if (this.saveAttempts.length >= waiter.count) waiter.signal.resolve()
      else this.saveAttemptWaiters.push(waiter)
    if (this.saveBlock?.predicate(snapshot)) {
      const gate = this.saveBlock
      this.saveBlock = undefined
      gate.entered.resolve()
      await gate.release.promise
    }
    const injectedFailure = this.failSavePredicate?.(snapshot) ?? false
    if (injectedFailure) this.failSavePredicate = undefined
    if (this.nextSaveFailures > 0 || injectedFailure) {
      if (this.nextSaveFailures > 0) this.nextSaveFailures--
      throw new Error("checkpoint save failed")
    }
    this.states.set(owner.sessionID, structuredClone(snapshot))
    attempt.succeeded = true
    this.saveLog.push({ callIndex: attempt.callIndex, state: structuredClone(snapshot) })
    for (const waiter of this.stateWaiters.splice(0)) {
      const current = this.states.get(waiter.ownerID)
      if (current && waiter.predicate(structuredClone(current))) waiter.signal.resolve()
      else this.stateWaiters.push(waiter)
    }
    for (const waiter of this.saveWaiters.splice(0)) if (this.saveCount(owner.sessionID) >= waiter.count) waiter.signal.resolve()
      else this.saveWaiters.push(waiter)
  }
  async waitForPrompts(count: number): Promise<void> {
    if (this.promptCalls.length >= count) return
    const signal = deferred<void>(); this.promptWaiters.push({ count, signal }); return signal.promise
  }
  async waitForSaves(owner: Owner, count: number): Promise<void> {
    if (this.saveCount(owner.sessionID) >= count) return
    const signal = deferred<void>(); this.saveWaiters.push({ count, signal }); return signal.promise
  }
  async waitForSaveAttempts(count: number): Promise<void> {
    if (this.saveAttempts.length >= count) return
    const signal = deferred<void>(); this.saveAttemptWaiters.push({ count, signal }); return signal.promise
  }
  async waitForAborts(count: number): Promise<void> {
    if (this.aborted.length >= count) return
    const signal = deferred<void>(); this.abortWaiters.push({ count, signal }); return signal.promise
  }
  async waitForDeliveries(count: number): Promise<void> {
    if (this.deliveries.length >= count) return
    const signal = deferred<void>(); this.deliveryWaiters.push({ count, signal }); return signal.promise
  }
  async waitForState(owner: Owner, predicate: (state: ConversationState) => boolean): Promise<void> {
    const state = this.states.get(owner.sessionID)
    if (state && predicate(structuredClone(state))) return
    const signal = deferred<void>(); this.stateWaiters.push({ ownerID: owner.sessionID, predicate, signal }); return signal.promise
  }
  saveCount(sessionID: string): number { return this.calls.filter((call) => call.method === "save" && call.sessionID === sessionID).length }
  state(owner: Owner): ConversationState { return structuredClone(this.states.get(owner.sessionID)!) }
  fulfill(index: number, value: string): void { this.promptCalls[index].result.resolve(value) }
  failPrompt(index: number, error = new Error("prompt failed")): void { this.promptCalls[index].result.reject(error) }
}

const owner: Owner = { sessionID: "owner-1", agent: "main", directory: "/workspace" }
const participants = ["one", "two", "three"].map((agent) => ({
  agent, description: `Neutral ${agent}`, model: `provider/${agent}`,
}))
function registry(maxRounds = 3, enabled = true): DebateRegistry {
  return {
    participants,
    sets: { default: participants.map((participant) => participant.agent) },
    defaultSet: "default",
    autoDebate: { enabled, maxRounds, persistTranscripts: false },
  }
}
const brief = {
  question: "What should be done?", objective: "Make a safe choice", facts: ["fact"], assumptions: [],
  constraints: ["no deployment"], alternatives: ["A", "B"], uncertainty: "impact is unclear", neededOutcome: "recommendation",
}
function canonicalise(raw: string, schema: "round1" | "round2"): string {
  const value = JSON.parse(raw) as Record<string, unknown>
  assert.equal(typeof value.turn, "string")
  assert.ok((value.turn as string).trim())
  if (schema === "round1") assert.deepEqual(Object.keys(value).sort(), ["turn"])
  else {
    assert.equal(typeof value.consensus_reached, "boolean")
    assert.equal(typeof value.recommend_stopping, "boolean")
    assert.deepEqual(Object.keys(value).sort(), ["consensus_reached", "recommend_stopping", "turn"])
  }
  return JSON.stringify(value)
}
function answer(turn: string, options: { consensus?: boolean; stop?: boolean } = {}): string {
  return JSON.stringify({ turn, consensus_reached: options.consensus ?? false, recommend_stopping: options.stop ?? false })
}
function firstAnswer(turn: string): string { return JSON.stringify({ turn }) }
function pausedDiscussion(id: string, prefix: string): Discussion {
  const panel = participants.map((participant, index) => ({
    participant, runtimeAgent: participant.agent, sessionID: `${prefix}-${index}`,
  }))
  return {
    id, owner, config: { enabled: true, maxRounds: 3, persistTranscripts: false }, brief,
    panel, status: "paused", generation: 0, cycle: 1,
    results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit",
      turns: panel.map((member) => ({ participant: member.participant.agent, cycle: 1, round: 1, text: `saved ${member.participant.agent}` })),
      failures: [], consensus: false }],
    evaluations: [{ cycle: 1, conclusion: "Continue", caveats: [], rationale: "More evidence is needed.", next: "continue" }],
    pendingTurns: [], followups: [],
  }
}
function makeManager(runtime: FakeRuntime, options: {
  maxRounds?: number
  enabled?: boolean
  id?: () => string
  snapshots?: Discussion[]
  canonicalised?: string[]
} = {}) {
  let nextID = 0
  return createManager({
    runtime,
    registry: registry(options.maxRounds ?? 3, options.enabled ?? true),
    canonicalise: (raw, schema) => { options.canonicalised?.push(raw); return canonicalise(raw, schema) },
    checkpoint: async (discussion) => { options.snapshots?.push(structuredClone(discussion)) },
    id: options.id ?? (() => `discussion-${++nextID}`),
  })
}

function makeTranscriptManager(runtime: FakeRuntime, id: string) {
  const transcriptRegistry: DebateRegistry = {
    ...registry(),
    autoDebate: { enabled: true, maxRounds: 3, persistTranscripts: true },
  }
  return createManager({ runtime, registry: transcriptRegistry, canonicalise, checkpoint: checkpointTranscript, id: () => id })
}

async function completeTranscriptCycle(runtime: FakeRuntime, transcriptOwner: Owner, discussionID: string): Promise<void> {
  await runtime.waitForPrompts(3)
  const roundOneSaves = runtime.saveCount(transcriptOwner.sessionID)
  for (let index = 0; index < 3; index++) runtime.fulfill(index, firstAnswer(`round-one-${index}`))
  await runtime.waitForSaves(transcriptOwner, roundOneSaves + 3)
  await runtime.waitForPrompts(6)
  const roundTwoSaves = runtime.saveCount(transcriptOwner.sessionID)
  for (let index = 3; index < 6; index++) runtime.fulfill(index, answer(`round-two-${index}`, { stop: true }))
  await runtime.waitForSaves(transcriptOwner, roundTwoSaves + 4)
  await runtime.waitForState(transcriptOwner, (state) => state.discussions.some((item) => item.id === discussionID
    && item.status === "awaiting-evaluation" && item.results.some((result) => result.cycle === 1)))
}

async function finishRound(
  runtime: FakeRuntime,
  calls: readonly number[],
  output: (index: number) => string,
  final = false,
): Promise<void> {
  const saves = runtime.saveCount(owner.sessionID)
  for (const index of calls) runtime.fulfill(index, output(index))
  await runtime.waitForSaves(owner, saves + calls.length + (final ? 1 : 0))
}

test("start persists initial state and member IDs before prompts, then returns during two independent background panels", async () => {
  const runtime = new FakeRuntime()
  const canonicalised: string[] = []
  const manager = makeManager(runtime, { canonicalised })
  const first = await manager.start(owner, brief)
  assert.equal(first.panel.length, 3)
  await runtime.waitForPrompts(3)
  const second = await manager.start(owner, { ...brief, question: "A separate question" })
  await runtime.waitForPrompts(6)

  assert.equal(first.status, "running")
  assert.equal(second.status, "running")
  assert.ok(runtime.promptCalls.every((call) => !call.settled))
  assert.equal(new Set([...first.panel, ...second.panel].map((member) => member.sessionID)).size, 6)
  assert.equal(first.panel.length, 3)
  assert.equal(second.panel.length, 3)
  for (const discussion of [first, second]) {
    const promptIndex = runtime.calls.findIndex((call) => call.method === "prompt" && discussion.panel.some((member) => member.sessionID === call.sessionID))
    assert.ok(runtime.saveLog.some(({ callIndex, state }) => callIndex < promptIndex
      && state.discussions.some((item) => item.id === discussion.id && item.panel.length === 3)))
  }

  // Finish the two panels in a completion order different from dispatch order.
  const before = runtime.promptCalls.length
  runtime.fulfill(2, firstAnswer("third-first"))
  runtime.fulfill(4, firstAnswer("second-second"))
  await runtime.waitForSaves(owner, runtime.saveCount(owner.sessionID) + 2)
  assert.equal(runtime.promptCalls.length, before)
  runtime.fulfill(1, firstAnswer("second-first"))
  runtime.fulfill(5, firstAnswer("third-second"))
  runtime.fulfill(0, firstAnswer("first-first"))
  await runtime.waitForSaves(owner, runtime.saveCount(owner.sessionID) + 3)
  await runtime.waitForPrompts(9)
  assert.equal(canonicalised.length, 5)
  assert.ok(runtime.promptCalls.slice(6, 9).every((call) => /round\s+2/i.test(call.text)))
  assert.ok(runtime.promptCalls.slice(6, 9).every((call) => first.panel.some((member) => member.sessionID === call.member.sessionID)))
  runtime.fulfill(3, firstAnswer("first-second"))
  await runtime.waitForSaves(owner, runtime.saveCount(owner.sessionID) + 1)
  await runtime.waitForPrompts(12)
  assert.equal(canonicalised.length, 6)
  assert.ok(runtime.promptCalls.slice(9, 12).every((call) => second.panel.some((member) => member.sessionID === call.member.sessionID)))
  const finalSaves = runtime.saveCount(owner.sessionID)
  for (const index of [11, 10, 9, 8, 7, 6]) runtime.fulfill(index, answer(`final-${index}`, { stop: true }))
  await runtime.waitForSaves(owner, finalSaves + 8)
  for (const discussion of [first, second]) {
    const result = (await manager.status(owner, discussion.id))[0].results[0]
    assert.deepEqual(result.turns.filter((turn) => turn.round === 2).map((turn) => turn.participant), ["one", "two", "three"])
  }
  await manager.dispose()
})

test("concurrent admitted starts serialize conversation state without dropping either discussion", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime, { id: (() => { let id = 0; return () => `concurrent-${++id}` })() })
  const [first, second] = await Promise.all([
    manager.start(owner, brief),
    manager.start(owner, { ...brief, question: "Concurrent question" }),
  ])
  await runtime.waitForPrompts(6)

  assert.equal(runtime.state(owner).discussions.length, 2)
  assert.deepEqual(new Set(runtime.state(owner).discussions.map((discussion) => discussion.id)), new Set([first.id, second.id]))
  assert.equal(runtime.state(owner).discussions.reduce((count, discussion) => count + discussion.panel.length, 0), 6)
  await manager.dispose()
})

test("resume rebases its discussion so another discussion's committed result and outbox survive", async () => {
  const runtime = new FakeRuntime()
  const paused = pausedDiscussion("paused-A", "paused-A-child")
  runtime.states.set(owner.sessionID, { version: 1, discussions: [paused], outbox: [
    { id: "auto-debate:paused-A:cycle:1", discussionID: paused.id, cycle: 1, state: "acknowledged" },
  ] })
  const manager = makeManager(runtime)
  await manager.recover(owner)
  const other = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)

  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.reconcileBlock = { sessionIDs: new Set(paused.panel.map((member) => member.sessionID)), entered, release }
  const resuming = manager.resume(owner, paused.id, "Focus on the latest measurement.")
  await entered.promise

  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`other-independent-${index}`))
  await runtime.waitForPrompts(6)
  await finishRound(runtime, [3, 4, 5], (index) => answer(`other-final-${index}`, { stop: true }), true)
  await runtime.waitForState(owner, (state) => state.discussions.some((discussion) => discussion.id === other.id
    && discussion.status === "awaiting-evaluation" && discussion.results.some((result) => result.cycle === 1))
    && state.outbox.some((item) => item.discussionID === other.id && item.cycle === 1))
  const committed = runtime.state(owner).discussions.find((discussion) => discussion.id === other.id)!
  assert.equal(committed.status, "awaiting-evaluation")
  assert.equal(committed.results[0].turns.length, 6)

  release.resolve()
  await resuming
  await runtime.waitForPrompts(9)
  const afterResume = runtime.state(owner)
  const preserved = afterResume.discussions.find((discussion) => discussion.id === other.id)!
  assert.equal(preserved.status, "awaiting-evaluation")
  assert.deepEqual(preserved.results, committed.results)
  assert.ok(afterResume.outbox.some((item) => item.discussionID === other.id && item.cycle === 1))
  await manager.dispose()
})

test("continuation inspection cannot overwrite a saved batch cancellation or omit any selected stop", async (t) => {
  for (const outcome of ["thrown", "unsafe", "successful"] as const) {
    for (const stop of ["confirmed", "unconfirmed"] as const) await t.test(`${outcome} inspection, ${stop} stops`, async () => {
      const runtime = new FakeRuntime()
      const paused = pausedDiscussion("inspection-target", "session")
      paused.panel = paused.panel.map((member) => ({ ...member, sessionID: `session-${member.participant.agent}` }))
      const resolved = { ...pausedDiscussion("unrelated-resolved", "resolved"), status: "resolved" as const,
        evaluations: [{ cycle: 1, conclusion: "Resolved", caveats: [], rationale: "No further consultation is needed", next: "act" as const }] }
      const otherOwner = { ...owner, sessionID: "inspection-other-owner" }
      const foreign = { ...pausedDiscussion("foreign-paused", "foreign"), owner: otherOwner }
      runtime.states.set(owner.sessionID, { version: 1, discussions: [paused, resolved], outbox: [] })
      runtime.states.set(otherOwner.sessionID, { version: 1, discussions: [foreign], outbox: [] })
      const manager = makeManager(runtime)
      await manager.recover(owner)
      await manager.recover(otherOwner)
      if (stop === "unconfirmed") for (const member of paused.panel.slice(1)) runtime.failAbortSessions.add(member.sessionID)
      let cancelling: Promise<void> | undefined
      let savedFence: Discussion | undefined
      runtime.reconcileParticipant = async (inspectionOwner, member) => {
        runtime.calls.push({ method: "reconcileParticipant", sessionID: member.sessionID })
        if (!cancelling) {
          cancelling = manager.cancel(inspectionOwner, "all", "explicit-stop")
          // Observe the actual committed batch fence during the inspection, without
          // holding a reconciliation gate or issuing any off control.
          await runtime.waitForState(inspectionOwner, (state) => state.discussions.some((discussion) => discussion.id === paused.id
            && discussion.status === "cancelled" && discussion.generation === 1 && discussion.cancellation?.pendingSessionIDs.length === 3))
          savedFence = runtime.state(inspectionOwner).discussions.find((discussion) => discussion.id === paused.id)
          if (outcome === "thrown") throw new Error("Participant-history lookup failed")
          if (outcome === "unsafe") return { sessionID: member.sessionID, state: "uncertain", messageIDs: [], reason: "Participant-history lookup failed" }
        }
        // Failed inspections use the native-like rule that a now-cancelled
        // checkpoint cannot prove continuation. Success models an older valid
        // observation returned after the cancellation superseded it.
        return { sessionID: member.sessionID, state: "exhausted", canContinue: outcome === "successful" }
      }
      try {
        await assert.rejects(manager.resume(owner, paused.id, "Inspect the saved panel before continuation"), /cancelled|interrupted/i)
        assert.ok(cancelling)
        await cancelling
        assert.equal(savedFence?.status, "cancelled")
        assert.equal(savedFence?.generation, 1)
        assert.deepEqual(savedFence?.cancellation, { pendingSessionIDs: ["session-one", "session-two", "session-three"], errors: [] })
        const latest = (await manager.status(owner, paused.id))[0]
        assert.equal(latest.status, "cancelled", `stale writeback after ${outcome}; aborts=${runtime.aborted.join(",")}`)
        assert.equal(latest.generation, 1)
        assert.deepEqual(runtime.aborted.toSorted(), ["session-one", "session-three", "session-two"])
        assert.ok(runtime.abortObservations.every((value) => value.status === "cancelled" && value.generation === 1))
        assert.deepEqual(latest.cancellation, stop === "confirmed" ? { pendingSessionIDs: [], errors: [] } : {
          pendingSessionIDs: ["session-two", "session-three"],
          errors: ["session-two: abort unconfirmed for session-two", "session-three: abort unconfirmed for session-three"],
        })
        assert.deepEqual(runtime.state(owner).discussions.find((discussion) => discussion.id === paused.id), latest)
        assert.equal(runtime.saveLog.some(({ state }) => state.discussions.some((discussion) => discussion.id === paused.id
          && discussion.status === "interrupted")), false, "no asynchronous result may persist the superseded snapshot")
        assert.deepEqual(latest.results, paused.results)
        assert.deepEqual(latest.evaluations, paused.evaluations)
        assert.deepEqual((await manager.status(owner, resolved.id))[0], resolved)
        assert.deepEqual((await manager.status(otherOwner))[0], foreign)
        assert.equal(runtime.promptCalls.length, 0)
        assert.equal(runtime.created.length, 0)
      } finally {
        if (cancelling) await cancelling
        for (let index = 0; index < runtime.promptCalls.length; index++) runtime.fulfill(index, answer("cleanup", { stop: true }))
        await manager.dispose()
      }
    })
  }
})

test("unsafe continuation inspection without cancellation still records the normal interruption", async (t) => {
  for (const outcome of ["thrown", "unsafe"] as const) await t.test(outcome, async () => {
    const runtime = new FakeRuntime()
    const paused = pausedDiscussion("normally-unsafe", "unsafe-session")
    runtime.states.set(owner.sessionID, { version: 1, discussions: [paused], outbox: [] })
    const manager = makeManager(runtime)
    await manager.recover(owner)
    runtime.reconcileParticipant = async (_owner, member) => {
      if (member.sessionID === paused.panel[0].sessionID) {
        if (outcome === "thrown") throw new Error("Participant-history lookup failed")
        return { sessionID: member.sessionID, state: "uncertain", messageIDs: [], reason: "Participant-history lookup failed" }
      }
      return { sessionID: member.sessionID, state: "exhausted", canContinue: true }
    }
    try {
      await assert.rejects(manager.resume(owner, paused.id, "Inspect prior history"), /unconfirmed.*interrupted/i)
      const interrupted = (await manager.status(owner, paused.id))[0]
      assert.equal(interrupted.status, "interrupted")
      assert.equal(interrupted.generation, 1)
      assert.deepEqual(interrupted.cancellation, { pendingSessionIDs: ["unsafe-session-0"],
        errors: ["unsafe-session-0: Participant-history lookup failed"] })
      assert.deepEqual(runtime.state(owner).discussions[0], interrupted)
      assert.deepEqual(interrupted.results, paused.results)
      assert.deepEqual(interrupted.evaluations, paused.evaluations)
      assert.equal(runtime.promptCalls.length, 0)
    } finally { await manager.dispose() }
  })
})

test("shutdown waits for an admitted start at the policy lookup fence and prevents later child work", async () => {
  const runtime = new FakeRuntime()
  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.restrictionsBlock = { entered, release }
  const manager = makeManager(runtime)
  const starting = manager.start(owner, brief)
  await entered.promise

  let disposeReturned = false
  const disposing = manager.dispose().then(() => { disposeReturned = true })
  await Promise.resolve()
  const returnedBeforePolicyLookup = disposeReturned
  release.resolve()
  const startOutcome = await Promise.allSettled([starting])
  await disposing

  // If a regression dispatches anyway, settle its deferred fake prompts so the RED case itself cleans up.
  if (runtime.promptCalls.length > 0) {
    for (let index = 0; index < runtime.promptCalls.length; index++) runtime.failPrompt(index)
    await runtime.waitForPrompts(6)
    for (let index = 3; index < runtime.promptCalls.length; index++) runtime.failPrompt(index)
    await runtime.waitForState(owner, (state) => state.discussions.some((discussion) => discussion.status === "awaiting-evaluation"))
  }

  assert.equal(returnedBeforePolicyLookup, false)
  assert.equal(startOutcome[0].status, "rejected")
  assert.equal(runtime.created.length, 0)
  assert.equal(runtime.promptCalls.length, 0)
  assert.equal(runtime.calls.some((call) => call.method === "save"), false)
})

test("dispose fences a running round before waiting on another admitted start", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime, { maxRounds: 5 })
  const active = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`active-first-${index}`))
  await runtime.waitForPrompts(6)

  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.restrictionsBlock = { entered, release }
  const pendingStart = manager.start(owner, { ...brief, question: "Admission held through shutdown" })
  await entered.promise
  let disposeReturned = false
  const disposing = manager.dispose().then(() => { disposeReturned = true })
  await Promise.resolve()
  const activeStatusAtShutdown = (await manager.status(owner, active.id))[0].status

  for (const index of [3, 4, 5]) runtime.fulfill(index, answer(`active-second-${index}`))
  let dispatchedAnotherRound = false
  if (activeStatusAtShutdown === "running") {
    await runtime.waitForPrompts(9)
    dispatchedAnotherRound = true
  }
  release.resolve()
  const startOutcome = await Promise.allSettled([pendingStart])
  await disposing
  for (let index = 6; index < runtime.promptCalls.length; index++) runtime.failPrompt(index)

  assert.equal(disposeReturned, true)
  assert.equal(activeStatusAtShutdown, "interrupted")
  assert.equal(dispatchedAnotherRound, false)
  assert.equal(startOutcome[0].status, "rejected")
  assert.equal(runtime.created.length, 3)
  assert.equal(runtime.promptCalls.length, 6)
})

test("shutdown records and aborts a child created by an in-flight admission before returning", async () => {
  const runtime = new FakeRuntime()
  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.createBlock = { entered, release }
  const manager = makeManager(runtime)
  const starting = manager.start(owner, brief)
  await entered.promise
  const disposing = manager.dispose()
  release.resolve()
  const outcome = await Promise.allSettled([starting])
  await disposing

  assert.equal(outcome[0].status, "rejected")
  assert.equal(runtime.created.length, 1)
  assert.deepEqual(runtime.aborted, [runtime.created[0].sessionID])
  assert.equal(runtime.promptCalls.length, 0)
  const interrupted = runtime.state(owner).discussions[0]
  assert.equal(interrupted.status, "interrupted")
  assert.deepEqual(interrupted.panel.map((member) => member.sessionID), [runtime.created[0].sessionID])
  assert.deepEqual(interrupted.cancellation?.pendingSessionIDs, [])
})

test("shutdown waits for a resume reconciliation and prevents its later prompt dispatch", async () => {
  const runtime = new FakeRuntime()
  const paused = pausedDiscussion("paused-shutdown", "paused-shutdown-child")
  runtime.states.set(owner.sessionID, { version: 1, discussions: [paused], outbox: [] })
  const manager = makeManager(runtime)
  await manager.recover(owner)

  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.reconcileBlock = { sessionIDs: new Set(paused.panel.map((member) => member.sessionID)), entered, release }
  const resuming = manager.resume(owner, paused.id, "Resume with the recorded evidence.")
  await entered.promise

  let disposeReturned = false
  const disposing = manager.dispose().then(() => { disposeReturned = true })
  await Promise.resolve()
  const returnedBeforeReconciliation = disposeReturned
  release.resolve()
  const resumeOutcome = await Promise.allSettled([resuming])
  await disposing

  if (runtime.promptCalls.length > 0) {
    for (let index = 0; index < runtime.promptCalls.length; index++) runtime.failPrompt(index)
    await runtime.waitForPrompts(6)
    for (let index = 3; index < runtime.promptCalls.length; index++) runtime.failPrompt(index)
    await runtime.waitForState(owner, (state) => state.discussions[0].status === "awaiting-evaluation")
  }

  assert.equal(returnedBeforeReconciliation, false)
  assert.equal(resumeOutcome[0].status, "rejected")
  assert.equal(runtime.promptCalls.length, 0)
  assert.equal(runtime.state(owner).discussions[0].status, "paused")
})

test("continuation requires evaluation, survives automatic-off, uses original IDs and carries explicit feedback", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  const ids = started.panel.map((member) => member.sessionID)
  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`independent-${index}`))
  await runtime.waitForPrompts(6)
  await finishRound(runtime, [3, 4, 5], (index) => answer(`stop-${index}`, { stop: true }), true)
  const promptsBeforeEvaluation = runtime.promptCalls.length
  await runtime.waitForDeliveries(1)
  await runtime.waitForState(owner, (state) => state.outbox[0]?.state === "sent")
  const awaiting = (await manager.status(owner, started.id))[0]
  assert.equal(awaiting.status, "awaiting-evaluation")
  assert.equal(awaiting.results[0].consensus, false)
  assert.equal(runtime.promptCalls.length, promptsBeforeEvaluation)
  assert.equal(runtime.state(owner).outbox[0].state, "sent")

  await manager.evaluate(owner, started.id, {
    cycle: 1, conclusion: "Continue with new evidence", caveats: [], rationale: "The setting changed.",
    next: "continue", feedback: "Use the updated cost limit and compare option B again.",
  })
  await manager.control(owner, { action: "off" })
  await assert.rejects(manager.start(owner, brief), /disabled/i)
  const resumed = await manager.resume(owner, started.id, "Use the updated cost limit and compare option B again.")
  await runtime.waitForPrompts(9)

  assert.equal(resumed.cycle, 2)
  assert.equal(resumed.status, "running")
  assert.deepEqual(resumed.panel.map((member) => member.sessionID), ids)
  assert.ok(runtime.promptCalls.slice(6).every((call) => call.text.includes("updated cost limit")))
  assert.ok(runtime.promptCalls.slice(6).every((call) => /round2/.test(call.text)))
  await finishRound(runtime, [6, 7, 8], (index) => answer(`resumed-stop-${index}`, { stop: true }), true)
  const resumedResult = (await manager.status(owner, started.id))[0].results.at(-1)!
  assert.equal(resumedResult.cycle, 2)
  assert.equal(resumedResult.rounds, 1)
  await assert.rejects(manager.resume(owner, started.id, "duplicate"), /paused|running|resume/i)
  await manager.dispose()
})

test("configured maximum five is per-cycle and first resumed round uses dependent response schema", async () => {
  const runtime = new FakeRuntime()
  const seenSchemas: string[] = []
  const manager = createManager({ runtime, registry: registry(5), id: () => "five-rounds",
    checkpoint: async () => undefined,
    canonicalise: (raw, schema) => { seenSchemas.push(schema); return canonicalise(raw, schema) } })
  const started = await manager.start(owner, brief)
  for (let round = 1; round <= 5; round++) {
    const first = (round - 1) * 3
    await runtime.waitForPrompts(first + 3)
    await finishRound(runtime, [first, first + 1, first + 2], (index) => round === 1
      ? firstAnswer(`round-${round}-${index}`)
      : answer(`round-${round}-${index}`), round === 5)
  }
  const result = (await manager.status(owner, started.id))[0].results[0]
  assert.equal(result.rounds, 5)
  assert.deepEqual(seenSchemas.slice(0, 3), ["round1", "round1", "round1"])
  assert.ok(seenSchemas.slice(3).every((schema) => schema === "round2"))
  assert.equal(runtime.promptCalls.length, 15)
  await manager.dispose()
})

test("unanimous consensus is separate from stop, and disagreement continues to the round limit", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime, { maxRounds: 3 })
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`one-${index}`))
  await runtime.waitForPrompts(6)
  await finishRound(runtime, [3, 4, 5], (index) => answer(`two-${index}`, {
    consensus: index !== 4,
    stop: index !== 5,
  }))
  await runtime.waitForPrompts(9)
  await finishRound(runtime, [6, 7, 8], (index) => answer(`three-${index}`, { consensus: true, stop: true }), true)
  const result = (await manager.status(owner, started.id))[0].results[0]
  assert.equal(result.rounds, 3)
  assert.equal(result.consensus, true)
  assert.equal(result.status, "complete")
  await manager.dispose()
})

test("one unusable response retries once, then completes partially without replacing the participant", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  const saves = runtime.saveCount(owner.sessionID)
  runtime.fulfill(0, firstAnswer("valid one"))
  runtime.failPrompt(1)
  runtime.fulfill(2, firstAnswer("valid three"))
  await runtime.waitForSaves(owner, saves + 2)
  await runtime.waitForPrompts(4)
  assert.equal(runtime.promptCalls[3].member.sessionID, started.panel[1].sessionID)
  runtime.fulfill(3, "not formatter output")
  await runtime.waitForSaves(owner, runtime.saveCount(owner.sessionID) + 1)
  const state = runtime.state(owner)
  const discussion = state.discussions.find((item) => item.id === started.id)!
  assert.equal(discussion.status, "awaiting-evaluation")
  assert.equal(discussion.results[0].status, "partial")
  assert.deepEqual(discussion.results[0].turns.map((turn) => turn.participant), ["one", "three"])
  assert.equal(discussion.results[0].failures.length, 1)
  assert.equal(discussion.panel.length, 3)
  assert.equal(runtime.created.length, 3)
  assert.equal(runtime.promptCalls.length, 4)
  await manager.dispose()
})

test("all three participants exhausted after one retry produce a partial result with no consensus", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  for (let index = 0; index < 3; index++) runtime.failPrompt(index)
  await runtime.waitForPrompts(6)
  for (let index = 3; index < 6; index++) runtime.failPrompt(index)
  await runtime.waitForSaves(owner, runtime.saveCount(owner.sessionID) + 1)
  const state = runtime.state(owner)
  const result = state.discussions.find((item) => item.id === started.id)!.results[0]
  assert.equal(result.status, "partial")
  assert.equal(result.turns.length, 0)
  assert.equal(result.failures.length, 3)
  assert.equal(result.consensus, false)
  assert.equal(runtime.promptCalls.length, 6)
  await manager.dispose()
})

test("busy idle races and duplicate idle events retain then batch pending results exactly once", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const first = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  const second = await manager.start(owner, { ...brief, question: "Second result" })
  await runtime.waitForPrompts(6)
  const saves = runtime.saveCount(owner.sessionID)
  for (let index = 0; index < 6; index++) runtime.fulfill(index, firstAnswer(index < 3 ? `first-${index}` : `second-${index}`))
  await runtime.waitForSaves(owner, saves + 6)
  await runtime.waitForPrompts(12)
  runtime.ownerIdle = false
  await finishRound(runtime, [6, 7, 8, 9, 10, 11], (index) => answer(`followup-${index}`, { stop: true }), true)
  await manager.onIdle(owner.sessionID)
  assert.equal(runtime.deliveries.length, 0)
  assert.ok(runtime.state(owner).outbox.every((item) => item.state === "pending"))

  runtime.ownerIdle = true
  await Promise.all([manager.onIdle(owner.sessionID), manager.onIdle(owner.sessionID)])
  assert.equal(runtime.deliveries.length, 1)
  assert.deepEqual(runtime.deliveries[0].intent.outboxIDs, runtime.deliveries[0].intent.outboxIDs.toSorted())
  assert.equal(runtime.deliveries[0].intent.outboxIDs.length, 2)
  assert.ok(runtime.deliveries[0].intent.text.includes(first.id))
  assert.ok(runtime.deliveries[0].intent.text.includes(second.id))
  assert.ok(runtime.state(owner).outbox.every((item) => item.state === "sent"))
  assert.equal(runtime.aborted.length, 0)
  await manager.dispose()
})

test("result and pending outbox are durably saved before delivery is invoked", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`saved-first-${index}`))
  await runtime.waitForPrompts(6)

  const entered = deferred<void>()
  const release = deferred<void>()
  const isResultCheckpoint = (state: ConversationState) => state.discussions.some((discussion) =>
    discussion.id === started.id && discussion.status === "awaiting-evaluation"
      && discussion.results.some((result) => result.cycle === 1 && result.status === "complete"))
    && state.outbox.some((item) => item.discussionID === started.id && item.cycle === 1 && item.state === "pending")
  runtime.saveBlock = { predicate: isResultCheckpoint, entered, release }
  for (const index of [3, 4, 5]) runtime.fulfill(index, answer(`saved-final-${index}`, { stop: true }))
  await entered.promise

  const finalAttempt = runtime.saveAttempts.find((attempt) => isResultCheckpoint(attempt.state))!
  assert.ok(finalAttempt)
  assert.equal(finalAttempt.succeeded, false)
  const stagedDiscussion = finalAttempt.state.discussions.find((discussion) => discussion.id === started.id)!
  assert.equal(stagedDiscussion.results[0].turns.length, 6)
  assert.ok(finalAttempt.state.outbox.some((item) => item.id === `auto-debate:${started.id}:cycle:1` && item.state === "pending"))
  assert.equal(runtime.deliveries.length, 0)
  assert.equal(runtime.calls.some((call) => call.method === "deliver"), false)
  assert.ok(!runtime.state(owner).outbox.some((item) => item.discussionID === started.id && item.cycle === 1))

  release.resolve()
  await runtime.waitForDeliveries(1)
  await runtime.waitForState(owner, (state) => state.outbox.some((item) => item.discussionID === started.id && item.state === "sent"))
  const persisted = runtime.saveLog.find((snapshot) => snapshot.callIndex === finalAttempt.callIndex)!
  assert.equal(finalAttempt.succeeded, true)
  assert.deepEqual(persisted.state.discussions.find((discussion) => discussion.id === started.id)?.results, stagedDiscussion.results)
  assert.ok(persisted.state.outbox.some((item) => item.id === `auto-debate:${started.id}:cycle:1` && item.state === "pending"))
  assert.ok(runtime.deliveries[0].callIndex > finalAttempt.callIndex)
  assert.deepEqual(runtime.deliveries[0].intent.outboxIDs, [`auto-debate:${started.id}:cycle:1`])
  assert.ok(runtime.deliveries[0].intent.text.includes(started.id))
  await manager.dispose()
})

test("a failed result-plus-outbox checkpoint cannot trigger notification delivery", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`failure-first-${index}`))
  await runtime.waitForPrompts(6)
  const isResultCheckpoint = (state: ConversationState) => state.discussions.some((discussion) =>
    discussion.id === started.id && discussion.status === "awaiting-evaluation"
      && discussion.results.some((result) => result.cycle === 1 && result.status === "complete"))
    && state.outbox.some((item) => item.discussionID === started.id && item.cycle === 1 && item.state === "pending")
  const attemptsBeforeFinalRound = runtime.saveAttempts.length
  runtime.failSavePredicate = isResultCheckpoint
  for (const index of [3, 4, 5]) runtime.fulfill(index, answer(`failure-final-${index}`, { stop: true }))
  await runtime.waitForAborts(3)

  const failedAttempt = runtime.saveAttempts.slice(attemptsBeforeFinalRound).find((attempt) => isResultCheckpoint(attempt.state))!
  assert.ok(failedAttempt)
  assert.equal(failedAttempt.succeeded, false)
  assert.equal(failedAttempt.state.discussions.find((discussion) => discussion.id === started.id)?.results[0].status, "complete")
  assert.ok(failedAttempt.state.outbox.some((item) => item.discussionID === started.id && item.state === "pending"))
  assert.equal(runtime.deliveries.length, 0)
  assert.equal(runtime.calls.some((call) => call.method === "deliver"), false)
  assert.equal((await manager.status(owner, started.id))[0].status, "interrupted")
  await manager.onIdle(owner.sessionID)
  assert.equal(runtime.deliveries.length, 0)
  assert.ok(!runtime.state(owner).outbox.some((item) => item.discussionID === started.id && item.cycle === 1))
  await manager.dispose()
})

test("ambiguous result delivery remains visibly uncertain and is lookup-reconciled without redispatch", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  for (let index = 0; index < 3; index++) runtime.fulfill(index, firstAnswer(`turn-${index}`))
  const afterFirstRound = runtime.saveCount(owner.sessionID)
  await runtime.waitForSaves(owner, afterFirstRound + 3)
  await runtime.waitForPrompts(6)
  runtime.ownerIdle = false
  await finishRound(runtime, [3, 4, 5], (index) => answer(`stop-${index}`, { stop: true }), true)
  // The fake returns uncertainty for the exact frozen intent, matching the adapter's reconciliation contract.
  runtime.deliver = async (receivedOwner, intent) => {
    const result: DeliveryReconciliation = { delivery: structuredClone(intent), messageID: "native-unknown",
      state: "uncertain", reason: "Native delivery response was lost" }
    runtime.calls.push({ method: "deliver" })
    runtime.deliveries.push({ owner: structuredClone(receivedOwner), intent: structuredClone(intent), callIndex: runtime.calls.length - 1 })
    runtime.reconciliations.set(intent.id, structuredClone(result))
    return result
  }
  runtime.ownerIdle = true
  await manager.onIdle(owner.sessionID)
  const status = (await manager.status(owner, started.id))[0]
  assert.deepEqual(status.deliveryUncertainCycles, [{ cycle: 1, reason: "Native delivery response was lost" }])
  assert.match(await manager.control(owner, { action: "status" }), /delivery uncertain/)
  await manager.onIdle(owner.sessionID)
  assert.equal(runtime.deliveries.length, 1)
  assert.equal(runtime.calls.filter((call) => call.method === "reconcileDeliveries").length >= 2, true)
  assert.equal(runtime.state(owner).outbox[0].state, "pending")
  await manager.evaluate(owner, started.id, { cycle: 1, conclusion: "Use results from status", caveats: [],
    rationale: "Delivery remains unconfirmed.", next: "report-unresolved" })
  assert.equal(runtime.state(owner).outbox[0].state, "acknowledged")
  await manager.dispose()
})

test("recovery interrupts uncertain in-flight work without replay and preserves IDs, override and outbox", async () => {
  const runtime = new FakeRuntime()
  const panel: PanelMember[] = participants.map((participant, index) => ({
    participant, runtimeAgent: participant.agent, sessionID: `restored-${index}`,
  }))
  const discussion: Discussion = {
    id: "restored-discussion", owner, config: { enabled: true, maxRounds: 5, persistTranscripts: true }, brief,
    panel, status: "running", generation: 4, cycle: 2, results: [], evaluations: [],
    pendingTurns: [{ participant: "one", cycle: 2, round: 1, text: "saved finding" }], followups: [],
  }
  runtime.states.set(owner.sessionID, { version: 1, override: false, discussions: [discussion],
    outbox: [{ id: "older-result", discussionID: discussion.id, cycle: 1, state: "pending" }] })
  runtime.participantStates.set(panel[1].sessionID, { sessionID: panel[1].sessionID, state: "uncertain", messageIDs: ["msg-open"], reason: "unclosed start" })
  const manager = makeManager(runtime)

  await manager.recover(owner)
  const recovered = runtime.state(owner)
  assert.equal(recovered.override, false)
  assert.equal(recovered.discussions[0].status, "interrupted")
  assert.equal(recovered.discussions[0].generation, 5)
  assert.deepEqual(recovered.discussions[0].panel.map((member) => member.sessionID), panel.map((member) => member.sessionID))
  assert.deepEqual(recovered.discussions[0].pendingTurns, [])
  assert.deepEqual(recovered.discussions[0].results[0].turns, discussion.pendingTurns)
  assert.deepEqual(recovered.outbox, [{ id: "older-result", discussionID: discussion.id, cycle: 1, state: "pending" }])
  assert.equal(runtime.promptCalls.length, 0)
  assert.equal(runtime.calls.some((call) => call.method === "createParticipant"), false)
  await manager.dispose()
})

test("cross-owner management is rejected and status does not initialise absent state", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  assert.deepEqual(await manager.status(owner), [])
  await manager.recover(owner)
  await manager.onIdle(owner.sessionID)
  assert.equal(runtime.states.has(owner.sessionID), false)
  assert.equal(runtime.calls.some((call) => call.method === "save"), false)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await assert.rejects(manager.evaluate({ ...owner, sessionID: "other-owner" }, started.id, {
    cycle: 1, conclusion: "Wrong owner", caveats: [], rationale: "Must reject", next: "act",
  }), /owner|unknown/i)
  await manager.dispose()

  const disabled = new FakeRuntime()
  const disabledManager = makeManager(disabled, { enabled: false })
  await assert.rejects(disabledManager.start(owner, brief), /disabled/i)
  assert.equal(disabled.calls.some((call) => call.method === "save"), false)
  assert.equal(disabled.created.length, 0)
  await disabledManager.dispose()
})

test("stop fences generation before abort, retains confirmed/pending stops, retries pending on busy and ignores late results", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  runtime.fulfill(0, firstAnswer("saved before the explicit stop"))
  await runtime.waitForSaves(owner, runtime.saveCount(owner.sessionID) + 1)
  const pending = started.panel[1].sessionID
  runtime.failAbortSessions.add(pending)
  await manager.cancel(owner, started.id, "explicit-stop")
  const cancelled = runtime.state(owner).discussions[0]
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.generation, started.generation + 1)
  assert.equal(cancelled.results.at(-1)?.status, "cancelled")
  assert.deepEqual(cancelled.results.at(-1)?.turns.map((turn) => turn.participant), ["one"])
  assert.deepEqual(cancelled.cancellation?.pendingSessionIDs, [pending])
  assert.ok(cancelled.cancellation?.errors.some((error) => error.includes(pending)))
  assert.deepEqual(runtime.aborted.slice(0, 3).toSorted(), started.panel.map((member) => member.sessionID).toSorted())
  assert.ok(runtime.abortObservations.slice(0, 3).every((observation) => observation.generation === started.generation + 1))
  assert.match(await manager.control(owner, { action: "status" }), /unconfirmed/)
  await manager.onBusy(pending)
  assert.deepEqual(runtime.state(owner).discussions[0].cancellation?.pendingSessionIDs, [pending])
  runtime.failAbortSessions.delete(pending)
  await manager.onIdle(pending)
  assert.deepEqual(runtime.state(owner).discussions[0].cancellation?.pendingSessionIDs, [])
  assert.equal(runtime.aborted.filter((sessionID) => sessionID === pending).length, 3)
  assert.match(await manager.control(owner, { action: "status" }), /cessations confirmed/)
  const saves = runtime.saveCount(owner.sessionID)
  for (let index = 0; index < 3; index++) runtime.fulfill(index, firstAnswer(`late-${index}`))
  await runtime.waitForSaves(owner, saves)
  assert.equal(runtime.state(owner).discussions[0].status, "cancelled")
  assert.equal(runtime.state(owner).outbox.length, 0)
  await manager.dispose()
})

test("user stop all cancels each owned discussion with generation and pending-stop accounting but leaves other owners untouched", async () => {
  const runtime = new FakeRuntime()
  const first = pausedDiscussion("owned-alpha", "alpha")
  const second = pausedDiscussion("owned-beta", "beta")
  const otherOwner = { ...owner, sessionID: "other-owner" }
  const foreign = { ...pausedDiscussion("foreign", "foreign"), owner: otherOwner }
  runtime.states.set(owner.sessionID, { version: 1, discussions: [first, second], outbox: [] })
  runtime.states.set(otherOwner.sessionID, { version: 1, discussions: [foreign], outbox: [] })
  const manager = makeManager(runtime)
  await manager.recover(owner)
  await manager.recover(otherOwner)
  const pending = second.panel[1].sessionID
  runtime.failAbortSessions.add(pending)
  const result = await manager.control(owner, parseControl("stop all"))
  assert.match(result, /owned-alpha: cancelled/)
  assert.match(result, /owned-beta: cancelled/)
  assert.match(result, /unconfirmed/)
  const stopped = await manager.status(owner)
  assert.ok(stopped.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1))
  assert.deepEqual(stopped[0].cancellation?.pendingSessionIDs, [])
  assert.deepEqual(stopped[1].cancellation?.pendingSessionIDs, [pending])
  assert.deepEqual(runtime.aborted.toSorted(), [...first.panel, ...second.panel].map((member) => member.sessionID).toSorted())
  assert.ok(runtime.abortObservations.every((value) => value.status === "cancelled" && value.generation === 1))
  assert.deepEqual((await manager.status(otherOwner))[0], foreign)
  await assert.rejects(manager.resume(owner, first.id, "Try after explicit stop"), /cancelled/)
  runtime.failAbortSessions.delete(pending)
  await manager.onIdle(pending)
  assert.deepEqual((await manager.status(owner, second.id))[0].cancellation?.pendingSessionIDs, [])
  assert.equal(runtime.promptCalls.length, 0)
  await manager.dispose()
})

test("active user stop all fences both panels before a held first cessation permits the other panel to finish its existing round", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const otherOwner = { ...owner, sessionID: "batch-other-owner" }
  const foreign = { ...pausedDiscussion("foreign-batch", "foreign-batch"), owner: otherOwner }
  runtime.states.set(otherOwner.sessionID, { version: 1, discussions: [foreign], outbox: [] })
  await manager.recover(otherOwner)
  const first = await manager.start(owner, brief)
  const second = await manager.start(owner, { ...brief, question: "Second active panel" })
  await runtime.waitForPrompts(6)
  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.abortBlock = { sessionID: first.panel[0].sessionID, entered, release }
  let stopReturned = false
  const stopping = manager.control(owner, parseControl("stop all")).then((value) => { stopReturned = true; return value })
  try {
    await entered.promise
    for (const index of [3, 4, 5]) runtime.fulfill(index, firstAnswer(`already-dispatched-${index}`))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const selected = await manager.status(owner)
    assert.ok(selected.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1),
      `all selected generations must be fenced, got ${selected.map((discussion) => discussion.status).join(",")}`)
    assert.equal(runtime.promptCalls.length, 6, "returning an already-dispatched round cannot schedule a new round after all-stop")
    assert.equal(stopReturned, false, "fencing is not a claim that the held cessation is confirmed")
    assert.deepEqual(selected[1].cancellation?.pendingSessionIDs, second.panel.map((member) => member.sessionID))
    const beforeAbort = runtime.calls.findIndex((call) => call.method === "abort")
    assert.ok(runtime.saveLog.some(({ callIndex, state }) => callIndex < beforeAbort
      && state.discussions.length === 2 && state.discussions.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1)))
    assert.deepEqual((await manager.status(otherOwner))[0], foreign)
  } finally {
    release.resolve()
    await stopping
    for (let index = 0; index < runtime.promptCalls.length; index++) runtime.fulfill(index, firstAnswer("cleanup late answer"))
    await manager.dispose()
  }
  const selected = await manager.status(owner)
  assert.ok(selected.every((discussion) => discussion.results.at(-1)?.reason === "explicit-stop"
    && discussion.cancellation?.pendingSessionIDs.length === 0 && discussion.cancellation.errors.length === 0))
  assert.equal(runtime.aborted.length, 6)
})

test("batch cancellation fences before pending persistence and keeps obsolete/pending accounting when persistence fails", async () => {
  for (const mode of ["held-write", "failed-write"] as const) {
    const runtime = new FakeRuntime()
    const manager = makeManager(runtime)
    const first = await manager.start(owner, brief)
    const second = await manager.start(owner, { ...brief, question: "Second selected active panel" })
    await runtime.waitForPrompts(6)
    const writeEntered = deferred<void>()
    const writeRelease = deferred<void>()
    const abortEntered = deferred<void>()
    const abortRelease = deferred<void>()
    runtime.abortBlock = { sessionID: first.panel[0].sessionID, entered: abortEntered, release: abortRelease }
    if (mode === "held-write") runtime.saveBlock = { predicate: (state) => state.discussions.every((discussion) => discussion.status === "cancelled"),
      entered: writeEntered, release: writeRelease }
    else {
      runtime.nextSaveFailures = 1
      for (const member of [...first.panel, ...second.panel]) runtime.failAbortSessions.add(member.sessionID)
    }
    let returned = false
    const stopping = manager.cancel(owner, "all", "obsolete").then(() => { returned = true })
    try {
      await (mode === "held-write" ? writeEntered.promise : abortEntered.promise)
      for (const index of [3, 4, 5]) runtime.fulfill(index, firstAnswer(`late-before-${mode}-${index}`))
      await new Promise<void>((resolve) => setImmediate(resolve))
      const selected = await manager.status(owner)
      assert.ok(selected.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1
        && discussion.results.at(-1)?.reason === "obsolete"), mode)
      assert.ok(selected.every((discussion) => discussion.cancellation?.pendingSessionIDs.length === 3), mode)
      assert.equal(runtime.promptCalls.length, 6, mode)
      assert.equal(returned, false, "neither pending write nor cessation is reported confirmed")
      if (mode === "held-write") assert.equal(runtime.aborted.length, 0, "the whole fenced batch is durably saved before abort")
      else assert.ok(selected.every((discussion) => discussion.cancellation!.errors.some((error) => error.includes("Checkpoint before child cancellation failed"))))
    } finally {
      writeRelease.resolve()
      await abortEntered.promise
      abortRelease.resolve()
      await stopping
      for (let index = 0; index < runtime.promptCalls.length; index++) runtime.fulfill(index, firstAnswer("cleanup"))
    }
    const selected = await manager.status(owner)
    assert.ok(selected.every((discussion) => discussion.status === "cancelled" && discussion.results.at(-1)?.reason === "obsolete"))
    if (mode === "held-write") {
      assert.ok(runtime.saveLog.at(-1)!.state.discussions.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1))
      assert.ok(selected.every((discussion) => discussion.cancellation?.pendingSessionIDs.length === 0 && discussion.cancellation.errors.length === 0))
    } else assert.ok(selected.every((discussion) => discussion.cancellation?.pendingSessionIDs.length === 3 && discussion.cancellation.errors.length > 0))
    for (const discussion of selected) await assert.rejects(manager.resume(owner, discussion.id, "Cannot reopen this cancelled batch"), /cancelled/)
    assert.equal(runtime.deliveries.length, 0)
    await manager.dispose()
  }
})

test("obsolete cancellation retains the actual checkpointTranscript record and accepts no late turn or further dispatch", async () => {
  const project = mkdtempSync(join("/tmp/opencode", "final-fix-obsolete-"))
  const transcriptOwner = { ...owner, directory: project }
  const runtime = new FakeRuntime()
  const id = "cfe823a3-8495-4093-9244-9cb68d08e721"
  const manager = makeTranscriptManager(runtime, id)
  try {
    const started = await manager.start(transcriptOwner, brief)
    await runtime.waitForPrompts(3)
    runtime.fulfill(0, firstAnswer("retained finding before the brief became obsolete"))
    await runtime.waitForState(transcriptOwner, (state) => state.discussions[0].pendingTurns.length === 1)
    const path = (await manager.status(transcriptOwner, id))[0].transcriptPath!
    const before = readFileSync(join(project, path), "utf8")
    await manager.cancel(transcriptOwner, id, "obsolete")
    await assert.rejects(manager.resume(transcriptOwner, id, "The stale assumption cannot justify continuation"), /cancelled/)
    for (let index = 1; index < 3; index++) runtime.fulfill(index, firstAnswer("late obsolete finding must not be accepted"))
    await new Promise<void>((resolve) => setImmediate(resolve)) // Process the deliberately returned late answers.
    const cancelled = (await manager.status(transcriptOwner, id))[0]
    assert.equal(cancelled.status, "cancelled")
    assert.equal(cancelled.generation, started.generation + 1)
    assert.equal(cancelled.results.at(-1)?.reason, "obsolete")
    assert.deepEqual(cancelled.results.at(-1)?.turns.map((turn) => turn.text), ["retained finding before the brief became obsolete"])
    assert.deepEqual(cancelled.cancellation, { pendingSessionIDs: [], errors: [] })
    assert.deepEqual(runtime.aborted.toSorted(), started.panel.map((member) => member.sessionID).toSorted())
    assert.equal(runtime.promptCalls.length, 3)
    assert.equal(runtime.created.length, 3)
    assert.equal(runtime.deliveries.length, 0)
    const record = readFileSync(join(project, path), "utf8")
    assert.ok(record.startsWith(before), "the saved record is retained append-only")
    assert.match(record, /\*\*Status:\*\* cancelled/)
    assert.match(record, /obsolete/)
    assert.match(record, /retained finding before the brief became obsolete/)
    assert.doesNotMatch(record, /late obsolete finding must not be accepted/)
  } finally {
    for (let index = 0; index < runtime.promptCalls.length; index++) runtime.fulfill(index, firstAnswer("cleanup"))
    await manager.dispose()
    rmSync(project, { recursive: true, force: true })
  }
})

test("initial and panel checkpoint failures fence prompts; partial child creation aborts without replacement", async () => {
  const initialFailure = new FakeRuntime()
  initialFailure.nextSaveFailures = 1
  const manager1 = makeManager(initialFailure)
  await assert.rejects(manager1.start(owner, brief), /checkpoint save failed/)
  assert.equal(initialFailure.created.length, 0)
  assert.equal(initialFailure.promptCalls.length, 0)

  const panelFailure = new FakeRuntime()
  const manager2 = makeManager(panelFailure)
  // Initial-state save succeeds; the first member-ID save fails.
  panelFailure.nextSaveFailures = 0
  const originalSave = panelFailure.save.bind(panelFailure)
  let saves = 0
  panelFailure.save = async (valueOwner, state) => {
    if (++saves === 2) throw new Error("member checkpoint failed")
    return originalSave(valueOwner, state)
  }
  await assert.rejects(manager2.start(owner, brief), /member checkpoint failed/)
  assert.equal(panelFailure.created.length, 1)
  assert.equal(panelFailure.promptCalls.length, 0)
  assert.deepEqual(panelFailure.aborted, [panelFailure.created[0].sessionID])

  const creationFailure = new FakeRuntime()
  creationFailure.failCreateAgents.add("two")
  creationFailure.failAbortSessions.add("child-1")
  const manager3 = makeManager(creationFailure)
  const incomplete = await manager3.start(owner, brief)
  assert.equal(incomplete.status, "awaiting-evaluation")
  assert.equal(incomplete.panel.length, 2)
  assert.equal(creationFailure.aborted.length, 2)
  assert.equal(creationFailure.promptCalls.length, 0)
  assert.equal(creationFailure.state(owner).discussions[0].results[0].status, "partial")
  assert.deepEqual(creationFailure.state(owner).discussions[0].cancellation?.pendingSessionIDs, ["child-1"])
  creationFailure.failAbortSessions.delete("child-1")
  await manager3.onBusy("child-1")
  assert.deepEqual(creationFailure.state(owner).discussions[0].cancellation?.pendingSessionIDs, [])
  await manager3.evaluate(owner, incomplete.id, { cycle: 1, conclusion: "Continue", caveats: [], rationale: "Keep findings.", next: "continue" })
  await assert.rejects(manager3.resume(owner, incomplete.id, "Continue with original evidence."), /panel is incomplete/i)
  assert.equal(creationFailure.created.length, 2)
  assert.equal(creationFailure.promptCalls.length, 0)
  assert.equal(creationFailure.state(owner).discussions[0].status, "interrupted")
  await Promise.all([manager1.dispose(), manager2.dispose(), manager3.dispose()])
})

test("paused exhausted members are not permanently aborted during shutdown", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await finishRound(runtime, [0, 1, 2], (index) => firstAnswer(`one-${index}`))
  await runtime.waitForPrompts(6)
  await finishRound(runtime, [3, 4, 5], (index) => answer(`stop-${index}`, { stop: true }), true)
  await manager.evaluate(owner, started.id, { cycle: 1, conclusion: "Investigate", caveats: [], rationale: "Need more data.", next: "investigate" })
  const abortsBefore = runtime.aborted.length
  await manager.dispose()
  assert.equal(runtime.aborted.length, abortsBefore)
  assert.equal(runtime.state(owner).discussions[0].status, "paused")
})

test("parent deletion cancels scheduling without checkpointing or recreating the deleted owner", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  const savesBeforeDelete = runtime.saveCount(owner.sessionID)
  await manager.onDeleted(owner.sessionID)
  assert.equal(runtime.saveCount(owner.sessionID), savesBeforeDelete)
  assert.deepEqual(runtime.aborted.toSorted(), started.panel.map((member) => member.sessionID).toSorted())
  await assert.rejects(manager.status(owner), /deleted/i)
})

test("parent deletion during child creation aborts the late-created child without saving or prompting", async () => {
  const runtime = new FakeRuntime()
  const entered = deferred<void>()
  const release = deferred<void>()
  runtime.createBlock = { entered, release }
  const manager = makeManager(runtime)
  const starting = manager.start(owner, brief)
  await entered.promise
  const savesAtDelete = runtime.saveCount(owner.sessionID)
  await manager.onDeleted(owner.sessionID)
  assert.equal(runtime.saveCount(owner.sessionID), savesAtDelete)
  release.resolve()
  const cancelled = await starting
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.panel.length, 1)
  assert.deepEqual(runtime.aborted, [cancelled.panel[0].sessionID])
  assert.equal(runtime.promptCalls.length, 0)
  assert.equal(runtime.saveCount(owner.sessionID), savesAtDelete)
})

test("shutdown interrupts active work and aborts its known panel but leaves paused sessions alone", async () => {
  const runtime = new FakeRuntime()
  const manager = makeManager(runtime)
  const started = await manager.start(owner, brief)
  await runtime.waitForPrompts(3)
  await manager.dispose()
  const interrupted = runtime.state(owner).discussions[0]
  assert.equal(interrupted.status, "interrupted")
  assert.equal(interrupted.generation, started.generation + 1)
  assert.deepEqual(runtime.aborted.toSorted(), started.panel.map((member) => member.sessionID).toSorted())
  assert.ok(runtime.abortObservations.every((observation) => observation.generation === interrupted.generation))
})

test("manager checkpoints transcript paths into status and saved state through evaluation", async () => {
  const project = mkdtempSync(join("/tmp/opencode", "automatic-transcript-manager-"))
  const transcriptOwner = { ...owner, directory: project }
  const runtime = new FakeRuntime()
  const discussionID = "b2ac59c3-78a1-46a1-8c1b-12a16f5e0001"
  const transcriptPath = `docs/debates/auto-${discussionID}.md`
  let manager: ReturnType<typeof createManager> | undefined
  try {
    manager = makeTranscriptManager(runtime, discussionID)
    await manager.start(transcriptOwner, brief)
    await runtime.waitForPrompts(3)

    const initialStatus = (await manager.status(transcriptOwner, discussionID))[0]
    assert.equal(initialStatus.transcriptPath, transcriptPath)
    assert.equal(initialStatus.transcriptError, undefined)
    assert.equal(runtime.state(transcriptOwner).discussions[0].transcriptPath, transcriptPath)
    assert.equal(existsSync(join(project, transcriptPath)), true)

    await completeTranscriptCycle(runtime, transcriptOwner, discussionID)
    await runtime.waitForDeliveries(1)
    assert.ok(runtime.deliveries[0].intent.text.includes(transcriptPath))

    await manager.evaluate(transcriptOwner, discussionID, {
      cycle: 1, conclusion: "Proceed with the staged rollout.", caveats: ["Watch latency."],
      rationale: "The first cycle provides enough evidence.", next: "act",
    })
    const evaluatedStatus = (await manager.status(transcriptOwner, discussionID))[0]
    const evaluatedSaved = runtime.state(transcriptOwner).discussions[0]
    assert.equal(evaluatedStatus.status, "resolved")
    assert.equal(evaluatedStatus.transcriptPath, transcriptPath)
    assert.equal(evaluatedStatus.transcriptError, undefined)
    assert.equal(evaluatedSaved.transcriptPath, transcriptPath)
    assert.equal(evaluatedSaved.evaluations[0].conclusion, "Proceed with the staged rollout.")
    assert.match(readFileSync(join(project, transcriptPath), "utf8"), /Proceed with the staged rollout\./)
  } finally {
    try { if (manager) await manager.dispose() }
    finally { rmSync(project, { recursive: true, force: true }) }
  }
})

test("manager checkpoints transcript errors without interrupting findings or retrying debate", async () => {
  const project = mkdtempSync(join("/tmp/opencode", "automatic-transcript-manager-error-"))
  const transcriptOwner = { ...owner, directory: project }
  const runtime = new FakeRuntime()
  const discussionID = "a27e35f8-f69d-4743-b62e-ae66c0f0c002"
  let manager: ReturnType<typeof createManager> | undefined
  try {
    writeFileSync(join(project, "docs"), "not a directory\n", { mode: 0o600 })
    manager = makeTranscriptManager(runtime, discussionID)
    await manager.start(transcriptOwner, brief)
    await runtime.waitForPrompts(3)

    const initialStatus = (await manager.status(transcriptOwner, discussionID))[0]
    assert.match(initialStatus.transcriptError ?? "", /transcript unavailable|docs directory/i)
    assert.equal(initialStatus.transcriptPath, undefined)
    assert.match(runtime.state(transcriptOwner).discussions[0].transcriptError ?? "", /transcript unavailable|docs directory/i)

    await completeTranscriptCycle(runtime, transcriptOwner, discussionID)
    await runtime.waitForDeliveries(1)
    assert.match(runtime.deliveries[0].intent.text, /transcriptError/)
    assert.doesNotMatch(runtime.deliveries[0].intent.text, /"transcriptPath"/)
    assert.equal(runtime.promptCalls.length, 6)

    await manager.evaluate(transcriptOwner, discussionID, {
      cycle: 1, conclusion: "Retain the findings despite the transcript failure.", caveats: [],
      rationale: "Transcript storage is secondary to the saved debate result.", next: "act",
    })
    const evaluatedStatus = (await manager.status(transcriptOwner, discussionID))[0]
    const evaluatedSaved = runtime.state(transcriptOwner).discussions[0]
    assert.equal(evaluatedStatus.status, "resolved")
    assert.match(evaluatedStatus.transcriptError ?? "", /transcript unavailable|docs directory/i)
    assert.equal(evaluatedStatus.transcriptPath, undefined)
    assert.match(evaluatedSaved.transcriptError ?? "", /transcript unavailable|docs directory/i)
    assert.equal(evaluatedSaved.results[0].turns.length, 6)
    assert.equal(evaluatedSaved.evaluations[0].conclusion, "Retain the findings despite the transcript failure.")
    assert.equal(runtime.promptCalls.length, 6)
  } finally {
    try { if (manager) await manager.dispose() }
    finally { rmSync(project, { recursive: true, force: true }) }
  }
})

test("manager clears a saved transcript link when its destination cannot be re-verified", async () => {
  const project = mkdtempSync(join("/tmp/opencode", "automatic-transcript-manager-replaced-"))
  const transcriptOwner = { ...owner, directory: project }
  const discussionID = "8b61a83f-5102-4bb8-a0d4-cd6ca19c4d37"
  const transcriptPath = `docs/debates/auto-${discussionID}.md`
  let manager: ReturnType<typeof createManager> | undefined
  try {
    const destination = join(project, transcriptPath)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, "unrelated replacement\n", { mode: 0o600 })
    const recorded: Discussion = {
      id: discussionID,
      owner: transcriptOwner,
      config: { enabled: true, maxRounds: 3, persistTranscripts: true },
      brief,
      panel: participants.map((participant, index) => ({ participant, sessionID: `existing-child-${index}`,
        runtimeAgent: participant.agent })),
      status: "awaiting-evaluation",
      generation: 0,
      cycle: 1,
      results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit",
        turns: participants.map((participant) => ({ participant: participant.agent, cycle: 1, round: 1, text: `saved ${participant.agent}` })),
        failures: [], consensus: false }],
      evaluations: [],
      pendingTurns: [],
      followups: [],
      transcriptPath,
    }
    const runtime = new FakeRuntime()
    runtime.states.set(transcriptOwner.sessionID, { version: 1, discussions: [recorded], outbox: [] })
    manager = createManager({
      runtime,
      registry: { ...registry(), autoDebate: { enabled: true, maxRounds: 3, persistTranscripts: true } },
      canonicalise,
      checkpoint: checkpointTranscript,
      id: () => discussionID,
    })

    await manager.evaluate(transcriptOwner, discussionID, {
      cycle: 1, conclusion: "Keep the saved result.", caveats: [], rationale: "Transcript path is unverified.", next: "act",
    })

    const status = (await manager.status(transcriptOwner, discussionID))[0]
    const persisted = runtime.state(transcriptOwner).discussions[0]
    assert.equal(status.transcriptPath, undefined)
    assert.match(status.transcriptError ?? "", /owner marker|framed transcript header/i)
    assert.equal(persisted.transcriptPath, undefined)
    assert.match(persisted.transcriptError ?? "", /owner marker|framed transcript header/i)
    assert.equal(persisted.results[0].turns.length, 3)
    assert.equal(readFileSync(destination, "utf8"), "unrelated replacement\n")
  } finally {
    try { if (manager) await manager.dispose() }
    finally { rmSync(project, { recursive: true, force: true }) }
  }
})

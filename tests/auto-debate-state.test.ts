import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyControl,
  applyEvaluation,
  awaitEvaluation,
  DEFAULT_AUTO_DEBATE_CONFIG,
  parseControl,
  roundBudget,
  roundsConsumed,
  resumeDiscussion,
  shouldEndCycle,
  startDiscussion,
} from "../src/auto-debate/state.ts"
import type {
  AutoDebateConfig,
  ConversationState,
  CycleResult,
  Discussion,
  Evaluation,
  Owner,
  Turn,
} from "../src/auto-debate/types.ts"

const owner: Owner = {
  sessionID: "parent-session",
  agent: "opencode",
  directory: "/workspace",
}

function discussion(overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: "discussion-1",
    owner,
    config: DEFAULT_AUTO_DEBATE_CONFIG,
    brief: {
      question: "Which option should be selected?",
      objective: "Make a decision",
      facts: [],
      assumptions: [],
      constraints: [],
      alternatives: [],
      uncertainty: "The evidence is incomplete",
      neededOutcome: "A recommendation",
    },
    panel: ["one", "two", "three"].map((agent, index) => ({
      participant: { agent, description: `Participant ${agent}`, model: `provider/${agent}` },
      sessionID: `child-session-${index + 1}`,
      runtimeAgent: agent,
    })),
    status: "running",
    generation: 0,
    cycle: 1,
    results: [],
    evaluations: [],
    pendingTurns: [],
    followups: [],
    ...overrides,
  }
}

function conversationState(discussions: Discussion[] = []): ConversationState {
  return { version: 1, discussions, outbox: [] }
}

function evaluation(next: Evaluation["next"], cycle = 1): Evaluation {
  return {
    cycle,
    conclusion: "The evidence does not settle every question.",
    caveats: ["One comparison is incomplete."],
    rationale: "The recorded arguments support a provisional decision.",
    next,
  }
}

test("unanimous stop ends a new discussion only from round two", () => {
  const votes: Turn[] = ["one", "two", "three"].map((participant) => ({
    participant,
    cycle: 1,
    round: 2,
    text: "We disagree, but more rounds will not help.",
    consensus: false,
    stop: true,
  }))

  assert.equal(shouldEndCycle({ cycle: 1, round: 2, maxRounds: 5, turns: votes }), true)
  assert.equal(shouldEndCycle({ cycle: 1, round: 2, maxRounds: 5, turns: votes.slice(1) }), false)
  assert.equal(shouldEndCycle({
    cycle: 1,
    round: 1,
    maxRounds: 3,
    turns: votes.map((turn) => ({ ...turn, round: 1 })),
  }), false)
})

test("a resumed cycle may end on its first unanimous follow-up round", () => {
  const votes = ["one", "two", "three"].map((participant) => ({
    participant,
    cycle: 2,
    round: 1,
    text: "No further useful round is available.",
    stop: true,
  }))

  assert.equal(shouldEndCycle({ cycle: 2, round: 1, maxRounds: 3, turns: votes }), true)
})

test("round limit ends a cycle even without unanimous stop votes", () => {
  assert.equal(shouldEndCycle({ cycle: 1, round: 3, maxRounds: 3, turns: [] }), true)
})

test("unanimous stop requires three distinct matching turns", () => {
  const votes = ["one", "two", "three"].map((participant) => ({
    participant,
    cycle: 2,
    round: 1,
    text: "Stop.",
    stop: true,
  }))

  assert.equal(shouldEndCycle({
    cycle: 2,
    round: 1,
    maxRounds: 5,
    turns: [votes[0], votes[0], votes[2]],
  }), false)
  assert.equal(shouldEndCycle({
    cycle: 2,
    round: 1,
    maxRounds: 5,
    turns: [votes[0], votes[1], { ...votes[2], stop: false }],
  }), false)
  assert.equal(shouldEndCycle({
    cycle: 2,
    round: 1,
    maxRounds: 5,
    turns: [votes[0], votes[1], { ...votes[2], cycle: 1 }],
  }), false)
})

test("control parsing trims whitespace and distinguishes off from stop", () => {
  assert.deepEqual(parseControl(" \t off \n "), { action: "off" })
  assert.deepEqual(parseControl("\n stop   discussion-1 \t"), {
    action: "stop",
    target: "discussion-1",
  })
})

test("control parsing rejects missing stop targets, extra arguments and unknown verbs", () => {
  for (const text of ["", "stop", "stop discussion-1 now", "on extra", "status now", "pause"]) {
    assert.throws(() => parseControl(text))
  }
})

test("storage management commands are not automatic-debate controls", () => {
  for (const command of ["storage status", "storage migrate", "storage delete-source"]) {
    assert.throws(() => parseControl(command), /invalid automatic debate control/i)
  }
})

test("running discussions transition to awaiting evaluation before evaluation", () => {
  const running = discussion()
  const awaiting = awaitEvaluation(running)

  assert.equal(running.status, "running")
  assert.equal(awaiting.status, "awaiting-evaluation")
})

test("act and report-unresolved evaluations resolve a discussion", () => {
  for (const next of ["act", "report-unresolved"] as const) {
    const evaluated = applyEvaluation(awaitEvaluation(discussion()), evaluation(next))

    assert.equal(evaluated.status, "resolved")
    assert.deepEqual(evaluated.evaluations, [evaluation(next)])
  }
})

test("investigate and continue evaluations pause a discussion", () => {
  for (const next of ["investigate", "continue"] as const) {
    const evaluated = applyEvaluation(awaitEvaluation(discussion()), evaluation(next))

    assert.equal(evaluated.status, "paused")
    assert.deepEqual(evaluated.evaluations, [evaluation(next)])
  }
})

test("an identical evaluation is idempotent but a different evaluation for that cycle is rejected", () => {
  const firstEvaluation = evaluation("act")
  const resolved = applyEvaluation(awaitEvaluation(discussion()), firstEvaluation)

  assert.strictEqual(applyEvaluation(resolved, firstEvaluation), resolved)
  assert.throws(() => applyEvaluation(resolved, { ...firstEvaluation, conclusion: "Changed" }))
})

test("partial cycle evaluation and resume preserve recorded turns without inventing any", () => {
  const partialTurn: Turn = {
    participant: "one",
    cycle: 1,
    round: 1,
    text: "The first participant completed a turn.",
  }
  const partialResult: CycleResult = {
    cycle: 1,
    rounds: 1,
    status: "partial",
    reason: "participant-failure",
    turns: [partialTurn],
    failures: [{ participant: "two", message: "Participant did not respond." }],
    consensus: false,
  }
  const awaiting = discussion({ status: "awaiting-evaluation", results: [partialResult] })
  const evaluated = applyEvaluation(awaiting, evaluation("continue"))
  const state = resumeDiscussion(conversationState([evaluated]), evaluated.id, owner)
  const resumed = state.discussions[0]

  assert.equal(resumed.status, "running")
  assert.equal(resumed.cycle, 2)
  assert.equal(resumed.roundsSpent, 1, "legacy settled result consumption is captured before entering the running state")
  assert.deepEqual(resumed.results, [partialResult])
  assert.deepEqual(resumed.results[0].turns, [partialTurn])
  assert.deepEqual(resumed.pendingTurns, [])
})

test("finite round budget counts old completed-cycle records and rejects exhausted resumes", () => {
  const savedResult: CycleResult = {
    cycle: 1,
    rounds: 2,
    status: "complete",
    reason: "unanimous-stop",
    turns: [],
    failures: [],
    consensus: false,
  }
  const paused = discussion({
    status: "paused",
    config: { ...DEFAULT_AUTO_DEBATE_CONFIG, enabled: true, maxRounds: 3 },
    results: [savedResult],
    evaluations: [evaluation("continue")],
  })

  assert.equal(roundsConsumed(paused), 2)
  assert.deepEqual(roundBudget(paused), {
    limit: 3,
    consumed: 2,
    remaining: 1,
    cycleLimit: 1,
    unlimited: false,
  })
  assert.equal(resumeDiscussion(conversationState([paused]), paused.id, owner).discussions[0].cycle, 2)

  const exhausted = discussion({
    ...paused,
    results: [{ ...savedResult, rounds: 3 }],
  })
  assert.equal(roundBudget(exhausted).remaining, 0)
  assert.throws(() => resumeDiscussion(conversationState([exhausted]), exhausted.id, owner), /round budget.*exhausted/i)
})

test("unlimited round budget uses three-round checkpoints and old interrupted records fail closed", () => {
  const unlimited = discussion({
    status: "paused",
    config: { ...DEFAULT_AUTO_DEBATE_CONFIG, enabled: true, maxRounds: 0 },
    results: [{ cycle: 1, rounds: 3, status: "complete", reason: "round-limit", turns: [], failures: [], consensus: false }],
    evaluations: [evaluation("continue")],
  })
  assert.deepEqual(roundBudget(unlimited), {
    limit: 0,
    consumed: 3,
    remaining: undefined,
    cycleLimit: 3,
    unlimited: true,
  })
  assert.equal(resumeDiscussion(conversationState([unlimited]), unlimited.id, owner).discussions[0].cycle, 2)

  const oldInterrupted = discussion({
    status: "interrupted",
    config: { ...DEFAULT_AUTO_DEBATE_CONFIG, enabled: true, maxRounds: 3 },
    results: [{ cycle: 1, rounds: 0, status: "interrupted", reason: "shutdown", turns: [], failures: [], consensus: false }],
  })
  assert.equal(roundsConsumed(oldInterrupted), 3, "an old record cannot regain rounds that its incomplete result may not show")
})

test("legacy cancellation after a settled cycle charges its recorded rounds, not a full cycle", () => {
  const cancelled = discussion({
    status: "cancelled",
    results: [{ cycle: 1, rounds: 2, status: "complete", reason: "round-limit", turns: [], failures: [], consensus: false }],
  })
  assert.equal(roundsConsumed(cancelled), 2)
  assert.deepEqual(roundBudget(cancelled), {
    limit: 3,
    consumed: 2,
    remaining: 1,
    cycleLimit: 1,
    unlimited: false,
  })
})

test("legacy budget validation bounds its work by saved cycle results, not an untrusted cycle number", () => {
  const malformed = discussion({
    status: "paused",
    cycle: Number.MAX_SAFE_INTEGER,
    results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit", turns: [], failures: [], consensus: false }],
  })
  assert.equal(roundBudget(malformed).remaining, 0)
})

test("resume requires an owned paused discussion with a recorded evaluation", () => {
  const awaiting = discussion({ status: "awaiting-evaluation" })
  const state = conversationState([awaiting])

  assert.throws(() => resumeDiscussion(state, awaiting.id, owner))
  assert.throws(() => resumeDiscussion(
    conversationState([discussion({
      status: "paused",
      evaluations: [evaluation("continue")],
    })]),
    "discussion-1",
    { ...owner, sessionID: "another-session" },
  ))
})

test("resolved and cancelled discussions cannot resume", () => {
  for (const status of ["resolved", "cancelled"] as const) {
    const finished = discussion({ status, evaluations: [evaluation("continue")] })

    assert.throws(() => resumeDiscussion(conversationState([finished]), finished.id, owner))
  }
})

test("new discussions require effective enablement while an override can enable them", () => {
  const stoppedConfig: AutoDebateConfig = { ...DEFAULT_AUTO_DEBATE_CONFIG, enabled: false }
  const initial = conversationState()

  assert.throws(() => startDiscussion(initial, stoppedConfig, discussion()))

  const enabled = applyControl(initial, parseControl("on"))
  const started = startDiscussion(enabled, stoppedConfig, discussion())

  assert.equal(started.discussions.length, 1)
  assert.equal(initial.discussions.length, 0)
})

test("turning off blocks new discussions but does not block resume of an existing one", () => {
  const paused = discussion({
    status: "paused",
    results: [{ cycle: 1, rounds: 1, status: "complete", reason: "round-limit", turns: [], failures: [], consensus: false }],
    evaluations: [evaluation("continue")],
  })
  const initiallyEnabled: AutoDebateConfig = { ...DEFAULT_AUTO_DEBATE_CONFIG, enabled: true }
  const existing = conversationState([paused])
  const disabled = applyControl(existing, parseControl("off"))

  assert.throws(() => startDiscussion(disabled, initiallyEnabled, discussion({ id: "new" })))
  const resumed = resumeDiscussion(disabled, paused.id, owner)

  assert.equal(resumed.discussions[0].status, "running")
})

test("reset removes the override so new starts follow YAML defaults", () => {
  const yamlDisabled: AutoDebateConfig = { ...DEFAULT_AUTO_DEBATE_CONFIG, enabled: false }
  const enabled = applyControl(conversationState(), parseControl("on"))
  const reset = applyControl(enabled, parseControl("reset"))

  assert.equal(reset.override, undefined)
  assert.throws(() => startDiscussion(reset, yamlDisabled, discussion()))
})

test("off leaves existing work intact and explicit stop cancels it", () => {
  const running = discussion()
  const state = conversationState([running])
  const off = applyControl(state, parseControl("off"))

  assert.equal(off.override, false)
  assert.equal(off.discussions[0].status, "running")

  const stopped = applyControl(off, parseControl("stop discussion-1"))

  assert.equal(stopped.override, false)
  assert.equal(stopped.discussions[0].status, "cancelled")
  assert.equal(state.discussions[0].status, "running")
  assert.throws(() => resumeDiscussion(stopped, running.id, owner))
})

test("control changes are isolated to the supplied conversation state", () => {
  const firstConversation = conversationState()
  const secondConversation = conversationState()
  const firstAfterOff = applyControl(firstConversation, parseControl("off"))

  assert.equal(firstAfterOff.override, false)
  assert.equal(secondConversation.override, undefined)
  assert.equal(firstConversation.override, undefined)
})

import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyControl,
  applyEvaluation,
  awaitEvaluation,
  DEFAULT_AUTO_DEBATE_CONFIG,
  parseControl,
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
  assert.deepEqual(resumed.results, [partialResult])
  assert.deepEqual(resumed.results[0].turns, [partialTurn])
  assert.deepEqual(resumed.pendingTurns, [])
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
  const paused = discussion({ status: "paused", evaluations: [evaluation("continue")] })
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

import type {
  AutoDebateConfig,
  ConversationState,
  Discussion,
  Evaluation,
  Owner,
  Turn,
} from "./types.ts"

export const DEFAULT_AUTO_DEBATE_CONFIG: AutoDebateConfig = Object.freeze({
  enabled: false,
  maxRounds: 3,
  persistTranscripts: true,
})

export type Control = { action: "on" | "off" | "status" | "reset" }
  | { action: "stop"; target: string }

export type StopInput = {
  cycle: number
  round: number
  maxRounds: number
  turns: readonly Turn[]
}

export function shouldEndCycle(input: StopInput): boolean {
  if (input.round >= input.maxRounds) return true
  const earliest = input.cycle === 1 ? 2 : 1
  return input.round >= earliest
    && input.turns.length === 3
    && new Set(input.turns.map((turn) => turn.participant)).size === 3
    && input.turns.every((turn) => turn.cycle === input.cycle
      && turn.round === input.round && turn.stop === true)
}

/** Unlimited discussions yield for main-agent evaluation every three rounds. */
export const UNLIMITED_ROUND_CHECKPOINT = 3

export type RoundBudget = Readonly<{
  /** Configured total discussion limit; zero means unlimited. */
  limit: number
  /** Rounds already reserved/dispatched across all cycles. */
  consumed: number
  /** Remaining total rounds, or undefined when the discussion is unlimited. */
  remaining: number | undefined
  /** Maximum rounds in the next cycle before yielding for evaluation. */
  cycleLimit: number
  unlimited: boolean
}>

function roundCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Count lifetime round consumption. New records persist `roundsSpent` before
 * dispatch; older settled records are read from result history. Legacy active
 * or interrupted cycles are uncertain, so a finite budget is treated as spent
 * rather than granting a potentially already-used round.
 */
export function roundsConsumed(discussion: Discussion): number {
  const perCycle = new Map<number, number>()
  let recorded = 0
  let uncertain = false

  for (const result of discussion.results) {
    if (!roundCount(result.rounds)) {
      uncertain = true
      continue
    }
    recorded += result.rounds
    if (!Number.isSafeInteger(recorded)) uncertain = true
    perCycle.set(result.cycle, (perCycle.get(result.cycle) ?? 0) + result.rounds)
  }

  let pendingRound = 0
  for (const turn of discussion.pendingTurns) {
    if (turn.cycle !== discussion.cycle) continue
    if (!roundCount(turn.round)) uncertain = true
    else pendingRound = Math.max(pendingRound, turn.round)
  }
  if (!perCycle.has(discussion.cycle)) recorded += pendingRound

  if (discussion.roundsSpent !== undefined) {
    if (roundCount(discussion.roundsSpent)) recorded = Math.max(recorded, discussion.roundsSpent)
    else uncertain = true
  } else if (discussion.status === "running" || discussion.status === "interrupted"
    || (discussion.status === "cancelled" && !discussion.results.some((result) => result.cycle === discussion.cycle
      && (result.status === "complete" || result.status === "partial")))) {
    // Before roundsSpent existed, result.turns could not account for an
    // in-flight round with no returned turn. Old managers also limited each
    // cycle independently, so conservatively charge a full legacy cycle.
    const previousCycles = [...perCycle.entries()]
      .filter(([cycle]) => cycle !== discussion.cycle)
      .reduce((sum, [, rounds]) => sum + rounds, 0)
    const currentCycle = Math.max(perCycle.get(discussion.cycle) ?? 0, pendingRound, discussion.config.maxRounds)
    recorded = previousCycles + currentCycle
  } else {
    const recordedCycles = [...perCycle.keys()].sort((left, right) => left - right)
    if (recordedCycles.length !== discussion.cycle || recordedCycles.length !== discussion.results.length
      || recordedCycles.some((cycle, index) => cycle !== index + 1)) uncertain = true
  }

  if (uncertain && discussion.config.maxRounds > 0) {
    recorded = Math.max(recorded, discussion.config.maxRounds)
  }
  return Math.max(0, recorded)
}

export function roundBudget(discussion: Discussion): RoundBudget {
  const limit = discussion.config.maxRounds
  const consumed = roundsConsumed(discussion)
  const unlimited = limit === 0
  const remaining = unlimited ? undefined : Math.max(0, limit - consumed)
  return {
    limit,
    consumed,
    remaining,
    cycleLimit: unlimited ? UNLIMITED_ROUND_CHECKPOINT : remaining!,
    unlimited,
  }
}

/** Count rounds reserved within one cycle, including a dispatch with no turn. */
export function roundsInCycle(discussion: Discussion, cycle = discussion.cycle): number {
  const saved = discussion.results.filter((result) => result.cycle === cycle)
  if (saved.length > 0) {
    return saved.reduce((rounds, result) => roundCount(result.rounds) ? Math.max(rounds, result.rounds) : rounds, 0)
  }
  const previous = discussion.results.filter((result) => result.cycle !== cycle)
    .reduce((rounds, result) => roundCount(result.rounds) ? rounds + result.rounds : rounds, 0)
  const pending = discussion.pendingTurns.filter((turn) => turn.cycle === cycle)
    .reduce((rounds, turn) => roundCount(turn.round) ? Math.max(rounds, turn.round) : rounds, 0)
  return Math.max(0, roundsConsumed(discussion) - previous, pending)
}

export function parseControl(text: string): Control {
  const args = text.trim().split(/\s+/u).filter(Boolean)
  const verb = args[0]
  if (args.length === 1 && (verb === "on" || verb === "off" || verb === "status" || verb === "reset")) {
    return { action: verb }
  }
  if (verb === "stop" && args.length === 2) {
    return { action: "stop", target: args[1] }
  }
  throw new Error("Invalid automatic debate control command")
}

export function awaitEvaluation(discussion: Discussion): Discussion {
  if (discussion.status !== "running") {
    throw new Error(`Cannot await evaluation from ${discussion.status}`)
  }
  return { ...discussion, status: "awaiting-evaluation" }
}

export function applyEvaluation(discussion: Discussion, evaluation: Evaluation): Discussion {
  const existing = discussion.evaluations.find((item) => item.cycle === evaluation.cycle)
  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(evaluation)) return discussion
    throw new Error(`Cycle ${evaluation.cycle} already has a different evaluation`)
  }
  if (discussion.status !== "awaiting-evaluation") {
    throw new Error(`Cannot evaluate a discussion in ${discussion.status}`)
  }
  if (evaluation.cycle !== discussion.cycle) {
    throw new Error(`Evaluation cycle ${evaluation.cycle} does not match ${discussion.cycle}`)
  }

  return {
    ...discussion,
    status: evaluation.next === "act" || evaluation.next === "report-unresolved"
      ? "resolved"
      : "paused",
    evaluations: [...discussion.evaluations, evaluation],
  }
}

function ownerMatches(left: Owner, right: Owner): boolean {
  return left.sessionID === right.sessionID
    && left.agent === right.agent
    && left.directory === right.directory
}

export function resumeDiscussion(
  state: ConversationState,
  discussionID: string,
  owner: Owner,
): ConversationState {
  const index = state.discussions.findIndex((discussion) => discussion.id === discussionID)
  if (index < 0) throw new Error(`Unknown discussion: ${discussionID}`)
  const discussion = state.discussions[index]
  if (!ownerMatches(discussion.owner, owner)) throw new Error("Discussion owner does not match")
  if (discussion.status !== "paused") {
    throw new Error(`Cannot resume a discussion in ${discussion.status}`)
  }
  const evaluation = discussion.evaluations.find((item) => item.cycle === discussion.cycle)
  if (evaluation === undefined || (evaluation.next !== "investigate" && evaluation.next !== "continue")) {
    throw new Error("A paused discussion requires a resumable evaluation")
  }
  const budget = roundBudget(discussion)
  if (!budget.unlimited && budget.remaining === 0) {
    throw new Error("The automatic-debate round budget is exhausted")
  }

  const discussions = [...state.discussions]
  discussions[index] = {
    ...discussion,
    // Upgrade old settled records from their persisted cycle results before
    // they enter a new in-flight cycle.
    roundsSpent: discussion.roundsSpent ?? budget.consumed,
    status: "running",
    cycle: discussion.cycle + 1,
  }
  return { ...state, discussions }
}

function enabledFor(config: AutoDebateConfig, state: ConversationState): boolean {
  return state.override ?? config.enabled
}

export function startDiscussion(
  state: ConversationState,
  config: AutoDebateConfig,
  discussion: Discussion,
): ConversationState {
  if (!enabledFor(config, state)) throw new Error("Automatic debate is disabled")
  if (discussion.status !== "running") throw new Error("A new discussion must be running")
  if (state.discussions.some((current) => current.id === discussion.id)) {
    throw new Error(`Discussion already exists: ${discussion.id}`)
  }
  return { ...state, discussions: [...state.discussions, discussion] }
}

export function applyControl(state: ConversationState, control: Control): ConversationState {
  switch (control.action) {
    case "on":
      return state.override === true ? state : { ...state, override: true }
    case "off":
      return state.override === false ? state : { ...state, override: false }
    case "reset": {
      if (state.override === undefined) return state
      const { override: _override, ...reset } = state
      return reset
    }
    case "status":
      return state
    case "stop": {
      const index = state.discussions.findIndex((discussion) => discussion.id === control.target)
      if (index < 0) throw new Error(`Unknown discussion: ${control.target}`)
      const discussion = state.discussions[index]
      if (discussion.status === "cancelled") return state
      if (discussion.status === "resolved" || discussion.status === "interrupted") return state

      const discussions = [...state.discussions]
      discussions[index] = {
        ...discussion,
        status: "cancelled",
        generation: discussion.generation + 1,
        cancellation: {
          pendingSessionIDs: discussion.panel.map((member) => member.sessionID),
          errors: [],
        },
      }
      return { ...state, discussions }
    }
  }
}

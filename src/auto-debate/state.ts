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

  const discussions = [...state.discussions]
  discussions[index] = { ...discussion, status: "running", cycle: discussion.cycle + 1 }
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

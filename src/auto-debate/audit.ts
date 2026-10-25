import type { Brief, CycleResult, Discussion, Evaluation, Turn } from "./types.ts"

export const AUTOMATIC_PARTICIPANT_PREFIX = "opencode-debate-auto-"

type Persistence = {
  enabled: boolean
  outcome: "saved" | "unavailable" | "not-confirmed" | "disabled"
  path?: string
  error?: string
}

export type DiscussionSummary = {
  id: string
  status: Discussion["status"]
  cycle: number
  maxRounds: number
  participants: string[]
  persistence: Persistence
  canonicalFindings?: Turn[]
  result?: {
    status: CycleResult["status"]
    reason: CycleResult["reason"]
    rounds: number
    consensus: boolean
    failures: CycleResult["failures"]
  }
  unconfirmedCancellation?: { confirmed: false; pendingSessionIDs: string[]; errors: string[] }
  cancellation?: { confirmed: true; pendingSessionIDs: string[]; errors: string[] }
}

export type DiscussionAudit = DiscussionSummary & {
  brief: Brief
  results: CycleResult[]
  evaluations: Evaluation[]
  followups: { cycle: number; feedback: string }[]
  pendingTurns: Turn[]
  stopReasons: string[]
  failures: { participant: string; message: string }[]
  deliveryUncertainCycles?: { cycle: number; reason: string }[]
  cancellationDetails?: { pendingSessionIDs: string[]; errors: string[] }
  transcriptPath?: string
  transcriptError?: string
  participantDetails: { agent: string; model: string; variant?: string; sessionID: string; runtimeAgent: string }[]
}

function participantName(agent: string): string {
  return agent.startsWith(AUTOMATIC_PARTICIPANT_PREFIX)
    ? agent.slice(AUTOMATIC_PARTICIPANT_PREFIX.length) : agent
}

export function discussionSummary(discussion: Discussion): DiscussionSummary {
  const evaluation = discussion.evaluations.find((item) => item.cycle === discussion.cycle)
  const result = discussion.results.find((item) => item.cycle === discussion.cycle)
  const persistence: Persistence = discussion.config.persistTranscripts
    ? discussion.transcriptError
      ? { enabled: true, outcome: "unavailable", error: discussion.transcriptError }
      : discussion.transcriptPath
        ? { enabled: true, outcome: "saved", path: discussion.transcriptPath }
        : { enabled: true, outcome: "not-confirmed" }
    : { enabled: false, outcome: "disabled" }
  const summary: DiscussionSummary = {
    id: discussion.id,
    status: discussion.status,
    cycle: discussion.cycle,
    maxRounds: discussion.config.maxRounds,
    participants: discussion.panel.map(({ participant }) => participantName(participant.agent)),
    persistence,
  }
  if (result && discussion.status === "awaiting-evaluation" && !evaluation) {
    summary.canonicalFindings = result.turns.map((turn) => ({ ...turn }))
    summary.result = {
      status: result.status,
      reason: result.reason,
      rounds: result.rounds,
      consensus: result.consensus,
      failures: result.failures.map((failure) => ({ ...failure })),
    }
  }
  if (discussion.cancellation) {
    if (discussion.cancellation.pendingSessionIDs.length === 0 && discussion.cancellation.errors.length === 0) {
      summary.cancellation = {
        confirmed: true,
        pendingSessionIDs: [...discussion.cancellation.pendingSessionIDs],
        errors: [...discussion.cancellation.errors],
      }
    } else {
      summary.unconfirmedCancellation = {
        confirmed: false,
        pendingSessionIDs: [...discussion.cancellation.pendingSessionIDs],
        errors: [...discussion.cancellation.errors],
      }
    }
  }
  return summary
}

export function discussionAudit(discussion: Discussion): DiscussionAudit {
  const audit: DiscussionAudit = {
    ...discussionSummary(discussion),
    brief: structuredClone(discussion.brief),
    results: structuredClone(discussion.results),
    evaluations: structuredClone(discussion.evaluations),
    followups: structuredClone(discussion.followups),
    pendingTurns: structuredClone(discussion.pendingTurns),
    stopReasons: discussion.results.map((result) => result.reason),
    failures: discussion.results.flatMap((result) => result.failures.map((failure) => ({ ...failure }))),
    participantDetails: discussion.panel.map(({ participant, sessionID, runtimeAgent }) => ({
      agent: participantName(participant.agent),
      model: participant.model,
      ...(participant.variant === undefined ? {} : { variant: participant.variant }),
      sessionID,
      runtimeAgent,
    })),
  }
  if (discussion.deliveryUncertainCycles !== undefined) {
    audit.deliveryUncertainCycles = structuredClone(discussion.deliveryUncertainCycles)
  }
  if (discussion.cancellation) {
    audit.cancellationDetails = {
      pendingSessionIDs: [...discussion.cancellation.pendingSessionIDs],
      errors: [...discussion.cancellation.errors],
    }
  }
  if (discussion.transcriptPath !== undefined) audit.transcriptPath = discussion.transcriptPath
  if (discussion.transcriptError !== undefined) audit.transcriptError = discussion.transcriptError
  return audit
}

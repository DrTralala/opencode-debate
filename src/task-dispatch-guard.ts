import type { Hooks, Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"

export const TASK_DISPATCH_MARKER = "DEBATE_DISPATCH"

export type TaskDispatchPurpose = "normal" | "retry" | "formatter-correction"

export type TaskDispatchMarker = {
  purpose: TaskDispatchPurpose
  participant: number
  round: number
  subagentType: string
}

type LifecycleStatus = "active" | "completed" | "failed"
type TerminalSource = "after" | "event"

export type TaskDispatchGuardState = {
  coordinatorSessions: Set<string>
  sessions: Map<string, Map<string, {
    marker: TaskDispatchMarker
    normal?: { status: LifecycleStatus; childSessionID?: string }
    retry?: { status: LifecycleStatus; childSessionID?: string }
    correction?: { status: LifecycleStatus; childSessionID?: string }
  }>>
}

type DispatchKey = string
type CallKey = `${string}:${string}`

type DispatchRecord = {
  sessionID: string
  callID: string
  key: DispatchKey
  purpose: TaskDispatchPurpose
  status: LifecycleStatus
  childSessionID?: string
  terminalSource?: TerminalSource
}

type RoundState = {
  marker: TaskDispatchMarker
  aggregateNormalStatus?: LifecycleStatus
  normal?: DispatchRecord
  retry?: DispatchRecord
  correction?: DispatchRecord
}

type SessionState = Map<DispatchKey, RoundState>

const MARKER_RE = /^\[DEBATE_DISPATCH\s+purpose=(normal|retry|formatter-correction)\s+participant=([1-3])\s+round=([1-9][0-9]*)\s+subagent_type=([^\s\]]+)\]$/
const TASK_OUTPUT_RE = /^<task id="([^"]+)" state="(running|completed|error)">[\s\S]*<task_(result|error)>\s*([\s\S]*?)\s*<\/task_\3>[\s\S]*<\/task>$/
const RESOLVED_PARTICIPANTS_RE = /(?:^|\n)Resolved participants:\nParticipant 1: ([^\s\r\n]+)\nParticipant 2: ([^\s\r\n]+)\nParticipant 3: ([^\s\r\n]+)\n\nThe command arguments have already been parsed and validated\./g

function dispatchKey(marker: TaskDispatchMarker): DispatchKey {
  return `${marker.participant}:${marker.round}`
}

function callKey(sessionID: string, callID: string): CallKey {
  return `${sessionID}:${callID}`
}

function error(message: string): Error {
  return new Error(`Debate task dispatch rejected: ${message}`)
}

function metadataString(metadata: unknown, key: string): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function taskOutput(output: string): {
  childSessionID?: string
  status: "running" | "completed" | "failed"
  participantOutput?: string
} {
  const match = TASK_OUTPUT_RE.exec(output.trim())
  if (!match) return { status: "failed" }
  const state = match[2]
  if (state === "running") return { childSessionID: match[1], status: "running" }
  const participantOutput = match[4].trim()
  return {
    childSessionID: match[1],
    status: state === "error" || match[3] === "error" || participantOutput.length === 0
      ? "failed"
      : "completed",
    participantOutput,
  }
}

function childSessionIDFrom(
  output: string,
  metadata: unknown,
  eventMetadata?: unknown,
): string | undefined {
  const envelopeID = taskOutput(output).childSessionID
  const metadataID = metadataString(metadata, "sessionId")
    ?? metadataString(metadata, "sessionID")
    ?? metadataString(eventMetadata, "sessionId")
    ?? metadataString(eventMetadata, "sessionID")
  if (envelopeID && metadataID && envelopeID !== metadataID) {
    throw error(`task child session ID mismatch (envelope=${envelopeID}, metadata=${metadataID})`)
  }
  return metadataID ?? envelopeID
}

function expectedTaskID(session: SessionState, marker: TaskDispatchMarker): string | undefined {
  const sourceRound = marker.purpose === "normal" ? marker.round - 1 : marker.round
  if (sourceRound < 1) return undefined
  return session.get(`${marker.participant}:${sourceRound}`)?.normal?.childSessionID
}

function resolvedParticipantTypes(text: string): Map<number, string> | undefined {
  const matches = [...text.matchAll(RESOLVED_PARTICIPANTS_RE)]
  if (matches.length !== 1) return undefined
  const [, first, second, third] = matches[0]
  const values = [first, second, third]
  if (new Set(values).size !== values.length) {
    throw error("Resolved participants must assign three distinct subagent types")
  }
  return new Map(values.map((value, index) => [index + 1, value]))
}

function associateChildSession(
  calls: Map<CallKey, DispatchRecord>,
  sessions: Map<string, SessionState>,
  sessionID: string,
  callID: string,
  childSessionID: string | undefined,
): void {
  if (childSessionID === undefined) return
  const record = calls.get(callKey(sessionID, callID))
  if (!record) return
  if (record.childSessionID !== undefined) {
    if (record.childSessionID !== childSessionID) {
      throw error(
        `task child session ID conflict (recorded=${record.childSessionID}, received=${childSessionID})`,
      )
    }
    return
  }
  record.childSessionID = childSessionID
  const state = sessions.get(sessionID)?.get(record.key)
  if (!state) return
  const target = record.purpose === "normal"
    ? state.normal
    : record.purpose === "retry"
      ? state.retry
      : state.correction
  if (target) target.childSessionID = childSessionID
}

export function parseTaskDispatchMarker(prompt: unknown): TaskDispatchMarker | undefined {
  if (typeof prompt !== "string") return undefined
  const firstLine = prompt.split(/\r?\n/, 1)[0]
  if (!firstLine?.startsWith(`[${TASK_DISPATCH_MARKER}`)) return undefined

  const match = MARKER_RE.exec(firstLine)
  if (!match) throw error("dispatch marker is malformed")

  return {
    purpose: match[1] as TaskDispatchPurpose,
    participant: Number(match[2]),
    round: Number(match[3]),
    subagentType: match[4],
  }
}

function taskID(args: Record<string, unknown>): string | undefined {
  return typeof args.task_id === "string" && args.task_id.length > 0
    ? args.task_id
    : undefined
}

function normalStatus(state: RoundState | undefined): LifecycleStatus | undefined {
  return state?.aggregateNormalStatus ?? state?.normal?.status
}

function highestCompletedNormalRound(session: SessionState, participant: number): number {
  let highest = 0
  for (const state of session.values()) {
    if (
      state.marker.participant === participant
      && normalStatus(state) === "completed"
      && state.marker.round > highest
    ) {
      highest = state.marker.round
    }
  }
  return highest
}

function ensureSubagentType(args: Record<string, unknown>, marker: TaskDispatchMarker): void {
  if (typeof args.subagent_type !== "string" || args.subagent_type.length === 0) {
    throw error("subagent_type is required")
  }
  if (args.subagent_type !== marker.subagentType) {
    throw error(
      `subagent_type mismatch (marker=${marker.subagentType}, argument=${args.subagent_type})`,
    )
  }
}

function ensureEstablishedSubagentType(
  participantSubagentTypes: Map<string, Map<number, string>>,
  sessionID: string,
  marker: TaskDispatchMarker,
): void {
  const established = participantSubagentTypes.get(sessionID)?.get(marker.participant)
  if (established === undefined) {
    throw error(`participant ${marker.participant} is not present in the resolved participant mapping`)
  }
  if (marker.subagentType !== established) {
    throw error(
      `subagent_type conflicts with resolved participant type (established=${established}, resolved=${established}, received=${marker.subagentType})`,
    )
  }
}

function hasActiveCalls(calls: Map<CallKey, DispatchRecord>, sessionID: string): boolean {
  for (const record of calls.values()) {
    if (record.sessionID === sessionID && record.status === "active") return true
  }
  return false
}

function resetCompletedDebate(
  coordinatorSessions: Set<string>,
  sessions: Map<string, SessionState>,
  participantSubagentTypes: Map<string, Map<number, string>>,
  calls: Map<CallKey, DispatchRecord>,
  sessionID: string,
  participantTypes: Map<number, string>,
): void {
  if (hasActiveCalls(calls, sessionID)) {
    throw error("cannot start a new debate while the current debate has an active dispatch")
  }
  sessions.delete(sessionID)
  participantSubagentTypes.set(sessionID, participantTypes)
  coordinatorSessions.add(sessionID)
  for (const [key, record] of calls) {
    if (record.sessionID === sessionID) calls.delete(key)
  }
}

function admit(
  coordinatorSessions: Set<string>,
  sessions: Map<string, SessionState>,
  participantSubagentTypes: Map<string, Map<number, string>>,
  calls: Map<CallKey, DispatchRecord>,
  input: { sessionID: string; callID: string },
  args: Record<string, unknown>,
): void {
  if (!coordinatorSessions.has(input.sessionID)) return
  const marker = parseTaskDispatchMarker(args.prompt)
  if (marker === undefined) {
    throw error("structured dispatch marker is required")
  }

  ensureSubagentType(args, marker)
  ensureEstablishedSubagentType(participantSubagentTypes, input.sessionID, marker)
  const suppliedTaskID = taskID(args)
  if (marker.purpose === "normal" && marker.round === 1 && suppliedTaskID !== undefined) {
    throw error("round 1 normal dispatch must omit task_id")
  }
  if (marker.round > 1 && suppliedTaskID === undefined) {
    throw error(`${marker.purpose} requires task_id for round ${marker.round}`)
  }
  if (marker.purpose !== "normal" && suppliedTaskID === undefined) {
    throw error(`${marker.purpose} requires task_id`)
  }
  if (calls.has(callKey(input.sessionID, input.callID))) throw error(`call ${input.callID} is already active`)

  let session = sessions.get(input.sessionID)
  if (!session) {
    session = new Map()
    sessions.set(input.sessionID, session)
  }

  const key = dispatchKey(marker)
  let state = session.get(key)
  if (!state) {
    state = { marker }
    session.set(key, state)
  }

  const normal = normalStatus(state)
  let record: DispatchRecord

  if (marker.purpose === "normal") {
    if (normal !== undefined) {
      throw error(
        normal === "active"
          ? `duplicate active normal dispatch for participant ${marker.participant}, round ${marker.round}`
          : normal === "completed"
            ? `duplicate completed normal dispatch for participant ${marker.participant}, round ${marker.round}`
            : `normal dispatch failed; use one retry for participant ${marker.participant}, round ${marker.round}`,
      )
    }
    const expectedRound = highestCompletedNormalRound(session, marker.participant) + 1
    if (marker.round !== expectedRound) {
      throw error(
        `round ${marker.round} is not the next eligible round for participant ${marker.participant}`,
      )
    }
    if (marker.round > 1 && expectedTaskID(session, marker) !== suppliedTaskID) {
      throw error(`task_id mismatch for participant ${marker.participant}, round ${marker.round}`)
    }
    record = {
      sessionID: input.sessionID,
      callID: input.callID,
      key,
      purpose: marker.purpose,
      status: "active",
      childSessionID: suppliedTaskID,
    }
    state.normal = record
  } else if (marker.purpose === "retry") {
    if (state.retry) {
      throw error(
        state.retry.status === "active"
          ? "retry is already active"
          : "only one retry is allowed for the recorded failure",
      )
    }
    if (normal !== "failed") {
      throw error("retry requires a recorded task failure")
    }
    if (expectedTaskID(session, marker) !== suppliedTaskID) {
      throw error(`task_id mismatch for retry participant ${marker.participant}, round ${marker.round}`)
    }
    record = {
      sessionID: input.sessionID,
      callID: input.callID,
      key,
      purpose: marker.purpose,
      status: "active",
      childSessionID: suppliedTaskID,
    }
    state.retry = record
  } else {
    if (normal !== "completed") {
      throw error("formatter correction requires a completed participant task")
    }
    if (expectedTaskID(session, marker) !== suppliedTaskID) {
      throw error(`task_id mismatch for formatter correction participant ${marker.participant}, round ${marker.round}`)
    }
    if (state.correction?.status === "active") {
      throw error("formatter correction is already active")
    }
    record = {
      sessionID: input.sessionID,
      callID: input.callID,
      key,
      purpose: marker.purpose,
      status: "active",
      childSessionID: suppliedTaskID,
    }
    state.correction = record
  }

  calls.set(callKey(input.sessionID, input.callID), record)
}

function complete(
  sessions: Map<string, SessionState>,
  calls: Map<CallKey, DispatchRecord>,
  sessionID: string,
  callID: string,
  status: "completed" | "failed",
  source: TerminalSource,
  childSessionID?: string,
): void {
  const record = calls.get(callKey(sessionID, callID))
  if (!record) return
  if (childSessionID !== undefined) {
    associateChildSession(calls, sessions, sessionID, callID, childSessionID)
  }
  if (source === "event" || record.terminalSource !== "event") {
    record.status = status
    record.terminalSource = source
  }

  const session = sessions.get(record.sessionID)
  const state = session?.get(record.key)
  if (!state) return

  if (record.purpose === "normal" && state.normal) {
    state.normal.status = record.status
    state.normal.childSessionID = record.childSessionID
    if (!state.retry) state.aggregateNormalStatus = record.status
  }
  if (record.purpose === "retry" && state.retry) {
    state.retry.status = record.status
    state.retry.childSessionID = record.childSessionID
    state.aggregateNormalStatus = record.status
  }
  if (record.purpose === "formatter-correction" && source === "event") {
    state.correction = undefined
  }
  if (source === "event") calls.delete(callKey(sessionID, callID))
}

function observeEvent(
  coordinatorSessions: Set<string>,
  sessions: Map<string, SessionState>,
  participantSubagentTypes: Map<string, Map<number, string>>,
  calls: Map<CallKey, DispatchRecord>,
  event: Event,
): void {
  if (event.type === "session.deleted") {
    const sessionID = event.properties.info.id
    sessions.delete(sessionID)
    participantSubagentTypes.delete(sessionID)
    coordinatorSessions.delete(sessionID)
    for (const [callID, record] of calls) {
      if (record.sessionID === sessionID || record.childSessionID === sessionID) calls.delete(callID)
    }
    for (const session of sessions.values()) {
      for (const [key, state] of session) {
        if (
          state.normal?.childSessionID === sessionID
          || state.retry?.childSessionID === sessionID
          || state.correction?.childSessionID === sessionID
        ) {
          session.delete(key)
        }
      }
    }
    return
  }

  if (event.type !== "message.part.updated") return
  const part = event.properties.part
  if (part?.type !== "tool" || part.tool !== "task") return
  if (part.state?.status === "running") {
    if (!calls.has(callKey(part.sessionID, part.callID))) return
    const childID = childSessionIDFrom("", part.state.metadata, part.metadata)
    associateChildSession(calls, sessions, part.sessionID, part.callID, childID)
    return
  }
  if (part.state?.status === "completed" || part.state?.status === "error") {
    const output = part.state.status === "completed" ? part.state.output : part.state.error
    const result = part.state.status === "completed" ? taskOutput(output) : undefined
    const childID = childSessionIDFrom(output, part.state.metadata, part.metadata)
    complete(
      sessions,
      calls,
      part.sessionID,
      part.callID,
      part.state.status === "error" || result?.status !== "completed" ? "failed" : "completed",
      "event",
      childID,
    )
  }
}

export function createTaskDispatchGuard(): {
  hooks: Hooks
  clear(): void
  state: TaskDispatchGuardState
} {
  const coordinatorSessions = new Set<string>()
  const sessions = new Map<string, SessionState>()
  const participantSubagentTypes = new Map<string, Map<number, string>>()
  const calls = new Map<CallKey, DispatchRecord>()

  return {
    hooks: {
      "command.execute.before": async (input, output) => {
        if (input.command !== "debate") return
        const text = output.parts.find((part) => part.type === "text")?.text
        if (!text?.startsWith("Run a debate with this parsed request.")) return
        const participantTypes = resolvedParticipantTypes(text)
        if (participantTypes === undefined) {
          if (text.includes("Resolved participants:")) {
            throw error("resolved participant mapping is malformed")
          }
          return
        }
        resetCompletedDebate(
          coordinatorSessions,
          sessions,
          participantSubagentTypes,
          calls,
          input.sessionID,
          participantTypes,
        )
      },
      "tool.execute.before": async (input, output) => {
        if (input.tool !== "task") return
        admit(coordinatorSessions, sessions, participantSubagentTypes, calls, input, output.args as Record<string, unknown>)
      },
      "tool.execute.after": async (input, output) => {
        if (input.tool !== "task") return
        if (!coordinatorSessions.has(input.sessionID)) return
        const result = taskOutput(output.output)
        const childID = childSessionIDFrom(output.output, output.metadata)
        associateChildSession(calls, sessions, input.sessionID, input.callID, childID)
        if (result.status === "running") return
        complete(
          sessions,
          calls,
          input.sessionID,
          input.callID,
          result.status === "completed" ? "completed" : "failed",
          "after",
          childID,
        )
      },
      event: async ({ event }) => observeEvent(coordinatorSessions, sessions, participantSubagentTypes, calls, event),
      dispose: async () => {
        coordinatorSessions.clear()
        sessions.clear()
        participantSubagentTypes.clear()
        calls.clear()
      },
    },
    state: { coordinatorSessions, sessions },
    clear() {
      coordinatorSessions.clear()
      sessions.clear()
      participantSubagentTypes.clear()
      calls.clear()
    },
  }
}

export const TaskDispatchGuardPlugin: Plugin = async () => createTaskDispatchGuard().hooks

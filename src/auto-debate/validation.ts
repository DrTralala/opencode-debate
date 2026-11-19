import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type {
  CheckpointSnapshot,
  ConversationState,
  Owner,
  RuntimeJournal,
  RuntimeReceipt,
  StorageBinding,
} from "./types.ts"

type RecordValue = Record<string, unknown>

export type JournalView = {
  members: Map<string, {
    origin: Extract<RuntimeReceipt, { kind: "member-bound" }>
    starts: Map<string, {
      open: Extract<RuntimeReceipt, { kind: "participant-start-open" }>
      closed?: Extract<RuntimeReceipt, { kind: "participant-start-closed" }>
    }>
    fenced: boolean
    confirmed: boolean
  }>
  deliveries: Map<string, {
    intent: Extract<RuntimeReceipt, { kind: "delivery-intent" }>
    attempt?: string
    noCall: boolean
    persisted: boolean
  }>
}

function isRecord(value: unknown): value is RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function fail(message: string): never {
  throw new Error(`Automatic-debate checkpoint ${message}`)
}

function snapshotFail(message: string): never {
  throw new Error(`Automatic-debate checkpoint snapshot ${message}`)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isBrief(value: unknown): boolean {
  return isRecord(value)
    && nonEmptyString(value.question)
    && nonEmptyString(value.objective)
    && isStringArray(value.facts)
    && isStringArray(value.assumptions)
    && isStringArray(value.constraints)
    && isStringArray(value.alternatives)
    && typeof value.uncertainty === "string"
    && nonEmptyString(value.neededOutcome)
}

function isParticipant(value: unknown): boolean {
  return isRecord(value)
    && nonEmptyString(value.agent)
    && typeof value.description === "string"
    && nonEmptyString(value.model)
    && (value.variant === undefined || nonEmptyString(value.variant))
}

function isOwner(value: unknown): value is Owner {
  return isRecord(value)
    && nonEmptyString(value.sessionID)
    && nonEmptyString(value.agent)
    && nonEmptyString(value.directory)
}

function isTurn(value: unknown): boolean {
  return isRecord(value)
    && nonEmptyString(value.participant)
    && Number.isSafeInteger(value.cycle)
    && Number.isSafeInteger(value.round)
    && typeof value.text === "string"
    && (value.consensus === undefined || typeof value.consensus === "boolean")
    && (value.stop === undefined || typeof value.stop === "boolean")
}

function isCycleResult(value: unknown): boolean {
  return isRecord(value)
    && Number.isSafeInteger(value.cycle)
    && Number.isSafeInteger(value.rounds)
    && ["complete", "partial", "cancelled", "interrupted"].includes(String(value.status))
    && ["unanimous-stop", "round-limit", "participant-failure", "explicit-stop", "obsolete", "shutdown"]
      .includes(String(value.reason))
    && Array.isArray(value.turns)
    && value.turns.every(isTurn)
    && Array.isArray(value.failures)
    && value.failures.every((failure) => isRecord(failure)
      && nonEmptyString(failure.participant)
      && typeof failure.message === "string")
    && typeof value.consensus === "boolean"
}

function isEvaluation(value: unknown): boolean {
  return isRecord(value)
    && Number.isSafeInteger(value.cycle)
    && typeof value.conclusion === "string"
    && isStringArray(value.caveats)
    && typeof value.rationale === "string"
    && ["act", "investigate", "continue", "report-unresolved"].includes(String(value.next))
    && (value.feedback === undefined || typeof value.feedback === "string")
}

function isDiscussion(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyString(value.id) || !isOwner(value.owner) || !isRecord(value.config)) return false
  const config = value.config
  if (typeof config.enabled !== "boolean"
    || !Number.isSafeInteger(config.maxRounds)
    || (config.maxRounds !== 0 && (config.maxRounds as number) < 3)
    || (value.roundsSpent !== undefined
      && (!Number.isSafeInteger(value.roundsSpent) || (value.roundsSpent as number) < 0))
    || typeof config.persistTranscripts !== "boolean"
    || !isBrief(value.brief)
    || !Array.isArray(value.panel)
    || !value.panel.every((member) => isRecord(member)
      && isParticipant(member.participant)
      && nonEmptyString(member.sessionID)
      && nonEmptyString(member.runtimeAgent))
    || !["running", "awaiting-evaluation", "paused", "resolved", "cancelled", "interrupted"].includes(String(value.status))
    || !Number.isSafeInteger(value.generation)
    || !Number.isSafeInteger(value.cycle)
    || !Array.isArray(value.results)
    || !value.results.every(isCycleResult)
    || !Array.isArray(value.evaluations)
    || !value.evaluations.every(isEvaluation)
    || !Array.isArray(value.pendingTurns)
    || !value.pendingTurns.every(isTurn)
    || !Array.isArray(value.followups)
    || !value.followups.every((followup) => isRecord(followup)
      && Number.isSafeInteger(followup.cycle)
      && typeof followup.feedback === "string")) return false

  if (value.deliveryUncertainCycles !== undefined
    && (!Array.isArray(value.deliveryUncertainCycles)
      || !value.deliveryUncertainCycles.every((item) => isRecord(item)
        && Number.isSafeInteger(item.cycle)
        && typeof item.reason === "string"))) return false
  if (value.transcriptPath !== undefined && typeof value.transcriptPath !== "string") return false
  if (value.transcriptError !== undefined && typeof value.transcriptError !== "string") return false
  if (value.cancellation !== undefined
    && (!isRecord(value.cancellation)
      || !isStringArray(value.cancellation.pendingSessionIDs)
      || !isStringArray(value.cancellation.errors))) return false
  return true
}

function isConversationState(value: unknown): value is ConversationState {
  return isRecord(value)
    && value.version === 1
    && (value.override === undefined || typeof value.override === "boolean")
    && Array.isArray(value.discussions)
    && value.discussions.every(isDiscussion)
    && Array.isArray(value.outbox)
    && value.outbox.every((item) => isRecord(item)
      && nonEmptyString(item.id)
      && nonEmptyString(item.discussionID)
      && Number.isSafeInteger(item.cycle)
      && (item.state === "pending" || item.state === "sent" || item.state === "acknowledged")
      && (item.messageID === undefined || nonEmptyString(item.messageID)))
}

export function parseConversationState(value: unknown): ConversationState {
  if (!isConversationState(value)) throw new Error("OpenCode automatic-debate checkpoint state is invalid or unsupported")
  return value
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function deliveryMessageID(owner: Owner, project: string, id: string): string {
  return `msg_${hash(JSON.stringify(["opencode-debate/delivery/v1", project, resolve(owner.directory), owner.sessionID, owner.agent, id]))}`
}

export function journalView(proof: RuntimeJournal | undefined): JournalView {
  const members: JournalView["members"] = new Map()
  const deliveries: JournalView["deliveries"] = new Map()
  for (const entry of proof?.entries ?? []) {
    switch (entry.kind) {
      case "member-bound": members.set(entry.member.sessionID, { origin: entry, starts: new Map(), fenced: false, confirmed: false }); break
      case "participant-start-open": members.get(entry.sessionID)!.starts.set(entry.messageID, { open: entry }); break
      case "participant-start-closed": members.get(entry.sessionID)!.starts.get(entry.messageID)!.closed = entry; break
      case "participant-fenced": members.get(entry.sessionID)!.fenced = true; break
      case "participant-stop-confirmed": members.get(entry.sessionID)!.confirmed = true; break
      case "delivery-intent": deliveries.set(entry.delivery.id, { intent: entry, noCall: false, persisted: false }); break
      case "delivery-dispatch-open": Object.assign(deliveries.get(entry.deliveryID)!, { attempt: entry.attemptID, noCall: false }); break
      case "delivery-no-call": deliveries.get(entry.deliveryID)!.noCall = true; break
      case "delivery-persisted": deliveries.get(entry.deliveryID)!.persisted = true; break
    }
  }
  return { members, deliveries }
}

/** Exact receipt shapes and causal transitions; a checksum is not an authority to forge a close.
 * `binding` may be omitted only for read-only eligibility checks that cannot derive the
 * private store's project; delivery message IDs remain verified by the store loader. */
export function parseRuntimeJournal(value: unknown, state: ConversationState, binding?: StorageBinding): RuntimeJournal | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)
    || Object.keys(value).some((key) => !["version", "entries"].includes(key))) fail("runtime proof journal is invalid")
  const entries: RuntimeReceipt[] = []
  const ids = new Set<string>(); const items = new Set<string>(); const attempts = new Set<string>()
  const string = (item: unknown): item is string => typeof item === "string" && item.trim().length > 0
  const integer = (item: unknown, minimum: number) => Number.isSafeInteger(item) && (item as number) >= minimum
  const exact = (entry: RecordValue, keys: string[]) => Object.keys(entry).every((key) => keys.includes(key))
  for (const raw of value.entries) {
    if (!isRecord(raw) || !string(raw.kind)) fail("runtime receipt is invalid")
    const view = journalView({ version: 1, entries })
    const member = view.members.get(String(raw.sessionID))
    const delivery = view.deliveries.get(String(raw.deliveryID))
    let valid = false
    switch (raw.kind) {
      case "owner-invocation-admitted":
        valid = entries.length === 0 && exact(raw, ["kind", "messageID", "callID", "partID"])
          && string(raw.messageID) && string(raw.callID) && string(raw.partID)
        break
      case "member-bound": {
        const discussion = state.discussions.find((item) => item.id === raw.discussionID)
        const saved = discussion?.panel.find((item) => isRecord(raw.member) && item.sessionID === raw.member.sessionID)
        valid = exact(raw, ["kind", "discussionID", "member", "nonce", "permission"])
          && !!saved && JSON.stringify(saved) === JSON.stringify(raw.member) && !view.members.has(saved.sessionID)
          && typeof raw.nonce === "string" && /^[a-f0-9]{32}$/.test(raw.nonce)
          && Array.isArray(raw.permission) && raw.permission.every((rule) => isRecord(rule)
            && exact(rule, ["permission", "pattern", "action"]) && string(rule.permission)
            && typeof rule.pattern === "string" && ["allow", "ask", "deny"].includes(String(rule.action)))
        break
      }
      case "participant-start-open":
        valid = exact(raw, ["kind", "sessionID", "messageID", "discussionID", "generation", "cycle", "textDigest"])
          && !!member && !member.fenced && [...member.starts.values()].every((start) => start.closed)
          && raw.discussionID === member.origin.discussionID && integer(raw.generation, 0) && integer(raw.cycle, 1)
          && string(raw.messageID) && !ids.has(raw.messageID) && typeof raw.textDigest === "string" && /^[a-f0-9]{64}$/.test(raw.textDigest)
        if (valid) ids.add(raw.messageID as string)
        break
      case "participant-start-closed": {
        const start = member?.starts.get(String(raw.messageID))
        valid = exact(raw, ["kind", "sessionID", "messageID", "startup", "outcome", "assistantID"])
          && !!start && !start.closed && ["synchronous-response", "never-invoked"].includes(String(raw.startup))
          && ["answer", "definite-failure"].includes(String(raw.outcome))
          && (raw.assistantID === undefined ? raw.outcome === "definite-failure" : string(raw.assistantID))
          && (raw.startup !== "never-invoked" || raw.outcome === "definite-failure" && raw.assistantID === undefined)
        break
      }
      case "participant-fenced": valid = exact(raw, ["kind", "sessionID"]) && !!member && !member.fenced; break
      case "participant-stop-confirmed":
        valid = exact(raw, ["kind", "sessionID"]) && !!member && member.fenced && !member.confirmed
          && [...member.starts.values()].every((start) => start.closed)
        break
      case "delivery-intent": {
        const intent = raw.delivery
        const selection = raw.selection
        valid = exact(raw, ["kind", "delivery", "messageID", "selection"])
          && isRecord(intent) && exact(intent, ["id", "outboxIDs", "text"]) && string(intent.id) && string(intent.text)
          && !view.deliveries.has(intent.id) && Array.isArray(intent.outboxIDs) && intent.outboxIDs.length > 0
          && intent.outboxIDs.every((id) => string(id) && !items.has(id))
          && JSON.stringify(intent.outboxIDs) === JSON.stringify([...new Set(intent.outboxIDs)].sort())
          && intent.outboxIDs.every((id) => state.outbox.filter((item) => item.id === id).length === 1
            && state.discussions.some((discussion) => discussion.id === state.outbox.find((item) => item.id === id)!.discussionID
              && discussion.results.some((result) => result.cycle === state.outbox.find((item) => item.id === id)!.cycle)))
          && (binding === undefined || raw.messageID === deliveryMessageID({
            sessionID: binding.owner, directory: binding.directory, agent: binding.agent,
          }, binding.project, intent.id))
          && isRecord(selection) && exact(selection, ["agent", "model"])
          && (binding === undefined ? string(selection.agent) : selection.agent === binding.agent)
          && isRecord(selection.model) && exact(selection.model, ["providerID", "modelID", "variant"])
          && string(selection.model.providerID) && string(selection.model.modelID)
          && (selection.model.variant === undefined || string(selection.model.variant))
        if (valid) for (const id of (intent as { outboxIDs: string[] }).outboxIDs) items.add(id)
        break
      }
      case "delivery-dispatch-open":
        valid = exact(raw, ["kind", "deliveryID", "attemptID"]) && !!delivery && !delivery.persisted
          && (!delivery.attempt || delivery.noCall) && string(raw.attemptID) && !attempts.has(raw.attemptID)
        if (valid) attempts.add(raw.attemptID as string)
        break
      case "delivery-no-call":
        valid = exact(raw, ["kind", "deliveryID", "attemptID"]) && !!delivery && !delivery.persisted
          && !delivery.noCall && delivery.attempt === raw.attemptID && string(raw.attemptID)
        break
      case "delivery-persisted":
        valid = exact(raw, ["kind", "deliveryID", "messageID"]) && !!delivery && !delivery.persisted
          && !!delivery.attempt && !delivery.noCall && delivery.intent.messageID === raw.messageID
        break
    }
    if (!valid) fail("runtime receipt/proof transition is invalid")
    entries.push(raw as RuntimeReceipt)
  }
  return { version: 1, entries }
}

export function assertRuntimeProofPrefix(previous: RuntimeJournal | undefined, next: RuntimeJournal | undefined): void {
  if (previous && (!next || next.entries.length < previous.entries.length
    || JSON.stringify(next.entries.slice(0, previous.entries.length)) !== JSON.stringify(previous.entries))) {
    fail("runtime proof receipt prefix was removed or changed")
  }
}

const OPTIONAL_UNDEFINED = new Set([
  ["runtimeProof"],
  ["legacyOutboxIDs"],
  ["state", "override"],
  ["state", "discussions", "[]", "config", "set"],
  ["state", "discussions", "[]", "roundsSpent"],
  ["state", "discussions", "[]", "deliveryUncertainCycles"],
  ["state", "discussions", "[]", "transcriptPath"],
  ["state", "discussions", "[]", "transcriptError"],
  ["state", "discussions", "[]", "cancellation"],
  ["state", "discussions", "[]", "results", "[]", "turns", "[]", "consensus"],
  ["state", "discussions", "[]", "results", "[]", "turns", "[]", "stop"],
  ["state", "discussions", "[]", "pendingTurns", "[]", "consensus"],
  ["state", "discussions", "[]", "pendingTurns", "[]", "stop"],
  ["state", "discussions", "[]", "evaluations", "[]", "feedback"],
  ["state", "outbox", "[]", "messageID"],
  ["state", "discussions", "[]", "panel", "[]", "participant", "variant"],
  ["runtimeProof", "entries", "[]", "assistantID"],
  ["runtimeProof", "entries", "[]", "selection", "model", "variant"],
].map((path) => JSON.stringify(path)))

function cloneJsonValue(value: unknown, path: string[], stack: WeakSet<object>): unknown {
  if (value === null) return null

  const type = typeof value
  if (type === "string" || type === "boolean") return value
  if (type === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) snapshotFail("contains a non-JSON number")
    return value
  }
  if (typeof value !== "object" || value === null) snapshotFail("contains a non-JSON value")
  if (stack.has(value)) snapshotFail("contains a cycle")

  stack.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) snapshotFail("contains a non-plain array")
      if (Object.getOwnPropertySymbols(value).length > 0) snapshotFail("contains symbol keys")
      for (const key in value) if (!Object.hasOwn(value, key)) snapshotFail("contains inherited properties")

      const names = Object.getOwnPropertyNames(value)
      if (names.length !== value.length + 1) snapshotFail("contains a sparse array or named properties")
      const copy: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index)
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          snapshotFail("contains a sparse array or accessor")
        }
        copy.push(cloneJsonValue(descriptor.value, [...path, "[]"], stack))
      }
      return copy
    }

    if (!isRecord(value)) snapshotFail("contains a non-plain object")
    if (Object.getOwnPropertySymbols(value).length > 0) snapshotFail("contains symbol keys")
    for (const key in value) if (!Object.hasOwn(value, key)) snapshotFail("contains inherited properties")

    const copy: RecordValue = {}
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable) snapshotFail("contains a non-enumerable property")
      if (!Object.hasOwn(descriptor, "value")) snapshotFail("contains an accessor property")
      const childPath = [...path, key]
      if (descriptor.value === undefined) {
        if (!OPTIONAL_UNDEFINED.has(JSON.stringify(childPath))) snapshotFail("contains an undeclared undefined property")
        continue
      }
      Object.defineProperty(copy, key, {
        value: cloneJsonValue(descriptor.value, childPath, stack),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return copy
  } finally {
    stack.delete(value)
  }
}

function parseLegacyOutboxIDs(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) snapshotFail("legacy outbox IDs are invalid")
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0 || seen.has(item)) {
      snapshotFail("legacy outbox IDs are invalid")
    }
    seen.add(item)
  }
  return [...value]
}

/** Capture exactly the JSON-compatible tree an append may persist, without executing getters. */
export function cloneCheckpointSnapshot(value: unknown, binding: StorageBinding): CheckpointSnapshot {
  const cloned = cloneJsonValue(value, [], new WeakSet())
  if (!isRecord(cloned)) snapshotFail("is not a plain object")
  const state = parseConversationState(cloned.state)
  const runtimeProof = parseRuntimeJournal(cloned.runtimeProof, state, binding)
  const legacyOutboxIDs = parseLegacyOutboxIDs(cloned.legacyOutboxIDs)
  if (state.discussions.some((discussion) => discussion.owner.sessionID !== binding.owner
    || discussion.owner.agent !== binding.agent
    || resolve(discussion.owner.directory) !== binding.directory)) {
    snapshotFail("contains a foreign discussion owner")
  }
  return {
    state,
    ...(runtimeProof === undefined ? {} : { runtimeProof }),
    ...(legacyOutboxIDs === undefined ? {} : { legacyOutboxIDs }),
  }
}

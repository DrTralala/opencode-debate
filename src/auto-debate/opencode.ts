import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import type { DebateParticipant } from "../participants.ts"
import type { CheckpointSnapshot, ConversationState, DeliveryIntent, DeliveryReconciliation, Owner, OwnerPermissionSnapshot, PanelMember, ParticipantReconciliation, Rule, Runtime, RuntimeReceipt } from "./types.ts"
import { AUTOMATIC_PARTICIPANT_KEY, assertAutomaticParticipantMarker, automaticParticipantMarker, createCheckpointStore, deliveryMessageID, journalView, type CurrentInvocation, type RefusedInvocation } from "./checkpoint.ts"

const MANUAL_COORDINATOR = "debate"
const PARTICIPANT_BASELINE: readonly Rule[] = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "read", pattern: "*", action: "allow" },
  { permission: "grep", pattern: "*", action: "allow" },
  { permission: "glob", pattern: "*", action: "allow" },
  { permission: "lsp", pattern: "*", action: "allow" },
  { permission: "webfetch", pattern: "*", action: "allow" },
  { permission: "websearch", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: "*", action: "deny" },
]
const IMMUTABLE_PARTICIPANT_DENIALS: readonly Rule[] = [
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "skill", pattern: "*", action: "deny" },
  { permission: "question", pattern: "*", action: "deny" },
  { permission: "auto_debate", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
]

type RecordValue = Record<string, unknown>
type NativeSession = RecordValue & {
  id: string
  projectID: string
  directory: string
  parentID?: unknown
  agent?: unknown
  model?: unknown
  permission?: unknown
  metadata?: unknown
}
type NativeAgent = RecordValue & {
  name: string
  mode: string
  permission: unknown
}
type NativeMessage = RecordValue & {
  info: RecordValue
  parts: unknown[]
}
type Dispatch = {
  messageID: string
  assistantID?: string
  done: boolean
  dispatched: boolean
  startupSettled: boolean
  settled: Promise<void>
  finish: () => void
}
type ParticipantState = {
  member: PanelMember
  owner: Owner
  nonce: string
  permission: readonly Rule[]
  managed: boolean
  unjournalled: boolean
  restoredCycle?: number
  restoredGeneration?: number
  phase: "open" | "restorable" | "stopping" | "stopped"
  messageIDs: Set<string>
  dispatch?: Dispatch
  uncertain: boolean
  stop?: Promise<void>
}
type SessionCreateOptions = NonNullable<Parameters<PluginInput["client"]["session"]["create"]>[0]>
type NativeSessionCreateRequest = Omit<SessionCreateOptions, "body"> & {
  body: NonNullable<SessionCreateOptions["body"]> & {
    agent: string
    model: { providerID: string; id: string; variant?: string }
    permission: Rule[]
    metadata: RecordValue
  }
}
type SessionPromptOptions = NonNullable<Parameters<PluginInput["client"]["session"]["prompt"]>[0]>
type NativeSessionPromptRequest = Omit<SessionPromptOptions, "body"> & {
  body: NonNullable<SessionPromptOptions["body"]> & { variant?: string }
}
type SessionPromptAsyncOptions = NonNullable<Parameters<PluginInput["client"]["session"]["promptAsync"]>[0]>
type NativeSessionPromptAsyncRequest = Omit<SessionPromptAsyncOptions, "body"> & {
  body: NonNullable<SessionPromptAsyncOptions["body"]> & { variant?: string }
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
  throw new Error(message)
}

function assertResponse(value: unknown, operation: string): RecordValue {
  if (!isRecord(value)) fail(`OpenCode ${operation} returned an invalid response`)
  if (value.error !== undefined && value.error !== null) {
    fail(`OpenCode ${operation} request failed`)
  }
  return value
}

function responseData<T>(value: unknown, operation: string): T {
  const envelope = assertResponse(value, operation)
  if (!Object.hasOwn(envelope, "data") || envelope.data === undefined || envelope.data === null) {
    fail(`OpenCode ${operation} returned no data`)
  }
  return envelope.data as T
}

function isRule(value: unknown): value is Rule {
  return isRecord(value)
    && nonEmptyString(value.permission)
    && typeof value.pattern === "string"
    && (value.action === "allow" || value.action === "ask" || value.action === "deny")
}

function readRules(value: unknown, source: string, optional = false): Rule[] {
  if (value === undefined && optional) return []
  if (!Array.isArray(value) || !value.every(isRule)) {
    fail(`OpenCode ${source} permission rules are unavailable or invalid`)
  }
  return value.map(({ permission, pattern, action }) => ({ permission, pattern, action }))
}

export function restrictRules(rules: readonly Rule[]): Rule[] {
  return rules
    .filter((rule) => rule.action !== "allow")
    .map((rule) => ({ ...rule }))
}

export function inheritRestrictions(base: readonly Rule[], parent: readonly Rule[]): Rule[] {
  return [...base.map((rule) => ({ ...rule })), ...restrictRules(parent)]
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

function isParticipant(value: unknown): value is DebateParticipant {
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
    || (config.maxRounds as number) < 3
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

function parseConversationState(value: unknown): ConversationState {
  if (!isConversationState(value)) fail("OpenCode automatic-debate checkpoint state is invalid or unsupported")
  return value
}

function parseModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) fail("Automatic-debate participant model must be provider/model")
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function sessionModel(value: unknown): { providerID: string; modelID: string; variant?: string } {
  if (!isRecord(value) || !nonEmptyString(value.providerID)) fail("OpenCode session model is unavailable or invalid")
  const modelID = typeof value.id === "string" ? value.id : value.modelID
  if (!nonEmptyString(modelID)) fail("OpenCode session model is unavailable or invalid")
  if (value.variant !== undefined && !nonEmptyString(value.variant)) fail("OpenCode session model variant is invalid")
  return {
    providerID: value.providerID,
    modelID,
    ...(value.variant === undefined || value.variant === "default" ? {} : { variant: value.variant }),
  }
}

function sameModel(actual: unknown, participant: DebateParticipant): boolean {
  const expected = parseModel(participant.model)
  const current = sessionModel(actual)
  return current.providerID === expected.providerID
    && current.modelID === expected.modelID
    && current.variant === participant.variant
}

function nativeSession(value: unknown, operation: string): NativeSession {
  if (!isRecord(value)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.projectID)
    || !nonEmptyString(value.directory)) {
    fail(`OpenCode ${operation} returned an invalid session`)
  }
  return value as NativeSession
}

function nativeMessage(value: unknown): NativeMessage {
  if (!isRecord(value) || !isRecord(value.info) || !Array.isArray(value.parts)) {
    fail("OpenCode delivery message is unavailable or invalid")
  }
  return value as NativeMessage
}

function isNotFound(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.response instanceof Response) return value.response.status === 404
  if (value.status === 404 || value.statusCode === 404) return true
  return isRecord(value.response) && (value.response.status === 404 || value.response.statusCode === 404)
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

export interface NativeRuntime extends Runtime {
  /** Called only by the native tool.execute.before hook, not by tool arguments. */
  noteToolInvocation(input: { tool: string; sessionID: string; callID: string }): void
  discardToolInvocation(context: ToolContext): void
  /** Retain exact host-witnessed non-dispatch only when permission rejected
   * before admission. No child/write; new runtime instances have no such proof. */
  refuseToolInvocation(owner: Owner, context: ToolContext): Promise<void>
  /** Consume the host witness, verify its context-bound native identity, and
   * seal checked first-use state before recovery/dispatch. No witness grants no exemption. */
  admitToolInvocation(owner: Owner, context: ToolContext): Promise<void>
}

export function createRuntime(input: PluginInput): NativeRuntime {
  const saveLocks = new Map<string, Promise<void>>()
  const refusals = new Map<string, RefusedInvocation[]>()
  const checkpoints = createCheckpointStore(input, parseConversationState, (owner) => refusals.get(owner.sessionID) ?? [])
  // Only this instance's freshly created sessions have known startup provenance.
  // Keep stopped records as tombstones; never adopt recovered sessions from idle alone.
  const participants = new Map<string, ParticipantState>()
  const snapshots = new Map<string, CheckpointSnapshot>()
  const deliveryCalls = new Map<string, { owner: Owner; intent: DeliveryIntent; pending: Promise<DeliveryReconciliation> }>()
  const invocations = new Set<string>()
  const invocationKey = (sessionID: string, callID: string) => JSON.stringify([sessionID, callID])

  function participantState(member: PanelMember): ParticipantState {
    if (!isRecord(member) || !nonEmptyString(member.sessionID) || !isParticipant(member.participant)) {
      fail("Automatic-debate participant session is invalid")
    }
    const state = participants.get(member.sessionID)
    if (!state) fail("Automatic-debate participant has unknown startup provenance: not owned by this runtime")
    if (state.member.runtimeAgent !== member.runtimeAgent
      || state.member.participant.agent !== member.participant.agent
      || state.member.participant.model !== member.participant.model
      || state.member.participant.variant !== member.participant.variant) {
      fail("Automatic-debate participant does not match its adapter-owned identity")
    }
    return state
  }

  function assertOpen(state: ParticipantState): void {
    if (state.phase !== "open") fail("Automatic-debate participant is stopping or stopped; prompt cancelled")
  }

  async function nativeAbort(member: PanelMember): Promise<void> {
    const result = responseData<unknown>(await input.client.session.abort({
      path: { id: member.sessionID }, query: { directory: input.directory },
    }), "participant abort")
    if (result !== true) fail("OpenCode did not acknowledge participant cancellation")
  }

  async function verifyCessation(state: ParticipantState): Promise<void> {
    const member = state.member
    await readParticipant(member)
    const dispatch = state.dispatch
    // A true abort while startup is pending is only an acknowledgement. Reconcile
    // until the owned synchronous prompt request has passed its startup boundary.
    while (dispatch && !dispatch.done) {
      if (dispatch.dispatched) await nativeAbort(member)
      await Promise.race([dispatch.settled, sleep(25)])
    }
    if (state.uncertain || (dispatch?.dispatched && !dispatch.startupSettled)) {
      await nativeAbort(member) // Contain a current runner, but cannot certify an unknown future start.
      fail("Automatic-debate cancellation is unconfirmed: native startup/transport outcome is uncertain")
    }
    while (true) {
      // This call follows exhaustion of every owned starter. On the reviewed
      // native API it joins interruption of an existing runner, unlike an early
      // idle acknowledgement. An intermediate prompt response is not termination.
      await nativeAbort(member)
      const statuses = responseData<unknown>(await input.client.session.status({
        query: { directory: input.directory },
      }), "cancellation status")
      if (!isRecord(statuses)) fail("OpenCode cancellation status is unavailable")
      const status = statuses[member.sessionID]
      if (status !== undefined && (!isRecord(status) || !["idle", "busy", "retry"].includes(String(status.type)))) {
        fail("OpenCode cancellation status is invalid")
      }
      const messages = responseData<unknown>(await input.client.session.messages({
        path: { id: member.sessionID }, query: { directory: input.directory },
      }), "cancellation history")
      if (!Array.isArray(messages)) fail("OpenCode cancellation history is invalid")
      let pending = false
      for (const value of messages) {
        const message = nativeMessage(value)
        const info = message.info
        if (info.role === "user" && !state.messageIDs.has(String(info.id))) {
          state.uncertain = true
          fail("Automatic-debate cancellation is unconfirmed: unowned native prompt in participant history")
        }
        if (info.role !== "assistant") continue
        if (!state.messageIDs.has(String(info.parentID))) {
          state.uncertain = true
          fail("Automatic-debate cancellation is unconfirmed: unowned native assistant in participant history")
        }
        if (!isRecord(info.time) || typeof info.time.completed !== "number") pending = true
        if (message.parts.some((part) => isRecord(part) && part.type === "tool"
          && (!isRecord(part.state) || !["completed", "error"].includes(String(part.state.status))))) pending = true
      }
      if ((status === undefined || (isRecord(status) && status.type === "idle")) && !pending) {
        state.phase = "stopped"
        return
      }
      await sleep(25) // Poll cadence, never a quiet-period proof or feature budget.
    }
  }

  async function readOwner(owner: Owner): Promise<{ session: NativeSession; agent: NativeAgent; rules: Rule[];
    agentRules: Rule[]; sessionRules: Rule[] }> {
    if (!isOwner(owner)) fail("Automatic-debate owner context is missing or invalid")
    const directory = resolve(owner.directory)
    if (directory !== resolve(input.directory)) fail("Automatic-debate owner directory does not match this runtime")
    const projectID = input.project.id
    if (!nonEmptyString(projectID)) fail("OpenCode project identity is unavailable")

    const sessionRequest = {
      path: { id: owner.sessionID },
      query: { directory: owner.directory },
    }
    const session = nativeSession(
      responseData<unknown>(await input.client.session.get(sessionRequest), "owner session lookup"),
      "owner session lookup",
    )
    if (session.id !== owner.sessionID
      || session.projectID !== projectID
      || resolve(session.directory) !== directory
      || (session.parentID !== undefined && session.parentID !== null)) {
      fail("Automatic-debate owner must be a root session in the current project and directory")
    }
    if (session.agent !== owner.agent) fail("Automatic-debate owner agent does not match the current session agent")

    const agents = responseData<unknown>(
      await input.client.app.agents({ query: { directory: owner.directory } }),
      "effective agent lookup",
    )
    if (!Array.isArray(agents)) fail("OpenCode effective agent list is invalid")
    const agentValue = agents.find((candidate) => isRecord(candidate) && candidate.name === owner.agent)
    if (!isRecord(agentValue)
      || !nonEmptyString(agentValue.name)
      || typeof agentValue.mode !== "string") {
      fail("Automatic-debate owner agent is unavailable")
    }
    const agent = agentValue as NativeAgent
    if (agent.name === MANUAL_COORDINATOR) fail("The manual debate coordinator cannot own automatic debate")
    if (agent.mode !== "primary" && agent.mode !== "all") {
      fail("Automatic-debate owner must be a primary or all-mode agent, not a participant")
    }
    const agentRules = readRules(agent.permission, "effective owner agent")
    const sessionRules = readRules(session.permission, "owner session", true)
    return { session, agent, rules: [...agentRules, ...sessionRules], agentRules, sessionRules }
  }

  async function readParticipant(member: PanelMember): Promise<NativeSession> {
    if (!isRecord(member)
      || !nonEmptyString(member.sessionID)
      || !nonEmptyString(member.runtimeAgent)
      || !isParticipant(member.participant)
      || member.runtimeAgent !== member.participant.agent) {
      fail("Automatic-debate participant session is invalid")
    }
    const session = nativeSession(responseData<unknown>(
      await input.client.session.get({
        path: { id: member.sessionID },
        query: { directory: input.directory },
      }),
      "participant session lookup",
    ), "participant session lookup")
    if (session.id !== member.sessionID
      || session.projectID !== input.project.id
      || resolve(session.directory) !== resolve(input.directory)
      || !nonEmptyString(session.parentID)
      || session.agent !== member.runtimeAgent
      || !sameModel(session.model, member.participant)) {
      fail("Automatic-debate participant session does not match its stored identity")
    }
    return session
  }

  async function withSaveLock<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = saveLocks.get(sessionID) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
    saveLocks.set(sessionID, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (saveLocks.get(sessionID) === current) saveLocks.delete(sessionID)
    }
  }

  function snapshot(owner: Owner): CheckpointSnapshot {
    return snapshots.get(owner.sessionID) ?? fail("Automatic-debate checkpoint must be loaded/initialised before reconciliation")
  }

  async function thisIdle(owner: Owner): Promise<boolean> {
    await readOwner(owner)
    const statuses = responseData<unknown>(await input.client.session.status({ query: { directory: owner.directory } }), "session status lookup")
    if (!isRecord(statuses)) fail("OpenCode session status response is invalid")
    const status = statuses[owner.sessionID]
    if (status !== undefined && (!isRecord(status) || !["idle", "busy", "retry"].includes(String(status.type)))) fail("OpenCode owner status is invalid")
    return status === undefined || (isRecord(status) && status.type === "idle")
  }

  async function append(owner: Owner, entries: readonly RuntimeReceipt[], state?: ConversationState): Promise<void> {
    // Caller holds the same owner lock used by manager saves. Proof is never taken from a caller snapshot.
    const current = snapshots.get(owner.sessionID)
    const next: CheckpointSnapshot = { state: state ?? snapshot(owner).state,
      runtimeProof: { version: 1, entries: [...(current?.runtimeProof?.entries ?? []), ...entries] },
      legacyOutboxIDs: current?.legacyOutboxIDs }
    const { session } = await readOwner(owner)
    await checkpoints.save(owner, next, { agent: owner.agent, model: sessionModel(session.model) })
    snapshots.set(owner.sessionID, structuredClone(next))
    refusals.delete(owner.sessionID) // An acknowledged store now owns the fail-closed history boundary.
  }

  async function receipt(owner: Owner, entry: RuntimeReceipt): Promise<void> {
    await withSaveLock(owner.sessionID, () => append(owner, [entry]))
  }

  async function refresh(owner: Owner): Promise<CheckpointSnapshot | undefined> {
    return withSaveLock(owner.sessionID, async () => {
      try {
        await readOwner(owner)
        const loaded = await checkpoints.load(owner)
        if (loaded) snapshots.set(owner.sessionID, structuredClone(loaded))
        else snapshots.delete(owner.sessionID)
        return loaded
      } catch (error) {
        snapshots.delete(owner.sessionID) // A failed recovery cannot leave a usable old proof cache.
        throw error
      }
    })
  }

  function bound(state: ParticipantState) {
    return journalView(snapshots.get(state.owner.sessionID)?.runtimeProof).members.get(state.member.sessionID)
  }

  function associated(state: ParticipantState) {
    const discussions = snapshot(state.owner).state.discussions.filter((discussion) => discussion.panel.some((member) => member.sessionID === state.member.sessionID))
    if (discussions.length !== 1) fail("Automatic-debate participant is not bound to exactly one saved discussion")
    return discussions[0]
  }

  async function participantEvidence(state: ParticipantState): Promise<void> {
    const proof = bound(state)
    if (!proof) fail("Automatic-debate participant has unknown durable startup provenance")
    const { rules } = await readOwner(state.owner)
    const native = await readParticipant(state.member)
    assertAutomaticParticipantMarker(native, state.owner, input.project.id, proof.origin.nonce)
    const expectedRules = [...inheritRestrictions(PARTICIPANT_BASELINE, restrictRules(rules)), ...IMMUTABLE_PARTICIPANT_DENIALS]
    if (JSON.stringify(native.permission) !== JSON.stringify(proof.origin.permission)
      || JSON.stringify(proof.origin.permission) !== JSON.stringify(expectedRules)) fail("Automatic-debate participant permissions changed or widened")
    const statuses = responseData<unknown>(await input.client.session.status({ query: { directory: input.directory } }), "participant reconciliation status")
    if (!isRecord(statuses)) fail("Automatic-debate participant status is invalid")
    const status = statuses[state.member.sessionID]
    if (status !== undefined && (!isRecord(status) || status.type !== "idle")) fail("Automatic-debate participant work is not exhausted")
    const messages = responseData<unknown>(await input.client.session.messages({ path: { id: state.member.sessionID },
      query: { directory: input.directory } }), "participant reconciliation history")
    if (!Array.isArray(messages)) fail("Automatic-debate participant history is invalid")
    const users = new Set<string>(); const assistants = new Set<string>()
    for (const value of messages) {
      const message = nativeMessage(value)
      const info = message.info
      if (!nonEmptyString(info.id) || info.sessionID !== state.member.sessionID
        || !["user", "assistant"].includes(String(info.role))) fail("Automatic-debate participant history binding is invalid")
      if (message.parts.some((part) => !isRecord(part) || !nonEmptyString(part.id)
        || part.sessionID !== state.member.sessionID || part.messageID !== info.id)) fail("Automatic-debate participant part binding is invalid")
      if (info.role === "user") {
        const start = proof.starts.get(info.id)
        if (!start || users.has(info.id) || info.agent !== state.member.runtimeAgent || !sameModel(info.model, state.member.participant)
          || message.parts.length !== 1 || !isRecord(message.parts[0]) || message.parts[0].type !== "text"
          || typeof message.parts[0].text !== "string"
          || createHash("sha256").update(message.parts[0].text).digest("hex") !== start.open.textDigest) {
          fail("Automatic-debate participant has unowned or changed prompt history")
        }
        users.add(info.id)
      } else {
        if (!proof.starts.has(String(info.parentID)) || !isRecord(info.time) || typeof info.time.completed !== "number"
          || message.parts.some((part) => isRecord(part) && part.type === "tool"
            && (!isRecord(part.state) || !["completed", "error"].includes(String(part.state.status))))) {
          fail("Automatic-debate participant has unowned or unfinished assistant work")
        }
        assistants.add(info.id)
      }
    }
    for (const [id, start] of proof.starts) {
      if (start.closed?.outcome === "answer" && (!users.has(id) || !assistants.has(start.closed.assistantID!))) {
        fail("Automatic-debate participant terminal history is missing")
      }
    }
  }

  async function closeStart(state: ParticipantState, dispatch: Dispatch, outcome: "answer" | "definite-failure") {
    const proof = bound(state)
    if (!proof?.starts.has(dispatch.messageID) || proof.starts.get(dispatch.messageID)!.closed) return
    const neverInvoked = !dispatch.dispatched && dispatch.done
    if (!dispatch.startupSettled && !neverInvoked) fail("Automatic-debate startup remains unconfirmed")
    await participantEvidence(state)
    await receipt(state.owner, { kind: "participant-start-closed", sessionID: state.member.sessionID,
      messageID: dispatch.messageID, startup: neverInvoked ? "never-invoked" : "synchronous-response", outcome,
      ...(dispatch.assistantID === undefined ? {} : { assistantID: dispatch.assistantID }) })
  }

  async function inspectDelivery(owner: Owner, id: string): Promise<DeliveryReconciliation> {
    const record = journalView(snapshot(owner).runtimeProof).deliveries.get(id) ?? fail("Automatic-debate delivery has no durable intent")
    const { intent } = record
    const base = { delivery: structuredClone(intent.delivery), messageID: intent.messageID }
    let lookup: unknown
    try {
      lookup = await input.client.session.message({ path: { id: owner.sessionID, messageID: intent.messageID }, query: { directory: owner.directory } })
    } catch { return { ...base, state: "uncertain", reason: "Native delivery lookup failed" } }
    if (isNotFound(lookup)) {
      if (record.persisted || record.attempt && !record.noCall) return { ...base, state: "uncertain", reason: "Native submission may still persist or persisted history was lost" }
      return { ...base, state: "not-dispatched", proof: record.noCall ? "sealed-before-call" : "intent-only" }
    }
    try {
      const message = nativeMessage(responseData(lookup, "delivery reconciliation"))
      if (message.info.id !== intent.messageID || message.info.sessionID !== owner.sessionID || message.info.role !== "user"
        || message.info.agent !== intent.selection.agent
        || JSON.stringify(sessionModel(message.info.model)) !== JSON.stringify(intent.selection.model)
        || message.parts.length !== 1 || !isRecord(message.parts[0]) || message.parts[0].type !== "text"
        || !nonEmptyString(message.parts[0].id) || message.parts[0].sessionID !== owner.sessionID
        || message.parts[0].messageID !== intent.messageID || message.parts[0].text !== intent.delivery.text) {
        return { ...base, state: "uncertain", reason: "Native delivery content/identity is incomplete or conflicting" }
      }
    } catch { return { ...base, state: "uncertain", reason: "Native delivery lookup is invalid or failed" } }
    if (!record.attempt || record.noCall) return { ...base, state: "uncertain", reason: "Unowned delivery message without a dispatch receipt" }
    if (!record.persisted) await withSaveLock(owner.sessionID, async () => {
      if (!journalView(snapshot(owner).runtimeProof).deliveries.get(id)!.persisted) {
        await append(owner, [{ kind: "delivery-persisted", deliveryID: id, messageID: intent.messageID }])
      }
    })
    return { ...base, state: "persisted" }
  }

  function consumeInvocation(owner: Owner, context: ToolContext): string | undefined {
    // Native 1.18.35 supplies callID; compatibility-floor typings do not yet declare it.
    const callID = (context as ToolContext & { callID?: unknown }).callID
    return nonEmptyString(callID) && invocations.delete(invocationKey(owner.sessionID, callID)) ? callID : undefined
  }

  async function readCurrentInvocation(owner: Owner, context: ToolContext, callID: string) {
    const { session } = await readOwner(owner)
    if (context.sessionID !== owner.sessionID || context.agent !== owner.agent
      || resolve(context.directory) !== resolve(owner.directory) || !nonEmptyString(context.messageID)
      || !(context.abort instanceof AbortSignal) || context.abort.aborted) fail("Current native invocation context is invalid")
    const message = nativeMessage(responseData(await input.client.session.message({ path: { id: owner.sessionID,
      messageID: context.messageID }, query: { directory: owner.directory } }), "current native invocation lookup"))
    const info = message.info
    if (info.id !== context.messageID || info.sessionID !== owner.sessionID || info.role !== "assistant"
      || info.agent !== owner.agent || info.summary === true || !isRecord(info.time)
      || typeof info.time.created !== "number" || info.time.completed !== undefined) fail("Current native invocation assistant binding is invalid")
    const parts = message.parts.filter((part): part is RecordValue => isRecord(part) && part.callID === callID)
    const part = parts[0]
    if (parts.length !== 1 || !nonEmptyString(part.id) || part.sessionID !== owner.sessionID
      || part.messageID !== info.id || part.type !== "tool" || part.tool !== "auto_debate"
      || !isRecord(part.state) || !["pending", "running"].includes(String(part.state.status))) fail("Current native invocation tool binding is invalid")
    const invocation: CurrentInvocation = { messageID: context.messageID, callID, partID: part.id }
    return { session, info, part, invocation }
  }

  return {
    noteToolInvocation: ({ tool, sessionID, callID }) => {
      if (tool === "auto_debate" && nonEmptyString(sessionID) && nonEmptyString(callID)) {
        invocations.add(invocationKey(sessionID, callID))
      }
    },

    discardToolInvocation: (context) => {
      const callID = (context as ToolContext & { callID?: unknown }).callID
      if (nonEmptyString(callID)) invocations.delete(invocationKey(context.sessionID, callID))
    },

    refuseToolInvocation: async (owner, context) => {
      const callID = consumeInvocation(owner, context)
      if (!callID) return // Caller-only strings never establish a history exemption.
      await withSaveLock(owner.sessionID, async () => {
        const { info, part, invocation } = await readCurrentInvocation(owner, context, callID)
        const state = part.state as RecordValue
        if (state.status !== "running" || !isRecord(state.input) || !isRecord(state.time)
          || typeof state.time.start !== "number") fail("Native pre-admission refusal binding is unavailable")
        const proof: RefusedInvocation = Object.freeze({ ...invocation, created: (info.time as RecordValue).created as number,
          start: state.time.start, inputDigest: createHash("sha256").update(JSON.stringify(state.input)).digest("hex") })
        refusals.set(owner.sessionID, [...(refusals.get(owner.sessionID) ?? []), proof])
      })
    },

    admitToolInvocation: async (owner, context) => {
      const callID = consumeInvocation(owner, context)
      if (!callID) return
      await withSaveLock(owner.sessionID, async () => {
        const { session, invocation } = await readCurrentInvocation(owner, context, callID)
        const loaded = await checkpoints.load(owner, invocation)
        if (loaded) { snapshots.set(owner.sessionID, structuredClone(loaded)); refusals.delete(owner.sessionID); return }
        const initial: CheckpointSnapshot = { state: { version: 1, discussions: [], outbox: [] },
          runtimeProof: { version: 1, entries: [{ kind: "owner-invocation-admitted", ...invocation }] } }
        await checkpoints.save(owner, initial, { agent: owner.agent, model: sessionModel(session.model) }, invocation)
        snapshots.set(owner.sessionID, structuredClone(initial))
        refusals.delete(owner.sessionID)
      })
    },

    assertOwner: async (owner) => {
      const verified = await readOwner(owner)
      const permissions: OwnerPermissionSnapshot = { agent: verified.agentRules, session: verified.sessionRules }
      return permissions
    },

    restrictions: async (owner) => restrictRules((await readOwner(owner)).rules),

    createParticipant: async (owner, participant, restrictions) => {
      await readOwner(owner)
      if (!isParticipant(participant)) fail("Automatic-debate participant is invalid")
      const inherited = inheritRestrictions(PARTICIPANT_BASELINE, readRules(restrictions, "inherited owner"))
      const permission = [
        ...inherited,
        ...IMMUTABLE_PARTICIPANT_DENIALS.map((rule) => ({ ...rule })),
      ]
      const parsedModel = parseModel(participant.model)
      const marker = automaticParticipantMarker(owner, input.project.id, participant.agent)
      const request: NativeSessionCreateRequest = {
        query: { directory: owner.directory },
        body: {
          parentID: owner.sessionID,
          title: `Automatic debate participant: ${participant.agent}`,
          agent: participant.agent,
          model: {
            providerID: parsedModel.providerID,
            id: parsedModel.modelID,
            ...(participant.variant === undefined ? {} : { variant: participant.variant }),
          },
          permission,
          metadata: { [AUTOMATIC_PARTICIPANT_KEY]: marker },
        },
      }
      const session = nativeSession(
        responseData<unknown>(await input.client.session.create(request), "participant session creation"),
        "participant session creation",
      )
      assertAutomaticParticipantMarker(session, owner, input.project.id, marker.nonce)
      if (session.parentID !== owner.sessionID
        || session.projectID !== input.project.id
        || resolve(session.directory) !== resolve(owner.directory)
        || session.agent !== participant.agent
        || !sameModel(session.model, participant)) {
        fail("OpenCode created a participant session with mismatched owner or model data")
      }
      const member: PanelMember = {
        participant: { ...participant },
        sessionID: session.id,
        runtimeAgent: participant.agent,
      }
      if (participants.has(session.id)) fail("OpenCode reused an adapter-owned participant identity")
      participants.set(session.id, { member: { ...member, participant: { ...participant } }, owner: { ...owner },
        nonce: marker.nonce, permission, managed: false, unjournalled: false,
        phase: "open", messageIDs: new Set(), uncertain: false })
      return member
    },

    prompt: async (member, text) => {
      if (typeof text !== "string" || text.length === 0) fail("Automatic-debate participant prompt is empty")
      const state = participantState(member)
      member = state.member
      if (state.managed && !bound(state)) fail("Automatic-debate managed startup proof is unavailable; no retained-only fallback")
      if (state.phase === "restorable") {
        const discussion = associated(state)
        if (discussion.status !== "running" || discussion.cycle !== state.restoredCycle! + 1 || discussion.generation !== state.restoredGeneration
          || !discussion.evaluations.some((evaluation) => evaluation.cycle === state.restoredCycle
            && ["continue", "investigate"].includes(evaluation.next))
          || !discussion.followups.some((followup) => followup.cycle === discussion.cycle && nonEmptyString(followup.feedback))) {
          fail("Automatic-debate restored participant requires an explicitly saved resume with feedback, not paused dispatch")
        }
      } else assertOpen(state)
      if (state.dispatch && !state.dispatch.done) fail("Automatic-debate participant already has a pending prompt")
      let finish!: () => void
      const dispatch: Dispatch = { messageID: `msg_${randomUUID().replaceAll("-", "")}`, done: false, dispatched: false, startupSettled: false,
        settled: new Promise<void>((resolve) => { finish = resolve }), finish: () => finish() }
      state.dispatch = dispatch // Synchronous registration before the first await.
      try {
        await readParticipant(member)
        if (state.phase === "restorable") {
          await participantEvidence(state)
          if (state.phase !== "restorable") fail("Automatic-debate restored participant was stopped")
          state.phase = "open"
        }
        assertOpen(state)
        const parsedModel = parseModel(member.participant.model)
        const messageID = dispatch.messageID
        state.messageIDs.add(messageID)
        if (bound(state)) {
          const discussion = associated(state)
          if (discussion.status !== "running") fail("Automatic-debate participant discussion is not running")
          await receipt(state.owner, { kind: "participant-start-open", sessionID: member.sessionID, messageID,
            discussionID: discussion.id, generation: discussion.generation, cycle: discussion.cycle,
            textDigest: createHash("sha256").update(text).digest("hex") })
        } else {
          // Enrolment may have started while this retained-only starter awaited its lookup.
          if (state.managed) fail("Automatic-debate managed startup proof is unavailable; no retained-only fallback")
          state.unjournalled = true
        }
        const request: NativeSessionPromptRequest = {
          path: { id: member.sessionID },
          query: { directory: input.directory },
          body: {
            messageID,
            agent: member.runtimeAgent,
            model: { providerID: parsedModel.providerID, modelID: parsedModel.modelID },
            variant: member.participant.variant,
            parts: [{ type: "text" as const, text }],
          },
        }
        let message: NativeMessage
        // No await between the stopping check above and registering native dispatch.
        assertOpen(state)
        dispatch.dispatched = true
        try {
          const envelope = await input.client.session.prompt(request)
          // A definite synchronous endpoint error response has also passed startup;
          // a rejected/lost transport has no such proof and remains quarantined.
          if (isRecord(envelope) && envelope.response instanceof Response && envelope.request instanceof Request
            && envelope.response.status >= 400
            && new URL(envelope.request.url).pathname === `/session/${member.sessionID}/message`) {
            dispatch.startupSettled = true
          }
          message = nativeMessage(responseData<unknown>(envelope, "participant prompt"))
          const info = message.info
          if (info.sessionID !== member.sessionID || !nonEmptyString(info.id)
            || !((info.role === "assistant" && info.parentID === messageID)
              || (state.phase !== "open" && info.role === "user" && info.id === messageID))) {
            fail("OpenCode participant prompt returned a non-matching assistant message")
          }
          dispatch.startupSettled = true
        } catch (error) {
          if (!dispatch.startupSettled) {
            state.uncertain = true
            state.phase = "stopping"
          }
          throw error
        }
        assertOpen(state)
        const info = message.info
        if (info.role !== "assistant" || info.sessionID !== member.sessionID || !nonEmptyString(info.id)) {
          fail("OpenCode participant prompt returned a non-matching assistant message")
        }
        const textPartsFor = (candidate: NativeMessage) => candidate.parts.filter((part) => isRecord(part)
          && part.type === "text"
          && part.sessionID === member.sessionID
          && part.messageID === candidate.info.id
          && typeof part.text === "string")
        let textParts: unknown[] = []
        let historySummary = "not-read"
        if (!nonEmptyString(info.parentID)) fail("OpenCode participant assistant response has no parent message ID")
        while (true) {
          assertOpen(state)
          const statuses = responseData<unknown>(await input.client.session.status({
            query: { directory: input.directory },
          }), "participant session status")
          assertOpen(state)
          const status = isRecord(statuses) ? statuses[member.sessionID] : undefined
          if (!isRecord(statuses)) fail("OpenCode participant session status is unavailable")
          if (status !== undefined && !isRecord(status)) fail("OpenCode participant session status is invalid")
          if (status !== undefined && status.type !== "idle" && status.type !== "busy" && status.type !== "retry") {
            fail("OpenCode participant session entered an unsupported status")
          }
          if (status !== undefined && status.type !== "idle") {
            await sleep(25)
            continue
          }
          const messages = responseData<unknown>(await input.client.session.messages({
            path: { id: member.sessionID },
            query: { directory: input.directory },
          }), "participant final message lookup")
          assertOpen(state)
          if (!Array.isArray(messages)) fail("OpenCode participant message history is invalid")
          const candidates = messages.filter((candidate): candidate is NativeMessage =>
            isRecord(candidate)
            && isRecord(candidate.info)
            && Array.isArray(candidate.parts)
            && candidate.info.role === "assistant"
            && candidate.info.sessionID === member.sessionID
            && candidate.info.parentID === info.parentID)
          const finalMessage = candidates.toReversed().find((candidate) => textPartsFor(candidate).length > 0
            && isRecord(candidate.info.time) && typeof candidate.info.time.completed === "number"
            && candidate.info.error === undefined && candidate.info.finish !== "tool-calls"
            && !candidate.parts.some((part) => isRecord(part) && part.type === "tool"))
          if (finalMessage) {
            textParts = textPartsFor(finalMessage)
            dispatch.assistantID = String(finalMessage.info.id)
            break
          }
          const hasPendingTool = candidates.some((candidate) => candidate.parts.some((part) =>
            isRecord(part) && part.type === "tool" && isRecord(part.state)
            && (part.state.status === "pending" || part.state.status === "running")))
          historySummary = messages.filter(isRecord).map((candidate) => {
            const candidateInfo = isRecord(candidate.info) ? candidate.info : {}
            const partTypes = Array.isArray(candidate.parts)
              ? candidate.parts.map((part) => {
                  if (!isRecord(part)) return "invalid"
                  const state = isRecord(part.state) ? `:${String(part.state.status)}` : ""
                  return `${String(part.type)}${state}`
                }).join("+")
              : "no-parts"
            return `${String(candidateInfo.role)}:${candidateInfo.parentID === info.parentID ? "same-parent" : "other-parent"}:${partTypes}`
          }).join(",")
          if (hasPendingTool) {
            await sleep(25)
            continue
          }
          break
        }
        assertOpen(state)
        if (textParts.length === 0) {
          const summary = message.parts.map((part) => {
            if (!isRecord(part)) return "invalid"
            return `${String(part.type)}:${part.sessionID === member.sessionID ? "session-ok" : "session-mismatch"}:${part.messageID === info.id ? "message-ok" : "message-mismatch"}`
          }).join(",")
          fail(`OpenCode participant prompt returned no matching final text (role=${String(info.role)},parts=${summary || "empty"},history=${historySummary || "empty"})`)
        }
        await closeStart(state, dispatch, "answer")
        assertOpen(state)
        return textParts.map((part) => (part as RecordValue).text as string).join("\n").trim()
      } catch (error) {
        if (bound(state)?.starts.has(dispatch.messageID)) {
          if (dispatch.startupSettled) {
            try { await closeStart(state, dispatch, "definite-failure") } catch { state.uncertain = true; state.phase = "stopping" }
          } else if (dispatch.dispatched) { state.uncertain = true; state.phase = "stopping" }
        }
        throw error
      } finally {
        dispatch.done = true
        dispatch.finish()
      }
    },

    abort: async (member) => {
      const state = participantState(member)
      state.phase = "stopping" // Fence before any await, including late-event reconciliation.
      if (state.stop) return state.stop
      const stop = (async () => {
        const proof = bound(state)
        let fenceUnconfirmed = state.managed && !proof
        if (proof && !proof.fenced) {
          try { await receipt(state.owner, { kind: "participant-fenced", sessionID: member.sessionID }) }
          catch { fenceUnconfirmed = true }
        }
        if (fenceUnconfirmed) {
          // A failed proof write must not silently prevent containment, nor certify a durable stop.
          const native = await readParticipant(member)
          assertAutomaticParticipantMarker(native, state.owner, input.project.id, state.nonce)
          await nativeAbort(member)
          fail("Automatic-debate cancellation is unconfirmed: durable startup/fence proof is unavailable")
        }
        await verifyCessation(state)
        if (proof && !bound(state)!.confirmed) {
          if (state.dispatch) await closeStart(state, state.dispatch, "definite-failure")
          await receipt(state.owner, { kind: "participant-stop-confirmed", sessionID: member.sessionID })
        }
      })()
      state.stop = stop
      try {
        await stop
      } finally {
        // Coalesce only in-progress verification. Late events must trigger fresh
        // native reconciliation, not reuse an earlier successful confirmation.
        state.stop = undefined
      }
    },

    parentIdle: async (owner) => {
      await readOwner(owner)
      const statuses = responseData<unknown>(await input.client.session.status({
        query: { directory: owner.directory },
      }), "session status lookup")
      if (!isRecord(statuses)) fail("OpenCode session status response is invalid")
      const status = statuses[owner.sessionID]
      return status === undefined || (isRecord(status) && status.type === "idle")
    },

    deliver: (owner, value) => {
      if (!isRecord(value) || !nonEmptyString(value.id) || !nonEmptyString(value.text) || !Array.isArray(value.outboxIDs)
        || value.outboxIDs.length === 0 || !value.outboxIDs.every(nonEmptyString)
        || JSON.stringify(value.outboxIDs) !== JSON.stringify([...new Set(value.outboxIDs)].sort())) {
        return Promise.reject(new Error("Automatic-debate delivery identity, canonical items or text is invalid"))
      }
      const intent = structuredClone(value) as DeliveryIntent
      const key = JSON.stringify([owner, intent.id])
      for (const [otherKey, call] of deliveryCalls) {
        if (otherKey === key && JSON.stringify(call.intent) === JSON.stringify(intent)) return call.pending
        if (call.owner.sessionID === owner.sessionID && call.intent.outboxIDs.some((id) => intent.outboxIDs.includes(id))) {
          return Promise.reject(new Error("Automatic-debate delivery identity is immutable; outbox items are reserved to a batch"))
        }
      }
      const pending = (async () => {
        await withSaveLock(owner.sessionID, async () => {
          snapshot(owner) // Recovery/initialisation is explicit, not inferred from a delivery request.
          const refreshed = await checkpoints.load(owner)
          if (!refreshed) fail("Automatic-debate checkpoint is missing for delivery")
          snapshots.set(owner.sessionID, structuredClone(refreshed))
          const current = snapshot(owner)
          if (!current.runtimeProof) fail("Automatic-debate legacy delivery has unknown dispatch provenance")
          const view = journalView(current.runtimeProof)
          const known = view.deliveries.get(intent.id)
          if (known) {
            if (JSON.stringify(known.intent.delivery) !== JSON.stringify(intent)) fail("Automatic-debate delivery identity is immutable")
            return
          }
          if ([...view.deliveries.values()].some((record) => record.intent.delivery.outboxIDs.some((id) => intent.outboxIDs.includes(id)))) {
            fail("Automatic-debate outbox items are reserved to another batch")
          }
          for (const id of intent.outboxIDs) {
            const items = current.state.outbox.filter((item) => item.id === id)
            if (current.legacyOutboxIDs?.includes(id)) fail("Automatic-debate legacy outbox item has unknown dispatch provenance")
            if (items.length !== 1 || items[0].state !== "pending"
              || !current.state.discussions.some((discussion) => discussion.id === items[0].discussionID
                && discussion.results.some((result) => result.cycle === items[0].cycle))) fail("Automatic-debate delivery references an invalid saved result/outbox item")
          }
          const { session } = await readOwner(owner)
          await append(owner, [{ kind: "delivery-intent", delivery: intent,
            messageID: deliveryMessageID(owner, input.project.id, intent.id), selection: { agent: owner.agent, model: sessionModel(session.model) } }])
        })
        await readOwner(owner)
        let observation = await inspectDelivery(owner, intent.id)
        if (observation.state !== "not-dispatched") return observation
        if (!await thisIdle(owner)) return observation
        const attemptID = randomUUID()
        await receipt(owner, { kind: "delivery-dispatch-open", deliveryID: intent.id, attemptID })
        if (!await thisIdle(owner)) {
          await receipt(owner, { kind: "delivery-no-call", deliveryID: intent.id, attemptID })
          return inspectDelivery(owner, intent.id)
        }
        const record = journalView(snapshot(owner).runtimeProof).deliveries.get(intent.id)!
        const model = record.intent.selection.model
        const request: NativeSessionPromptAsyncRequest = { path: { id: owner.sessionID }, query: { directory: owner.directory }, body: {
          messageID: record.intent.messageID, agent: owner.agent, model: { providerID: model.providerID, modelID: model.modelID },
          variant: model.variant, parts: [{ type: "text", text: intent.text }],
        } }
        try { assertResponse(await input.client.session.promptAsync(request), "async owner delivery") } catch { /* Every invoked outcome reconciles. */ }
        // Preserve the reviewed finite lookup guard; exhaustion is uncertainty, never absence proof.
        for (let attempt = 0; attempt < 40; attempt++) {
          observation = await inspectDelivery(owner, intent.id)
          if (observation.state !== "uncertain" || observation.reason !== "Native submission may still persist or persisted history was lost") break
          if (attempt < 39) await sleep(25)
        }
        return observation
      })()
      deliveryCalls.set(key, { owner: structuredClone(owner), intent, pending }) // Reserve before the async operation's first continuation.
      void pending.finally(() => { if (deliveryCalls.get(key)?.pending === pending) deliveryCalls.delete(key) }).catch(() => undefined)
      return pending
    },

    reconcileDeliveries: async (owner) => {
      snapshot(owner)
      await refresh(owner)
      const ids = [...journalView(snapshot(owner).runtimeProof).deliveries.keys()]
      const results: DeliveryReconciliation[] = []
      for (const id of ids) results.push(await inspectDelivery(owner, id))
      return results
    },

    reconcileParticipant: async (owner, member): Promise<ParticipantReconciliation> => {
      snapshot(owner)
      await refresh(owner)
      const current = snapshot(owner)
      const discussions = current.state.discussions.filter((discussion) => discussion.panel.some((candidate) => JSON.stringify(candidate) === JSON.stringify(member)))
      if (discussions.length !== 1) fail("Automatic-debate restored participant is foreign or not recorded by this owner")
      const native = await readParticipant(member)
      assertAutomaticParticipantMarker(native, owner, input.project.id)
      const proof = journalView(current.runtimeProof).members.get(member.sessionID)
      if (proof) assertAutomaticParticipantMarker(native, owner, input.project.id, proof.origin.nonce)
      const existing = participants.get(member.sessionID)
      if (existing?.dispatch && !existing.dispatch.done) return { sessionID: member.sessionID, state: "uncertain",
        messageIDs: [...existing.messageIDs], reason: "Retained owned starter is still in flight" }
      const uncertain = !proof || [...proof.starts.values()].some((start) => !start.closed)
      const state: ParticipantState = existing ?? { member: structuredClone(member), owner: structuredClone(owner),
        nonce: proof?.origin.nonce ?? "", permission: proof?.origin.permission ?? [], managed: !!proof, unjournalled: !proof,
        phase: "restorable", messageIDs: new Set(proof ? proof.starts.keys() : []), uncertain }
      let reason: string | undefined
      try { await participantEvidence(state) } catch (error) { reason = error instanceof Error ? error.message : "Native participant evidence unavailable" }
      state.uncertain ||= uncertain || !!reason
      if (state.uncertain || proof?.fenced || ["cancelled", "interrupted"].includes(discussions[0].status)) state.phase = "stopping"
      participants.set(member.sessionID, state)
      if (proof?.fenced) return { sessionID: member.sessionID, state: "fenced", cessation: !state.uncertain && proof.confirmed ? "confirmed" : "unconfirmed" }
      if (state.uncertain) return { sessionID: member.sessionID, state: "uncertain", messageIDs: [...state.messageIDs],
        reason: reason ?? "Native startup outcome has no durable closure" }
      const discussion = discussions[0]
      const canContinue = discussion.status === "paused" && discussion.results.some((result) => result.cycle === discussion.cycle
        && ["complete", "partial"].includes(result.status)) && discussion.evaluations.some((evaluation) => evaluation.cycle === discussion.cycle
          && ["continue", "investigate"].includes(evaluation.next)) && state.phase !== "stopping" && state.phase !== "stopped"
      if (state.phase === "restorable" && canContinue) { state.restoredCycle = discussion.cycle; state.restoredGeneration = discussion.generation }
      return { sessionID: member.sessionID, state: "exhausted", canContinue }
    },

    load: async (owner) => {
      const loaded = await refresh(owner)
      return loaded && structuredClone(loaded.state)
    },

    save: async (owner, state) => {
      const validated = parseConversationState(structuredClone(state)) // Capture before the lock's first await.
      if (validated.discussions.some((discussion) => discussion.owner.sessionID !== owner.sessionID || discussion.owner.agent !== owner.agent
        || resolve(discussion.owner.directory) !== resolve(owner.directory))) fail("Checkpoint state has a foreign discussion owner")
      // Enrol the entire owned panel before any await. Partial validation or an ambiguous
      // origin append must never return unchecked members to retained-only dispatch.
      for (const discussion of validated.discussions) for (const member of discussion.panel) {
        const participant = participants.get(member.sessionID)
        if (participant && participant.owner.sessionID === owner.sessionID && participant.owner.agent === owner.agent
          && resolve(participant.owner.directory) === resolve(owner.directory)) participant.managed = true
      }
      await withSaveLock(owner.sessionID, async () => {
        await readOwner(owner)
        const entries: RuntimeReceipt[] = []
        const known = journalView(snapshots.get(owner.sessionID)?.runtimeProof).members
        for (const discussion of validated.discussions) for (const member of discussion.panel) {
          if (known.has(member.sessionID)) continue
          const state = participants.get(member.sessionID)
          if (!state) continue // Legacy/unknown members are retained as data, never promoted.
          if (state.unjournalled || state.dispatch || state.phase !== "open" || state.owner.sessionID !== owner.sessionID) {
            fail("Automatic-debate member cannot acquire durable origin after unjournalled startup or stopping")
          }
          const native = await readParticipant(member)
          assertAutomaticParticipantMarker(native, owner, input.project.id, state.nonce)
          if (JSON.stringify(native.permission) !== JSON.stringify(state.permission)) fail("Automatic-debate member creation permissions changed")
          entries.push({ kind: "member-bound", discussionID: discussion.id, member: structuredClone(member), nonce: state.nonce, permission: state.permission })
        }
        await append(owner, entries, validated)
        for (const id of journalView(snapshot(owner).runtimeProof).members.keys()) {
          const state = participants.get(id)
          if (state) state.managed = true // Irreversible, even if later recovery deletes the proof cache.
        }
      })
    },
  }
}

import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { CheckpointSnapshot, ConversationState, Owner, Rule, RuntimeJournal, RuntimeReceipt } from "./types.ts"

type RecordValue = Record<string, unknown>
type Model = { providerID: string; modelID: string; variant?: string }
type Binding = {
  kind: "opencode-debate-store"
  version: 1
  owner: string
  project: string
  directory: string
  nonce: string
  agent: string
  model: Model
}
type Store = { sessionID: string; binding: Binding; head: string | null; revision: number; loaded: boolean; failed?: string }
type Checkpoint = CheckpointSnapshot & { messageID: string; revision: number; previous: string | null; digest: string }
const KEY = "opencode-debate-checkpoint-store"
const TITLE = "Automatic debate recovery checkpoints v1"
const PREFIX = "opencode-debate/checkpoint/v1\n"
const DENY: Rule[] = [{ permission: "*", pattern: "*", action: "deny" }]
export const AUTOMATIC_PARTICIPANT_KEY = "opencode-debate-automatic-participant"
type CreateOptions = NonNullable<Parameters<PluginInput["client"]["session"]["create"]>[0]>
type CreateRequest = Omit<CreateOptions, "body"> & { body: NonNullable<CreateOptions["body"]> & {
  agent: string; model: { providerID: string; id: string; variant?: string }; metadata: RecordValue; permission: Rule[]
} }
type PromptOptions = NonNullable<Parameters<PluginInput["client"]["session"]["prompt"]>[0]>
type PromptRequest = Omit<PromptOptions, "body"> & { body: NonNullable<PromptOptions["body"]> & { variant?: string } }
/** Derived only by the retained native runtime from a live host-hook witness
 * and an independently read assistant/tool binding, never from model arguments. */
export type CurrentInvocation = { messageID: string; callID: string; partID: string }
/** Retained host-witnessed refusal before admission, never reconstructed from
 * an error diagnostic or supplied inside manager/application state. */
export type RefusedInvocation = Readonly<CurrentInvocation & { created: number; start: number; inputDigest: string }>

function object(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value) }
function fail(message: string): never { throw new Error(`Automatic-debate checkpoint ${message}`) }
function data(value: unknown, operation: string): unknown {
  if (!object(value) || value.error !== undefined && value.error !== null || value.data === undefined || value.data === null) {
    fail(`${operation} failed or returned no data`)
  }
  return value.data
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex") }
function idPrefix(store: Store): string { return `msg_adcp_${store.binding.nonce}_` }

export function deliveryMessageID(owner: Owner, project: string, id: string): string {
  return `msg_${hash(JSON.stringify(["opencode-debate/delivery/v1", project, resolve(owner.directory), owner.sessionID, owner.agent, id]))}`
}

export function journalView(proof: RuntimeJournal | undefined) {
  const members = new Map<string, { origin: Extract<RuntimeReceipt, { kind: "member-bound" }>;
    starts: Map<string, { open: Extract<RuntimeReceipt, { kind: "participant-start-open" }>; closed?: Extract<RuntimeReceipt, { kind: "participant-start-closed" }> }>;
    fenced: boolean; confirmed: boolean }>()
  const deliveries = new Map<string, { intent: Extract<RuntimeReceipt, { kind: "delivery-intent" }>;
    attempt?: string; noCall: boolean; persisted: boolean }>()
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

/** Exact receipt shapes and causal transitions; a checksum is not an authority to forge a close. */
function parseJournal(value: unknown, state: ConversationState, binding: Binding): RuntimeJournal | undefined {
  if (value === undefined) return undefined
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)
    || Object.keys(value).some((key) => !["version", "entries"].includes(key))) fail("runtime proof journal is invalid")
  const entries: RuntimeReceipt[] = []
  const ids = new Set<string>(); const items = new Set<string>(); const attempts = new Set<string>()
  const string = (item: unknown): item is string => typeof item === "string" && item.trim().length > 0
  const integer = (item: unknown, minimum: number) => Number.isSafeInteger(item) && (item as number) >= minimum
  const exact = (entry: RecordValue, keys: string[]) => Object.keys(entry).every((key) => keys.includes(key))
  for (const raw of value.entries) {
    if (!object(raw) || !string(raw.kind)) fail("runtime receipt is invalid")
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
        const saved = discussion?.panel.find((item) => object(raw.member) && item.sessionID === raw.member.sessionID)
        valid = exact(raw, ["kind", "discussionID", "member", "nonce", "permission"])
          && !!saved && JSON.stringify(saved) === JSON.stringify(raw.member) && !view.members.has(saved.sessionID)
          && typeof raw.nonce === "string" && /^[a-f0-9]{32}$/.test(raw.nonce)
          && Array.isArray(raw.permission) && raw.permission.every((rule) => object(rule)
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
          && object(intent) && exact(intent, ["id", "outboxIDs", "text"]) && string(intent.id) && string(intent.text)
          && !view.deliveries.has(intent.id) && Array.isArray(intent.outboxIDs) && intent.outboxIDs.length > 0
          && intent.outboxIDs.every((id) => string(id) && !items.has(id))
          && JSON.stringify(intent.outboxIDs) === JSON.stringify([...new Set(intent.outboxIDs)].sort())
          && intent.outboxIDs.every((id) => state.outbox.filter((item) => item.id === id).length === 1
            && state.discussions.some((discussion) => discussion.id === state.outbox.find((item) => item.id === id)!.discussionID
              && discussion.results.some((result) => result.cycle === state.outbox.find((item) => item.id === id)!.cycle)))
          && raw.messageID === deliveryMessageID({ sessionID: binding.owner, directory: binding.directory,
            agent: binding.agent }, binding.project, intent.id)
          && object(selection) && exact(selection, ["agent", "model"]) && selection.agent === binding.agent
          && object(selection.model) && exact(selection.model, ["providerID", "modelID", "variant"])
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
function sameModel(value: unknown, expected: Model): boolean {
  return object(value) && value.providerID === expected.providerID
    && (value.id ?? value.modelID) === expected.modelID
    && (value.variant === "default" ? undefined : value.variant) === expected.variant
}

export function automaticParticipantMarker(owner: Owner, project: string, agent: string) {
  return { kind: "opencode-debate-participant", version: 1, owner: owner.sessionID, project,
    directory: resolve(owner.directory), agent, nonce: randomUUID().replaceAll("-", "") }
}

export function assertAutomaticParticipantMarker(value: unknown, owner: Owner, project: string, nonce?: string) {
  if (!object(value) || typeof value.id !== "string" || !value.id || value.parentID !== owner.sessionID
    || value.projectID !== project || value.directory !== resolve(owner.directory)) fail("automatic participant ownership binding is invalid")
  const marker = object(value.metadata) ? value.metadata[AUTOMATIC_PARTICIPANT_KEY] : undefined
  if (!object(marker) || marker.kind !== "opencode-debate-participant" || marker.version !== 1
    || marker.owner !== owner.sessionID || marker.project !== project || marker.directory !== resolve(owner.directory)
    || typeof marker.agent !== "string" || !marker.agent.trim() || marker.agent !== value.agent
    || typeof marker.nonce !== "string" || !/^[a-f0-9]{32}$/.test(marker.nonce)
    || nonce !== undefined && marker.nonce !== nonce) fail("automatic participant marker is missing or corrupt")
}

/** Native history store only. Call under the retained runtime's per-owner lock. */
export function createCheckpointStore(input: PluginInput, parseState: (value: unknown) => ConversationState,
  retainedRefusals: (owner: Owner) => readonly RefusedInvocation[] = () => []) {
  const stores = new Map<string, Store>()
  const failedRecovery = new Set<string>()

  async function checkAbsentEvidence(owner: Owner, children: unknown[], invocation?: CurrentInvocation) {
    for (const listed of children) {
      if (!object(listed) || typeof listed.id !== "string" || !listed.id) fail("child evidence is invalid")
      const child = data(await input.client.session.get({ path: { id: listed.id },
        query: { directory: input.directory } }), "child provenance lookup")
      if (!object(child) || child.id !== listed.id || child.parentID !== owner.sessionID
        || child.projectID !== input.project.id || child.directory !== resolve(owner.directory)) fail("child evidence binding is invalid")
      if (child.metadata !== undefined && !object(child.metadata)) fail("child metadata evidence is corrupt")
      // A corrupt/present marker never falls through as unrelated. Re-read the
      // native child, not its mutable title, to validate persisted provenance.
      if (object(child.metadata) && Object.hasOwn(child.metadata, AUTOMATIC_PARTICIPANT_KEY)
        || object(listed.metadata) && Object.hasOwn(listed.metadata, AUTOMATIC_PARTICIPANT_KEY)) {
        assertAutomaticParticipantMarker(child, owner, input.project.id)
        fail("store is missing with attributable automatic participant remnants; refusing initialisation")
      }
      const suspected = (value: RecordValue) => typeof value.title === "string"
        && (value.title.startsWith("Automatic debate participant:") || value.title.startsWith("Automatic debate recovery checkpoints"))
      if (object(child.metadata) && Object.hasOwn(child.metadata, KEY) || suspected(child) || suspected(listed)) {
        fail("store is missing with suspected automatic-state remnants; refusing initialisation")
      }
      const messages = data(await input.client.session.messages({ path: { id: listed.id },
        query: { directory: input.directory } }), "child history provenance lookup")
      if (!Array.isArray(messages) || messages.some((message: unknown) => {
        if (!object(message) || !object(message.info) || !Array.isArray(message.parts)) return true
        const info = message.info
        return typeof info.id !== "string" || !info.id || info.sessionID !== listed.id
          || info.role !== "user" && info.role !== "assistant"
          || message.parts.some((part: unknown) => !object(part) || typeof part.id !== "string" || !part.id
            || part.sessionID !== listed.id || part.messageID !== info.id || typeof part.type !== "string" || !part.type
            || part.type === "text" && typeof part.text !== "string")
      })) fail("child history provenance is invalid")
      // Native checkpoint message identities survive mutable child titles/metadata
      // and even incomplete text writes. They are suspicion, not a binding that
      // authorises restoration. Quoted checkpoint text in ordinary messages is not.
      if (messages.some((message: unknown) => object(message) && object(message.info)
        && typeof message.info.id === "string" && /^msg_adcp_[a-f0-9]{32}_/.test(message.info.id))) {
        fail("store is missing with suspected native checkpoint history remnants; refusing initialisation")
      }
      // Arbitrary specialist/manual children (including shared panel agent
      // names) are neither adopted nor evidence of automatic-debate ownership.
    }
    const root = data(await input.client.session.get({ path: { id: owner.sessionID },
      query: { directory: input.directory } }), "absence owner lookup")
    if (!object(root) || root.id !== owner.sessionID || root.projectID !== input.project.id
      || root.directory !== resolve(owner.directory)) fail("absence owner binding is invalid")
    if (root.metadata !== undefined && !object(root.metadata)) fail("absence owner metadata is invalid")
    if (object(root.metadata) && (Object.hasOwn(root.metadata, "opencode-debate") || Object.hasOwn(root.metadata, KEY))) {
      fail("store is missing with prior automatic-state metadata evidence; no migration or default restoration")
    }
    const messages = data(await input.client.session.messages({ path: { id: owner.sessionID },
      query: { directory: input.directory } }), "absence owner history lookup")
    if (!Array.isArray(messages) || messages.some((message) => !object(message) || !object(message.info)
      || message.info.sessionID !== owner.sessionID || !Array.isArray(message.parts))) fail("absence owner history is invalid")
    let currentParts = 0
    const refusals = retainedRefusals(owner)
    const refusedParts = new Map<RefusedInvocation, number>()
    for (const message of messages) {
      for (const part of (message as RecordValue).parts as unknown[]) {
        if (!object(part)) continue
        if (invocation && object(message) && object(message.info) && message.info.id === invocation.messageID
          && message.info.role === "assistant" && message.info.agent === owner.agent
          && object(message.info.time) && message.info.time.completed === undefined
          && part.id === invocation.partID && part.messageID === invocation.messageID && part.sessionID === owner.sessionID
          && part.type === "tool" && part.tool === "auto_debate" && part.callID === invocation.callID
          && object(part.state) && ["pending", "running"].includes(String(part.state.status))) {
          currentParts++
          continue // Only this exact, host-witnessed not-yet-admitted invocation.
        }
        const refusal = refusals.find((proof) => object(message) && object(message.info) && message.info.id === proof.messageID
          && message.info.role === "assistant" && message.info.agent === owner.agent && message.info.summary !== true
          && object(message.info.time) && message.info.time.created === proof.created
          && part.id === proof.partID && part.messageID === proof.messageID && part.sessionID === owner.sessionID
          && part.type === "tool" && part.tool === "auto_debate" && part.callID === proof.callID
          && object(part.state) && part.state.status === "error" && object(part.state.input)
          && object(part.state.time) && part.state.time.start === proof.start
          && hash(JSON.stringify(part.state.input)) === proof.inputDigest)
        if (refusal) {
          refusedParts.set(refusal, (refusedParts.get(refusal) ?? 0) + 1)
          continue // Only a verified exact refusal whose execution never entered admission.
        }
        if (part.type === "tool" && typeof part.tool === "string" && (part.tool === "auto_debate" || part.tool.startsWith("auto_debate_"))
          || part.type === "text" && typeof part.text === "string" && part.text.startsWith("opencode-debate/checkpoint/")) {
          fail("store is missing with prior automatic-work history evidence; refusing initialisation")
        }
      }
    }
    if (invocation && currentParts !== 1) fail("current native invocation evidence is missing or ambiguous")
    if (refusals.some((proof) => refusedParts.get(proof) !== 1)) fail("retained native refusal evidence is missing or ambiguous")
  }

  function validateSession(value: unknown, owner: Owner, known?: Store): Store {
    if (!object(value) || typeof value.id !== "string" || value.parentID !== owner.sessionID
      || value.projectID !== input.project.id || value.directory !== resolve(owner.directory)) fail("store ownership binding is invalid")
    const marker = object(value.metadata) ? value.metadata[KEY] : undefined
    if (!object(marker) || marker.kind !== "opencode-debate-store" || marker.version !== 1
      || marker.owner !== owner.sessionID || marker.project !== input.project.id
      || marker.directory !== resolve(owner.directory) || marker.agent !== owner.agent || typeof marker.nonce !== "string"
      || !/^[a-f0-9]{32}$/.test(marker.nonce) || typeof marker.agent !== "string" || !object(marker.model)
      || typeof marker.model.providerID !== "string" || typeof marker.model.modelID !== "string"
      || marker.model.variant !== undefined && typeof marker.model.variant !== "string"
      || value.agent !== marker.agent || !sameModel(value.model, marker.model as Model)) fail("store binding is missing or corrupt")
    const rule = Array.isArray(value.permission) && value.permission.length === 1 ? value.permission[0] : undefined
    if (!object(rule) || rule.permission !== "*" || rule.pattern !== "*" || rule.action !== "deny") fail("store permissions are not all-deny")
    if (value.revert !== undefined && value.revert !== null) fail("store has reverted/deleted evidence")
    if (known && (known.sessionID !== value.id || known.binding.nonce !== marker.nonce)) fail("known store was lost or replaced")
    return known ?? { sessionID: value.id, binding: marker as Binding, head: null, revision: 0, loaded: false }
  }

  async function discover(owner: Owner, context?: { agent: string; model: Model }, invocation?: CurrentInvocation): Promise<{ store?: Store; created: boolean }> {
    if (failedRecovery.has(owner.sessionID)) fail("recovery/creation outcome remains unconfirmed; refusing initialisation")
    const known = stores.get(owner.sessionID)
    if (known?.failed) fail(`store remains unconfirmed: ${known.failed}`)
    const children = data(await input.client.session.children({ path: { id: owner.sessionID },
      query: { directory: input.directory } }), "store discovery")
    if (!Array.isArray(children) || children.some((child) => !object(child))) fail("store discovery is invalid")
    const candidates = children.filter((child) => object(child) && (child.title === TITLE
      || object(child.metadata) && Object.hasOwn(child.metadata, KEY) || child.id === known?.sessionID))
    if (candidates.length > 1) fail("store discovery is ambiguous: multiple storage children")
    if (candidates.length === 1) {
      const child = data(await input.client.session.get({ path: { id: String((candidates[0] as RecordValue).id) },
        query: { directory: input.directory } }), "store identity lookup")
      const store = validateSession(child, owner, known)
      stores.set(owner.sessionID, store)
      return { store, created: false }
    }
    if (known) fail("known store was deleted or is missing; refusing recreation")
    await checkAbsentEvidence(owner, children, invocation)
    if (!context) return { created: false } // Initialisation opportunity, never a recovered empty snapshot.
    const binding: Binding = { kind: "opencode-debate-store", version: 1, owner: owner.sessionID,
      project: input.project.id, directory: resolve(owner.directory), nonce: randomUUID().replaceAll("-", ""),
      agent: context.agent, model: context.model }
    const request: CreateRequest = { query: { directory: input.directory }, body: {
      parentID: owner.sessionID, title: TITLE, agent: binding.agent,
      model: { providerID: binding.model.providerID, id: binding.model.modelID,
        ...(binding.model.variant === undefined ? {} : { variant: binding.model.variant }) },
      metadata: { [KEY]: binding }, permission: DENY.map((rule) => ({ ...rule })),
    } }
    try {
      const store = validateSession(data(await input.client.session.create(request), "store creation"), owner)
      if (store.binding.nonce !== binding.nonce) fail("creation returned a different binding")
      store.loaded = true
      stores.set(owner.sessionID, store) // Remember identity before any checkpoint write.
      // Re-discover to reject a concurrent independent store creation, not pick a title winner.
      await discover(owner)
      return { store, created: true }
    } catch (error) {
      failedRecovery.add(owner.sessionID) // A lost create response may still have created a child.
      throw error
    }
  }

  function decode(value: unknown, store: Store): Checkpoint {
    if (!object(value) || !object(value.info) || !Array.isArray(value.parts)) fail("history entry is invalid")
    const info = value.info
    if (info.role !== "user" || info.sessionID !== store.sessionID || typeof info.id !== "string"
      || !info.id.startsWith(idPrefix(store)) || info.agent !== store.binding.agent
      || !sameModel(info.model, store.binding.model)) fail("history contains unowned or running session evidence")
    if (value.parts.length !== 1) fail("history contains an incomplete checkpoint or unexpected parts")
    const part = value.parts[0]
    if (!object(part) || part.type !== "text" || part.sessionID !== store.sessionID || part.messageID !== info.id
      || typeof part.text !== "string" || !part.text.startsWith(PREFIX)) fail("history contains incomplete/unrecognised checkpoint evidence")
    let wrapper: unknown
    let payload: unknown
    try {
      wrapper = JSON.parse(part.text.slice(PREFIX.length)) as unknown
      if (!object(wrapper) || typeof wrapper.payload !== "string" || wrapper.digest !== hash(wrapper.payload)) fail("digest is corrupt")
      payload = JSON.parse(wrapper.payload) as unknown
    } catch { fail("record is corrupt or incomplete") }
    if (!object(payload) || payload.kind !== "opencode-debate-checkpoint" || payload.version !== 1
      || payload.messageID !== info.id || payload.sessionID !== store.sessionID || payload.nonce !== store.binding.nonce
      || payload.owner !== store.binding.owner || payload.project !== store.binding.project || payload.directory !== store.binding.directory
      || !Number.isSafeInteger(payload.revision) || (payload.revision as number) < 1
      || !(payload.previous === null || typeof payload.previous === "string")) fail("record ownership/revision binding is invalid")
    const state = parseState(payload.state)
    if (state.discussions.some((discussion) => discussion.owner.sessionID !== store.binding.owner || discussion.owner.agent !== store.binding.agent
      || resolve(discussion.owner.directory) !== store.binding.directory)) fail("state contains a foreign discussion owner")
    return { messageID: info.id, revision: payload.revision as number, previous: payload.previous as string | null,
      digest: (wrapper as { digest: string }).digest, state, runtimeProof: parseJournal(payload.runtimeProof, state, store.binding) }
  }

  async function history(store: Store, allowEmpty = false): Promise<Checkpoint | undefined> {
    const statuses = data(await input.client.session.status({ query: { directory: input.directory } }), "store status")
    const status = object(statuses) ? statuses[store.sessionID] : undefined
    if (!object(statuses) || status !== undefined && (!object(status) || status.type !== "idle")) fail("store is running or has invalid status")
    const messages = data(await input.client.session.messages({ path: { id: store.sessionID },
      query: { directory: input.directory } }), "history lookup")
    if (!Array.isArray(messages)) fail("history is invalid")
    if (messages.length === 0) {
      if (allowEmpty && store.revision === 0) return undefined
      fail("history is missing/incomplete; refusing recovery")
    }
    const records = messages.map((message) => decode(message, store)).sort((a, b) => a.revision - b.revision)
    let previous: string | null = null
    const ids = new Set<string>()
    let proof: RuntimeJournal | undefined
    const legacyOutboxIDs = new Set<string>()
    for (let index = 0; index < records.length; index++) {
      const record = records[index]
      if (record.revision !== index + 1 || record.previous !== previous || ids.has(record.messageID)) {
        fail("history is forked/conflicting or predecessor evidence is missing")
      }
      ids.add(record.messageID)
      previous = record.messageID
      if (proof && (!record.runtimeProof || record.runtimeProof.entries.length < proof.entries.length
        || JSON.stringify(record.runtimeProof.entries.slice(0, proof.entries.length)) !== JSON.stringify(proof.entries))) {
        fail("runtime proof receipt prefix was removed or changed")
      }
      proof = record.runtimeProof
      if (!record.runtimeProof) for (const item of record.state.outbox) legacyOutboxIDs.add(item.id)
    }
    const head = records.at(-1)!
    return { ...head, legacyOutboxIDs: [...legacyOutboxIDs] }
  }

  return {
    load: async (owner: Owner, invocation?: CurrentInvocation): Promise<CheckpointSnapshot | undefined> => {
      let store: Store | undefined
      try {
        store = (await discover(owner, undefined, invocation)).store
        if (!store) return undefined
        const head = await history(store)
        if (!head) fail("state is missing")
        if (store.loaded && store.head !== head.messageID) fail("head changed outside this retained manager")
        store.head = head.messageID; store.revision = head.revision; store.loaded = true
        return structuredClone({ state: head.state, runtimeProof: head.runtimeProof, legacyOutboxIDs: head.legacyOutboxIDs })
      } catch (error) {
        if (store) store.failed = error instanceof Error ? error.message : "unconfirmed history"
        else failedRecovery.add(owner.sessionID) // A failed lookup/remnant check is not the undefined case.
        throw error
      }
    },
    save: async (owner: Owner, snapshot: CheckpointSnapshot, context: { agent: string; model: Model }, invocation?: CurrentInvocation): Promise<void> => {
      const { store, created } = await discover(owner, context, invocation)
      if (!store) fail("initialisation did not establish a storage identity")
      if (!store.loaded) fail("an existing checkpoint store must be loaded before saving: unknown provenance")
      const current = await history(store, created)
      if ((current?.messageID ?? null) !== store.head) fail("head changed by an independent writer; refusing stale save")
      const revision = store.revision + 1
      if (!Number.isSafeInteger(revision)) fail("revision overflow")
      parseJournal(snapshot.runtimeProof, snapshot.state, store.binding)
      if (current?.runtimeProof && (!snapshot.runtimeProof || snapshot.runtimeProof.entries.length < current.runtimeProof.entries.length
        || JSON.stringify(snapshot.runtimeProof.entries.slice(0, current.runtimeProof.entries.length)) !== JSON.stringify(current.runtimeProof.entries))) {
        fail("runtime proof prefix cannot be overwritten by a stale writer")
      }
      const messageID = `${idPrefix(store)}${randomUUID().replaceAll("-", "")}`
      const payload = JSON.stringify({ kind: "opencode-debate-checkpoint", version: 1, messageID,
        sessionID: store.sessionID, nonce: store.binding.nonce, owner: store.binding.owner,
        project: store.binding.project, directory: store.binding.directory, revision, previous: store.head,
        state: snapshot.state, runtimeProof: snapshot.runtimeProof })
      const digest = hash(payload)
      const text = PREFIX + JSON.stringify({ payload, digest })
      const request: PromptRequest = { path: { id: store.sessionID }, query: { directory: input.directory }, body: {
        messageID, agent: store.binding.agent, model: { providerID: store.binding.model.providerID, modelID: store.binding.model.modelID },
        variant: store.binding.model.variant ?? "default", noReply: true, parts: [{ type: "text", text }],
      } }
      try {
        const response = decode(data(await input.client.session.prompt(request), "append"), store)
        if (response.messageID !== messageID || response.digest !== digest) fail("append returned a different message identity/payload")
        const verified = await history(store)
        if (!verified || verified.messageID !== messageID || verified.revision !== revision
          || verified.previous !== store.head || verified.digest !== digest) fail("append was not completely persisted or head conflicted")
        store.head = messageID; store.revision = revision
      } catch (error) {
        store.failed = error instanceof Error ? error.message : "unconfirmed append"
        throw error // Never overwrite/retry an uncertain append as if it were CAS.
      }
    },
  }
}

import type { DebateParticipant } from "../participants.ts"

export type AutoDebateConfig = Readonly<{
  enabled: boolean
  set?: string
  maxRounds: number
  persistTranscripts: boolean
}>

export type Brief = Readonly<{
  question: string
  objective: string
  facts: string[]
  assumptions: string[]
  constraints: string[]
  alternatives: string[]
  uncertainty: string
  neededOutcome: string
}>

export type Rule = Readonly<{
  permission: string
  pattern: string
  action: "allow" | "ask" | "deny"
}>

export type OwnerPermissionSnapshot = Readonly<{
  agent: readonly Rule[]
  session: readonly Rule[]
}>

export type Owner = Readonly<{
  sessionID: string
  agent: string
  directory: string
}>

export type PanelMember = Readonly<{
  participant: DebateParticipant
  sessionID: string
  runtimeAgent: string
}>

export type Turn = Readonly<{
  participant: string
  cycle: number
  round: number
  text: string
  consensus?: boolean
  stop?: boolean
}>

export type CycleResult = Readonly<{
  cycle: number
  rounds: number
  status: "complete" | "partial" | "cancelled" | "interrupted"
  reason: "unanimous-stop" | "round-limit" | "participant-failure"
    | "explicit-stop" | "obsolete" | "shutdown"
  turns: readonly Turn[]
  failures: readonly { participant: string; message: string }[]
  consensus: boolean
}>

export type Evaluation = Readonly<{
  cycle: number
  conclusion: string
  caveats: string[]
  rationale: string
  next: "act" | "investigate" | "continue" | "report-unresolved"
  feedback?: string
}>

export type Discussion = {
  id: string
  owner: Owner
  config: AutoDebateConfig
  brief: Brief
  panel: PanelMember[]
  status: "running" | "awaiting-evaluation" | "paused" | "resolved"
    | "cancelled" | "interrupted"
  generation: number
  cycle: number
  results: CycleResult[]
  evaluations: Evaluation[]
  pendingTurns: Turn[]
  followups: { cycle: number; feedback: string }[]
  /** Outstanding ambiguous result notifications, surfaced by manager status. */
  deliveryUncertainCycles?: { cycle: number; reason: string }[]
  transcriptPath?: string
  transcriptError?: string
  cancellation?: { pendingSessionIDs: string[]; errors: string[] }
}

export type TranscriptCheckpointResult = Readonly<{
  transcriptPath: string | undefined
  transcriptError: string | undefined
}>

export type ConversationState = {
  version: 1
  override?: boolean
  discussions: Discussion[]
  outbox: {
    id: string
    discussionID: string
    cycle: number
    state: "pending" | "sent" | "acknowledged"
    messageID?: string
  }[]
}

export type DeliveryIntent = Readonly<{ id: string; outboxIDs: readonly string[]; text: string }>
export type DeliveryReconciliation = Readonly<{ delivery: DeliveryIntent; messageID: string }> & (
  | { state: "not-dispatched"; proof: "intent-only" | "sealed-before-call" }
  | { state: "persisted" }
  | { state: "uncertain"; reason: string }
)
export type ParticipantReconciliation =
  | { sessionID: string; state: "exhausted"; canContinue: boolean }
  | { sessionID: string; state: "fenced"; cessation: "confirmed" | "unconfirmed" }
  | { sessionID: string; state: "uncertain"; messageIDs: readonly string[]; reason: string }

/** Adapter-owned evidence, stored beside (never supplied inside) application state. */
export type RuntimeReceipt =
  | { kind: "owner-invocation-admitted"; messageID: string; callID: string; partID: string }
  | { kind: "member-bound"; discussionID: string; member: PanelMember; nonce: string; permission: readonly Rule[] }
  | { kind: "participant-start-open"; sessionID: string; messageID: string; discussionID: string;
      generation: number; cycle: number; textDigest: string }
  | { kind: "participant-start-closed"; sessionID: string; messageID: string; startup: "synchronous-response" | "never-invoked";
      outcome: "answer" | "definite-failure"; assistantID?: string }
  | { kind: "participant-fenced"; sessionID: string }
  | { kind: "participant-stop-confirmed"; sessionID: string }
  | { kind: "delivery-intent"; delivery: DeliveryIntent; messageID: string;
      selection: { agent: string; model: { providerID: string; modelID: string; variant?: string } } }
  | { kind: "delivery-dispatch-open"; deliveryID: string; attemptID: string }
  | { kind: "delivery-no-call"; deliveryID: string; attemptID: string }
  | { kind: "delivery-persisted"; deliveryID: string; messageID: string }
export type RuntimeJournal = Readonly<{ version: 1; entries: readonly RuntimeReceipt[] }>
export type CheckpointSnapshot = Readonly<{ state: ConversationState; runtimeProof?: RuntimeJournal;
  /** Derived from pre-protocol history, not another persisted store or manager field. */
  legacyOutboxIDs?: readonly string[] }>

export interface Runtime {
  /** Validate owner identity and return separately ordered agent/session rules for explicit tool checks. */
  assertOwner(owner: Owner): Promise<OwnerPermissionSnapshot>
  restrictions(owner: Owner): Promise<readonly Rule[]>
  createParticipant(
    owner: Owner,
    participant: DebateParticipant,
    restrictions: readonly Rule[],
  ): Promise<PanelMember>
  /** One owned start per session. Restored members require exhausted receipt provenance,
   * prior paused evaluation and an explicitly saved next-cycle transition with feedback. */
  prompt(member: PanelMember, text: string): Promise<string>
  /** Resolves only after owned starts are drained and native cessation is verified.
   * Rejection/pending means unconfirmed: retain the session ID in cancellation.pendingSessionIDs.
   * Stopping is permanent for this participant, including when verification fails.
   * Recovered/foreign sessions with unknown startup provenance cannot be confirmed or resumed.
   * Repeated calls re-verify native cessation for late-event reconciliation.
   */
  abort(member: PanelMember): Promise<void>
  parentIdle(owner: Owner): Promise<boolean>
  /** Freeze/reserve a persisted outbox batch; once invoked, only reconcile, never redispatch.
   * Missing messages after an open attempt remain uncertain, not absence proof. */
  deliver(owner: Owner, delivery: DeliveryIntent): Promise<DeliveryReconciliation>
  /** Lookup only; enumerates original frozen batches across restart. Never submits. */
  reconcileDeliveries(owner: Owner): Promise<readonly DeliveryReconciliation[]>
  /** No model calls or automatic resumption. Unknown startups permit scoped containment
   * but not confirmed cessation; exhausted paused members become inert/restorable. */
  reconcileParticipant(owner: Owner, member: PanelMember): Promise<ParticipantReconciliation>
  /** Recover only a complete owner-bound native checkpoint chain. Undefined means checked absence
   * with no known store/attributable automatic-work evidence (unrelated children are allowed):
   * an explicit new-state initialisation opportunity,
   * not a recovered empty snapshot and never authority for restored dispatch. Missing known state,
   * remnants, damaged history or failed lookups reject; do not catch errors and save defaults.
   * Total authorised erasure is indistinguishable from never-used when no evidence remains.
   */
  load(owner: Owner): Promise<ConversationState | undefined>
  /** Append through one retained runtime. Recover first; after undefined, only a new explicit action
   * may save initial state before creating/dispatching participants. Absence/remnants are rechecked.
   * Existing provenance must be loaded before recovered writes;
   * no owner metadata/history writes, no model reply, and no CAS between independent managers.
   */
  save(owner: Owner, state: ConversationState): Promise<void>
}

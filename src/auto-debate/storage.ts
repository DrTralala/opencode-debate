import { createHash } from "node:crypto"
import { lstat, open, readdir, readFile, rmdir, unlink } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  createCheckpointStore,
  type CurrentInvocation,
  type NativeCheckpointHead,
  type NativeCheckpointStore,
  type RefusedInvocation,
} from "./checkpoint.ts"
import {
  migrationBoundaryPath,
  openPrivateStore,
  planPrivateRevision,
  privateOwnerKey,
  privateStoreRoot,
  readMigrationBoundary,
  writeMigrationBoundary,
  type PrivateHead,
  type PrivateStore,
} from "./private-store.ts"
import type {
  CheckpointSnapshot,
  ConversationState,
  Discussion,
  LegacySource,
  MigrationBoundary,
  Owner,
  PanelMember,
  RuntimeReceipt,
  StorageSelection,
} from "./types.ts"
import { journalView, parseConversationState, parseRuntimeJournal } from "./validation.ts"

type Model = { providerID: string; modelID: string; variant?: string }
type RecordValue = Record<string, unknown>

export type RuntimeStorageMode = "auto" | "native"

function fail(message: string): never {
  throw new Error(`Automatic-debate storage ${message}`)
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function data(value: unknown, operation: string): unknown {
  if (!isRecord(value) || value.error !== undefined && value.error !== null
    || value.data === undefined || value.data === null) {
    fail(`${operation} failed or returned no data`)
  }
  return value.data
}

export type CompactionResult =
  | { status: "not-eligible"; reason: string }
  | { status: "compacted"; revision: number; digest: string }
  | { status: "legacy"; reason: string }

export interface CompactionMaintenance {
  compactIfEligible(owner: Owner, predicate: (snapshot: CheckpointSnapshot) => boolean): Promise<CompactionResult>
}

export type MigrationPreview = Readonly<{
  ownerSessionID: string
  agent: string
  source: LegacySource
  lifecycle: readonly { discussionID: string; status: Discussion["status"] }[]
  intended: { backend: "private"; privateRevision: 1; boundary: "prepared" }
  token: string
  command: string
}>

export type MigrationResult = Readonly<{
  source: LegacySource
  privateRevision: number
  privateDigest: string
}>

export type SourceDeletionPreview = Readonly<{
  source: LegacySource
  private: { revision: number; digest: string }
  token: string
  command: string
}>

export type StorageState = Readonly<{
  platform: "linux" | "other"
  selected: "native" | "private" | "new-private" | "conflict" | "unsupported"
  migration: "none" | "prepared" | "committed" | "retiring" | "retired" | "conflict"
  nativeStoreID?: string
  privateRevision?: number
  compactionEligible: boolean
  issues: readonly string[]
}>

export type QuiescentStart = {
  open: Extract<RuntimeReceipt, { kind: "participant-start-open" }>
  closed?: Extract<RuntimeReceipt, { kind: "participant-start-closed" }>
}

export type ParticipantQuiescenceVerifier = (
  owner: Owner,
  member: PanelMember,
  proof: Extract<RuntimeReceipt, { kind: "member-bound" }>,
  starts: readonly QuiescentStart[],
) => Promise<{ exhausted: boolean; reason?: string }>

export interface StoreMaintenance extends CompactionMaintenance {
  migrationPreview(owner: Owner): Promise<MigrationPreview>
  migrate(owner: Owner, token: string): Promise<MigrationResult>
  sourceDeletionPreview(owner: Owner): Promise<SourceDeletionPreview>
  deleteSource(owner: Owner, storeID: string, token: string): Promise<void>
  reconcileDeletedOwner(sessionID: string): Promise<void>
  reconcileOrphanedStores(): Promise<void>
  status(owner: Owner): Promise<StorageState>
}

export function migrationToken(input: {
  project: string
  owner: Owner
  source: LegacySource
}): string {
  return createHash("sha256").update(JSON.stringify([
    "opencode-debate/migrate/v1",
    input.project,
    resolve(input.owner.directory),
    input.owner.sessionID,
    input.owner.agent,
    input.source.storeID,
    input.source.revision,
    input.source.head,
    input.source.digest,
  ])).digest("hex")
}

export function sourceDeletionToken(input: {
  project: string
  owner: Owner
  source: LegacySource
  boundaryToken: string
  boundaryPrivate: { revision: number; digest: string }
  private: { revision: number; digest: string }
}): string {
  return createHash("sha256").update(JSON.stringify([
    "opencode-debate/delete-source/v1",
    input.project,
    resolve(input.owner.directory),
    input.owner.sessionID,
    input.owner.agent,
    input.source.storeID,
    input.source.revision,
    input.source.head,
    input.source.digest,
    input.boundaryToken,
    input.boundaryPrivate.revision,
    input.boundaryPrivate.digest,
    input.private.revision,
    input.private.digest,
  ])).digest("hex")
}

export type MaintenanceFailureStage = "preflight" | "publication"

/**
 * A maintenance failure is only an unconfirmed manager write once publication or
 * cleanup has begun. Read-only/preflight and storage-integrity failures still
 * reject at the store boundary but must not poison otherwise valid manager writes.
 */
export class MaintenanceFailure extends Error {
  readonly stage: MaintenanceFailureStage

  constructor(stage: MaintenanceFailureStage, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "AutomaticDebateMaintenanceFailure"
    this.stage = stage
  }
}

export interface ManagedCheckpointStore {
  load(owner: Owner, invocation?: CurrentInvocation): Promise<CheckpointSnapshot | undefined>
  save(owner: Owner, snapshot: CheckpointSnapshot, context: { agent: string; model: Model }, invocation?: CurrentInvocation): Promise<void>
  noteOwnerDeleted(sessionID: string): void
  noteOwnerDeletionRetained(sessionID: string): void
  maintenance: StoreMaintenance
}

/**
 * Parent removal is allowed only for private evidence that has no retained
 * containment, startup or delivery work. A 404 proves only parent absence.
 */
export function isOwnerRemovalSafe(head: PrivateHead): boolean {
  try {
    const state = parseConversationState(head.snapshot.state)
    const proof = head.snapshot.runtimeProof === undefined
      ? undefined : parseRuntimeJournal(head.snapshot.runtimeProof, state)
    if (state.discussions.length > 0 && !proof) return false
    const view = journalView(proof)

    for (const discussion of state.discussions) {
      if (discussion.status === "running" || discussion.status === "awaiting-evaluation") return false
      if (discussion.pendingTurns.length > 0) return false
      if ((discussion.deliveryUncertainCycles?.length ?? 0) > 0) return false
      if (discussion.cancellation
        && (discussion.cancellation.pendingSessionIDs.length > 0 || discussion.cancellation.errors.length > 0)) return false
      if (discussion.status === "cancelled" && !discussion.cancellation) return false

      for (const panelMember of discussion.panel) {
        const origin = view.members.get(panelMember.sessionID)
        if (!origin || origin.origin.discussionID !== discussion.id
          || JSON.stringify(origin.origin.member) !== JSON.stringify(panelMember)) return false
        if (origin.fenced && !origin.confirmed) return false
        // A paused/interrupted owner can still have active native participant
        // work even with no saved start-open receipt. Without durable fence and
        // stop confirmation, an abort failure from the deletion path would be
        // invisible in the old snapshot, so retain the evidence.
        if ((discussion.status === "paused" || discussion.status === "interrupted")
          && (!origin.fenced || !origin.confirmed)) return false
        for (const start of origin.starts.values()) {
          if (!start.closed) return false
        }
        if (discussion.status === "cancelled" && origin.starts.size > 0
          && (!origin.fenced || !origin.confirmed)) return false
      }
    }

    for (const item of state.outbox) {
      if (item.state !== "acknowledged") return false
    }
    for (const delivery of view.deliveries.values()) {
      if (!delivery.persisted || delivery.noCall || delivery.attempt === undefined) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Compaction is exclusively a maintenance operation for a completely settled,
 * terminal store. Age, process shutdown and transcript metadata are not proofs.
 */
export function isCompactionEligible(snapshot: CheckpointSnapshot): boolean {
  try {
    const state = parseConversationState(snapshot.state)
    if (state.discussions.length === 0) return false
    if (!snapshot.runtimeProof) return false
    const proof = parseRuntimeJournal(snapshot.runtimeProof, state)
    if (!proof) return false
    const view = journalView(proof)

    for (const discussion of state.discussions) {
      if (discussion.status !== "resolved" && discussion.status !== "cancelled") return false
      if (discussion.pendingTurns.length > 0) return false
      if ((discussion.deliveryUncertainCycles?.length ?? 0) > 0) return false
      if (discussion.status === "cancelled") {
        if (!discussion.cancellation) return false
        if (discussion.cancellation.pendingSessionIDs.length > 0
          || discussion.cancellation.errors.length > 0) return false
      }

      for (const member of discussion.panel) {
        const origin = view.members.get(member.sessionID)
        if (!origin) return false
        // A session-ID match is insufficient: the receipt must belong to this
        // discussion and bind the complete saved member identity.
        if (origin.origin.discussionID !== discussion.id
          || JSON.stringify(origin.origin.member) !== JSON.stringify(member)) return false
        // A fence without a confirmed stop is unresolved containment evidence.
        if (origin.fenced && !origin.confirmed) return false
        for (const start of origin.starts.values()) {
          if (!start.closed) return false
          if (discussion.status === "cancelled"
            && start.closed.startup === "synchronous-response"
            && (!origin.fenced || !origin.confirmed)) return false
        }
      }
    }

    for (const item of state.outbox) {
      if (item.state !== "acknowledged") return false
    }
    for (const delivery of view.deliveries.values()) {
      if (!delivery.persisted || delivery.noCall || delivery.attempt === undefined) return false
    }
    return true
  } catch {
    return false
  }
}

function compareSource(left: MigrationBoundary["source"], right: NativeCheckpointHead): boolean {
  return left.storeID === right.storeID && left.revision === right.revision
    && left.head === right.head && left.digest === right.digest
}

function sameSource(left: LegacySource, right: LegacySource): boolean {
  return left.storeID === right.storeID && left.revision === right.revision
    && left.head === right.head && left.digest === right.digest
}

function samePrivate(left: MigrationBoundary["private"], right: MigrationBoundary["private"]): boolean {
  return left.revision === right.revision && left.digest === right.digest
}

/** The private chain must carry the exact imported native source and never sit
 * below the boundary's import floor. At the floor its digest is the boundary digest;
 * later revisions are trusted only because Task 1 verified the predecessor chain and
 * preserved `legacy` unchanged. */
function migratedPrivateHead(boundary: MigrationBoundary, privateHead: PrivateHead): boolean {
  if (!privateHead.legacy || !sameSource(boundary.source, privateHead.legacy)) return false
  if (privateHead.revision < boundary.private.revision) return false
  return privateHead.revision !== boundary.private.revision || privateHead.digest === boundary.private.digest
}

/**
 * Pure backend decision. Non-Linux never consults private state and only fails
 * closed for a native child carrying a Linux migration marker.
 */
export function selectStorageBackend(platform: NodeJS.Platform, inventory: {
  native?: NativeCheckpointHead
  private?: PrivateHead
  boundary?: MigrationBoundary
}): StorageSelection {
  const native = inventory.native
  const privateHead = inventory.private
  const boundary = inventory.boundary

  if (platform !== "linux") {
    if (native?.migration) return { kind: "conflict", reason: "linux-migration-marker" }
    return { kind: "native" }
  }

  if (!boundary) {
    if (!native) return privateHead ? { kind: "private" } : { kind: "new-private" }
    if (native.migration) return { kind: "conflict", reason: "linux-migration-marker" }
    return privateHead ? { kind: "conflict", reason: "native-and-private" } : { kind: "native" }
  }

  if (boundary.state === "prepared") return { kind: "conflict", reason: "boundary-prepared" }
  if (boundary.state === "retiring") return { kind: "conflict", reason: "boundary-retiring" }

  if (boundary.state === "committed") {
    if (!native || !privateHead) return { kind: "conflict", reason: "boundary-source-missing" }
    const marker = native.migration
    if (!marker) return { kind: "conflict", reason: "migration-marker-missing" }
    if (!compareSource(boundary.source, native) || !sameSource(boundary.source, marker.source)
      || !samePrivate(boundary.private, marker.private) || boundary.token !== marker.token) {
      return { kind: "conflict", reason: "boundary-source-mismatch" }
    }
    if (!migratedPrivateHead(boundary, privateHead)) {
      return { kind: "conflict", reason: "private-source-mismatch" }
    }
    return { kind: "private" }
  }

  if (native) return { kind: "conflict", reason: "native-source-reappeared" }
  if (!privateHead) return { kind: "conflict", reason: "private-state-missing" }
  if (!migratedPrivateHead(boundary, privateHead)) {
    return { kind: "conflict", reason: "private-source-mismatch" }
  }
  return { kind: "private" }
}

type Resolution = {
  selection: StorageSelection
  privateHead?: PrivateHead
  privateStore?: PrivateStore
}

const OWNER_KEY_PATTERN = /^[a-f0-9]{64}$/u
const OWNER_REVISION_PATTERN = /^(\d{16})\.json$/u
const OWNER_PENDING_PATTERN = /^\.pending-(\d{16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const PRIVATE_RECORD_KIND = "opencode-debate-private-checkpoint"

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function isNotFoundResponse(value: unknown): boolean {
  if (value instanceof Response) return value.status === 404
  if (!isRecord(value)) {
    if (value instanceof Error && "response" in value) {
      const response = (value as { response?: unknown }).response
      return response instanceof Response && response.status === 404
    }
    return false
  }
  if (value.response instanceof Response) return value.response.status === 404
  if (value.status === 404 || value.statusCode === 404) return true
  return isRecord(value.response) && (value.response.status === 404 || value.response.statusCode === 404)
}

function assertRemovalDirectory(stats: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} is not a directory`)
  if ((Number(stats.mode) & 0o7777) !== 0o700) throw new Error(`${label} mode is not 0700`)
  const uid = process.getuid?.()
  if (uid === undefined || stats.uid !== uid) throw new Error(`${label} owner is invalid`)
}

function assertRemovalFile(stats: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} is not a regular file`)
  if ((Number(stats.mode) & 0o7777) !== 0o600) throw new Error(`${label} mode is not 0600`)
  const uid = process.getuid?.()
  if (uid === undefined || stats.uid !== uid) throw new Error(`${label} owner is invalid`)
  if (stats.nlink !== 1) throw new Error(`${label} has multiple hard links`)
}

async function syncRemovalDirectory(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export function createManagedStore(
  input: PluginInput,
  mode: RuntimeStorageMode,
  retainedRefusals: (owner: Owner) => readonly RefusedInvocation[] = () => [],
  quiescence?: ParticipantQuiescenceVerifier,
): ManagedCheckpointStore {
  const native: NativeCheckpointStore = createCheckpointStore(input, parseConversationState, retainedRefusals)
  const privateStores = new Map<string, Promise<PrivateStore>>()
  const privateHeads = new Map<string, { revision: number; digest: string } | null>()
  const maintenanceRuns = new Set<string>()
  const maintenancePublicationStarted = new Set<string>()
  const deletedOwners = new Set<string>()
  const ownerIssues = new Map<string, Set<string>>()
  const orphanIssues = new Set<string>()
  let stateRoot: string | undefined
  let cleanupTail: Promise<void> = Promise.resolve()

  function recordOwnerIssue(sessionID: string, issue: string): void {
    const existing = ownerIssues.get(sessionID) ?? new Set<string>()
    existing.add(issue)
    ownerIssues.set(sessionID, existing)
  }

  function recordOrphanIssue(issue: string): void {
    orphanIssues.add(issue)
  }

  function issuesFor(sessionID: string): string[] {
    return [...new Set([...(ownerIssues.get(sessionID) ?? []), ...orphanIssues])]
  }

  async function resolveStateRoot(): Promise<string> {
    if (stateRoot !== undefined) return stateRoot
    let response: unknown
    try {
      response = await input.client.path.get({ query: { directory: input.directory } })
    } catch {
      fail("state path is unavailable")
    }
    const value = data(response, "state path lookup")
    if (!isRecord(value) || typeof value.state !== "string" || value.state.trim().length === 0
      || !isAbsolute(value.state)) {
      fail("state path is unavailable or not absolute")
    }
    stateRoot = resolve(value.state)
    return stateRoot
  }

  function withCleanupQueue<T>(operation: () => Promise<T>): Promise<T> {
    // Startup scans and deleted-owner reconciliation inspect and remove the same
    // owner directories. They must never observe each other's unlink/rmdir
    // boundary, so every full cleanup shares one queue. The tail always settles
    // and later operations remain admitted after an earlier failure.
    const result = cleanupTail.then(() => operation())
    cleanupTail = result.then(() => undefined, () => undefined)
    return result
  }

  async function privateStore(owner: Owner, root: string): Promise<PrivateStore> {
    const existing = privateStores.get(owner.sessionID)
    if (existing) return existing
    const pending = openPrivateStore({
      stateRoot: root,
      project: input.project.id,
      owner,
      hooks: {
        boundary: async (point) => {
          if (maintenanceRuns.has(owner.sessionID)
            && (point === "opened" || point === "base-verified" || point === "superseded-removed")) {
            maintenancePublicationStarted.add(owner.sessionID)
          }
        },
      },
    })
    privateStores.set(owner.sessionID, pending)
    try {
      return await pending
    } catch (error) {
      if (privateStores.get(owner.sessionID) === pending) privateStores.delete(owner.sessionID)
      throw error
    }
  }

  type OwnerDirectoryInspection =
    | { kind: "owner"; owner: Owner }
    | { kind: "other" }
    | { kind: "no-head" }

  async function inspectOwnerDirectory(directory: string, key: string): Promise<OwnerDirectoryInspection> {
    let revisionName: string | undefined
    for (const entry of await readdir(directory)) {
      const match = OWNER_REVISION_PATTERN.exec(entry)
      if (!match) continue
      if (revisionName === undefined || entry > revisionName) revisionName = entry
    }
    if (revisionName === undefined) return { kind: "no-head" }

    const path = join(directory, revisionName)
    const stats = await lstat(path)
    assertRemovalFile(stats, "private revision")
    let envelope: unknown
    try {
      envelope = JSON.parse(await readFile(path, "utf8")) as unknown
    } catch {
      throw new Error("private revision is invalid")
    }
    if (!isRecord(envelope) || typeof envelope.payload !== "string") throw new Error("private revision is invalid")
    let payload: unknown
    try {
      payload = JSON.parse(envelope.payload) as unknown
    } catch {
      throw new Error("private revision is invalid")
    }
    if (!isRecord(payload) || payload.kind !== PRIVATE_RECORD_KIND || payload.version !== 1
      || !isRecord(payload.binding)) throw new Error("private revision is invalid")
    const binding = payload.binding
    if (binding.kind !== "opencode-debate-storage" || binding.version !== 1
      || typeof binding.project !== "string" || typeof binding.directory !== "string"
      || typeof binding.owner !== "string" || typeof binding.agent !== "string") {
      throw new Error("private revision binding is invalid")
    }
    const owner: Owner = {
      sessionID: binding.owner,
      agent: binding.agent,
      directory: resolve(binding.directory),
    }
    if (binding.project !== input.project.id || owner.directory !== resolve(input.directory)) return { kind: "other" }
    if (privateOwnerKey(input.project.id, owner) !== key) throw new Error("private owner directory binding is invalid")
    return { kind: "owner", owner }
  }

  async function parentPresence(sessionID: string): Promise<"absent" | "present" | "unknown"> {
    let response: unknown
    try {
      response = await input.client.session.get({
        path: { id: sessionID },
        query: { directory: input.directory },
      })
    } catch (error) {
      return isNotFoundResponse(error) ? "absent" : "unknown"
    }
    if (isNotFoundResponse(response)) return "absent"
    if (!isRecord(response) || response.error !== undefined && response.error !== null
      || response.data === undefined || response.data === null) return "unknown"
    return "present"
  }

  function incompleteBoundary(boundary: MigrationBoundary | undefined): boolean {
    return boundary?.state === "prepared" || boundary?.state === "retiring"
  }

  async function removeOwnerArtifacts(root: string, owner: Owner, key: string, hasHead: boolean): Promise<void> {
    let current = resolve(root)
    for (const component of ["opencode-debate", "auto-debate", "v2"]) {
      current = join(current, component)
      assertRemovalDirectory(await lstat(current), "plugin directory")
    }
    const ownerDirectory = join(current, key)
    assertRemovalDirectory(await lstat(ownerDirectory), "owner directory")

    const files: string[] = []
    let revisions = 0
    for (const entry of await readdir(ownerDirectory)) {
      const final = OWNER_REVISION_PATTERN.test(entry)
      if (!final && !OWNER_PENDING_PATTERN.test(entry)) throw new Error("owner directory contains an unknown entry")
      const path = join(ownerDirectory, entry)
      assertRemovalFile(await lstat(path), final ? "private revision" : "private pending file")
      files.push(path)
      if (final) revisions += 1
    }
    if (hasHead && revisions === 0) throw new Error("owner directory lost its committed revision")

    const boundaryPath = migrationBoundaryPath(root, input.project.id, owner)
    let boundaryExists = false
    try {
      assertRemovalFile(await lstat(boundaryPath), "migration boundary")
      boundaryExists = true
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }

    for (const path of files) await unlink(path)
    await syncRemovalDirectory(ownerDirectory)
    await rmdir(ownerDirectory)
    await syncRemovalDirectory(current)
    if (boundaryExists) {
      const migrations = join(current, "migrations")
      assertRemovalDirectory(await lstat(migrations), "migration directory")
      await unlink(boundaryPath)
      await syncRemovalDirectory(migrations)
    }
  }

  async function readOwnerFromBoundary(root: string, key: string): Promise<Owner | undefined> {
    const path = join(privateStoreRoot(root), "migrations", `${key}.json`)
    let stats
    try {
      stats = await lstat(path)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    }
    assertRemovalFile(stats, "migration boundary")
    let envelope: unknown
    try {
      envelope = JSON.parse(await readFile(path, "utf8")) as unknown
    } catch {
      throw new Error("migration boundary is invalid")
    }
    if (!isRecord(envelope) || typeof envelope.payload !== "string") throw new Error("migration boundary is invalid")
    let payload: unknown
    try {
      payload = JSON.parse(envelope.payload) as unknown
    } catch {
      throw new Error("migration boundary is invalid")
    }
    if (!isRecord(payload) || payload.kind !== "opencode-debate-migration-boundary" || payload.version !== 1
      || typeof payload.project !== "string" || typeof payload.directory !== "string"
      || typeof payload.owner !== "string" || typeof payload.agent !== "string") {
      throw new Error("migration boundary is invalid")
    }
    const owner: Owner = {
      sessionID: payload.owner,
      agent: payload.agent,
      directory: resolve(payload.directory),
    }
    if (payload.project !== input.project.id || owner.directory !== resolve(input.directory)) return undefined
    if (privateOwnerKey(input.project.id, owner) !== key) throw new Error("migration boundary binding is invalid")
    const boundary = await readMigrationBoundary(root, input.project.id, owner)
    if (!boundary) throw new Error("migration boundary is missing")
    return owner
  }

  async function removeBoundaryOnly(root: string, owner: Owner, key: string): Promise<void> {
    let current = resolve(root)
    for (const component of ["opencode-debate", "auto-debate", "v2"]) {
      current = join(current, component)
      assertRemovalDirectory(await lstat(current), "plugin directory")
    }
    try {
      await lstat(join(current, key))
      throw new Error("owner directory still exists")
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const boundary = await readMigrationBoundary(root, input.project.id, owner)
    if (!boundary) return
    if (incompleteBoundary(boundary)) throw new Error("owner migration is incomplete")
    const migrations = join(current, "migrations")
    assertRemovalDirectory(await lstat(migrations), "migration directory")
    const path = migrationBoundaryPath(root, input.project.id, owner)
    assertRemovalFile(await lstat(path), "migration boundary")
    await unlink(path)
    await syncRemovalDirectory(migrations)
  }

  async function removeSafeOwner(root: string, owner: Owner, key: string): Promise<void> {
    const boundary = await readMigrationBoundary(root, input.project.id, owner)
    if (incompleteBoundary(boundary)) throw new Error("owner migration is incomplete")
    const store = await openPrivateStore({ stateRoot: root, project: input.project.id, owner })
    const head = await store.load()
    if (!head) throw new Error("owner store has no committed head")
    if (!isOwnerRemovalSafe(head)) throw new Error("owner store retains unresolved evidence")
    await removeOwnerArtifacts(root, owner, key, true)
  }

  async function reconcileTarget(root: string, sessionID: string, key: string): Promise<void> {
    const presence = await parentPresence(sessionID)
    if (presence === "present") return
    if (presence === "unknown") {
      recordOwnerIssue(sessionID, "parent session absence could not be proven")
      return
    }
    const directory = join(privateStoreRoot(root), key)
    let inspection: OwnerDirectoryInspection
    try {
      const stats = await lstat(directory)
      assertRemovalDirectory(stats, "owner directory")
      inspection = await inspectOwnerDirectory(directory, key)
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        // A previous cleanup may have removed the owner directory but stopped
        // before its outside-revision boundary. Complete only that exact remnant.
        try {
          const boundaryOwner = await readOwnerFromBoundary(root, key)
          if (!boundaryOwner) return
          if (boundaryOwner.sessionID !== sessionID) {
            recordOwnerIssue(sessionID, "migration boundary binding does not match the deleted parent")
            return
          }
          await removeBoundaryOnly(root, boundaryOwner, key)
          ownerIssues.delete(sessionID)
        } catch {
          recordOwnerIssue(sessionID, "migration boundary cleanup could not be completed safely")
        }
        return
      }
      recordOwnerIssue(sessionID, "owner store could not be inspected")
      return
    }

    try {
      if (inspection.kind === "other") {
        recordOwnerIssue(sessionID, "owner store binding is outside this project and directory")
        return
      }
      if (inspection.kind === "no-head") {
        // An empty or pending-only directory can also be a lost committed
        // revision. There is no private head to prove removal safety, so retain
        // it as evidence; only an already-complete boundary with no owner
        // directory is treated as the boundary-only remnant above.
        recordOwnerIssue(sessionID, "owner store has no committed head; retained for inspection")
        return
      } else {
        if (inspection.owner.sessionID !== sessionID) {
          recordOwnerIssue(sessionID, "owner store binding does not match the deleted parent")
          return
        }
        await removeSafeOwner(root, inspection.owner, key)
      }
      ownerIssues.delete(sessionID)
    } catch {
      recordOwnerIssue(sessionID, "owner store cleanup could not be completed safely")
    }
  }

  async function resolveBackend(owner: Owner, invocation?: CurrentInvocation): Promise<Resolution> {
    if (mode === "native") return { selection: { kind: "native" } }
    if (process.platform !== "linux") {
      const probe = await native.probe(owner)
      // Only storeID/migration are meaningful for the non-Linux decision; private
      // state and the API state path are never consulted on this branch.
      const nativeHead = probe === undefined ? undefined : {
        storeID: probe.storeID,
        revision: 0,
        head: "",
        digest: "",
        snapshot: { state: { version: 1 as const, discussions: [], outbox: [] } },
        ...(probe.migration === undefined ? {} : { migration: probe.migration }),
      }
      return { selection: selectStorageBackend(process.platform, { native: nativeHead }) }
    }

    const root = await resolveStateRoot()
    const store = await privateStore(owner, root)
    const privateHead = await store.load()
    const boundary = await readMigrationBoundary(root, input.project.id, owner)

    if (!privateHead) {
      const nativeHead = await native.inspect(owner, invocation)
      return {
        selection: selectStorageBackend(process.platform, {
          ...(nativeHead === undefined ? {} : { native: nativeHead }),
          ...(boundary === undefined ? {} : { boundary }),
        }),
        privateStore: store,
      }
    }

    const probe = await native.probe(owner)
    if (boundary?.state === "committed") {
      if (!probe) {
        return {
          selection: selectStorageBackend(process.platform, {
            private: privateHead,
            boundary,
          }),
          privateHead,
          privateStore: store,
        }
      }
      const nativeHead = await native.inspect(owner, invocation)
      return {
        selection: selectStorageBackend(process.platform, {
          ...(nativeHead === undefined ? {} : { native: nativeHead }),
          private: privateHead,
          boundary,
        }),
        privateHead,
        privateStore: store,
      }
    }
    if (boundary?.state === "retired") {
      if (probe) return { selection: { kind: "conflict", reason: "native-source-reappeared" }, privateHead, privateStore: store }
      return { selection: selectStorageBackend(process.platform, { private: privateHead, boundary }),
        privateHead, privateStore: store }
    }
    if (boundary) {
      return { selection: { kind: "conflict", reason: `boundary-${boundary.state}` }, privateHead, privateStore: store }
    }
    if (probe) {
      return {
        selection: { kind: "conflict", reason: probe.migration ? "linux-migration-marker" : "native-and-private" },
        privateHead,
        privateStore: store,
      }
    }
    return {
      selection: selectStorageBackend(process.platform, { private: privateHead }),
      privateHead,
      privateStore: store,
    }
  }

  function privateSelection(selection: StorageSelection): boolean {
    return selection.kind === "private" || selection.kind === "new-private"
  }

  function sourceOf(head: NativeCheckpointHead): LegacySource {
    return { storeID: head.storeID, revision: head.revision, head: head.head, digest: head.digest }
  }

  function boundaryFor(owner: Owner, source: LegacySource, privatePlan: { revision: number; digest: string },
    token: string, state: MigrationBoundary["state"]): MigrationBoundary {
    return {
      kind: "opencode-debate-migration-boundary",
      version: 1,
      state,
      project: input.project.id,
      directory: resolve(owner.directory),
      owner: owner.sessionID,
      agent: owner.agent,
      source: { ...source },
      private: { revision: privatePlan.revision, digest: privatePlan.digest },
      token,
    }
  }

  function assertPlannedPrivate(head: PrivateHead, planned: { digest: string; snapshot: CheckpointSnapshot },
    source: LegacySource): void {
    if (head.revision !== 1 || head.digest !== planned.digest || !head.legacy
      || !sameSource(head.legacy, source)
      || JSON.stringify(head.snapshot) !== JSON.stringify(planned.snapshot)) {
      fail("private migration evidence diverged from the native source; both sides are retained")
    }
  }

  function assertMarker(marker: NativeCheckpointHead["migration"], source: LegacySource, plannedDigest: string,
    token: string): void {
    if (!marker || !sameSource(marker.source, source) || marker.private.revision !== 1
      || marker.private.digest !== plannedDigest || marker.token !== token) {
      fail("native migration marker conflicts with the planned private import")
    }
  }

  async function assertMigrationQuiescent(
    owner: Owner,
    snapshot: CheckpointSnapshot,
  ): Promise<readonly { discussionID: string; status: Discussion["status"] }[]> {
    const state = parseConversationState(snapshot.state)
    const proof = snapshot.runtimeProof === undefined
      ? undefined : parseRuntimeJournal(snapshot.runtimeProof, state)
    if (state.discussions.length > 0 && !proof) {
      fail("migration requires complete runtime receipt evidence for every discussion")
    }
    const view = journalView(proof)
    for (const discussion of state.discussions) {
      if (discussion.status !== "paused" && discussion.status !== "resolved" && discussion.status !== "cancelled") {
        fail(`discussion ${discussion.id} is ${discussion.status}; migration requires paused, resolved or cancelled state`)
      }
      if (discussion.pendingTurns.length > 0) fail(`discussion ${discussion.id} has pending turns`)
      if ((discussion.deliveryUncertainCycles?.length ?? 0) > 0) {
        fail(`discussion ${discussion.id} has delivery uncertainty`)
      }
      if (discussion.status === "cancelled" && !discussion.cancellation) {
        fail(`cancelled discussion ${discussion.id} lacks cancellation evidence`)
      }
      if (discussion.cancellation && (discussion.cancellation.pendingSessionIDs.length > 0
        || discussion.cancellation.errors.length > 0)) {
        fail(`discussion ${discussion.id} has unresolved cancellation evidence`)
      }
      for (const panelMember of discussion.panel) {
        const origin = view.members.get(panelMember.sessionID)
        if (!origin || origin.origin.discussionID !== discussion.id
          || JSON.stringify(origin.origin.member) !== JSON.stringify(panelMember)) {
          fail(`discussion ${discussion.id} lacks an exact member-bound receipt`)
        }
        if (origin.fenced && !origin.confirmed) {
          fail(`participant ${panelMember.sessionID} has unconfirmed cessation evidence`)
        }
        if (discussion.status === "cancelled" && (!origin.fenced || !origin.confirmed)) {
          fail(`participant ${panelMember.sessionID} has unconfirmed cancellation cessation evidence`)
        }
        for (const start of origin.starts.values()) {
          if (!start.closed) fail(`participant ${panelMember.sessionID} has an unclosed startup`)
        }
        if (!quiescence) fail("participant quiescence cannot be verified")
        const result = await quiescence(owner, panelMember, origin.origin, [...origin.starts.values()])
        if (!result.exhausted) {
          fail(`participant ${panelMember.sessionID} is not quiescent: ${result.reason ?? "unknown evidence"}`)
        }
      }
    }
    for (const item of state.outbox) {
      if (item.state !== "acknowledged") fail(`outbox item ${item.id} is not acknowledged`)
    }
    for (const delivery of view.deliveries.values()) {
      if (!delivery.persisted || delivery.noCall || delivery.attempt === undefined) {
        fail(`delivery ${delivery.intent.delivery.id} is not settled`)
      }
    }
    return state.discussions.map((discussion) => ({ discussionID: discussion.id, status: discussion.status }))
  }

  type MigrationPlan = {
    kind: "new" | "marker-only" | "prepared"
    source: LegacySource
    lifecycle: readonly { discussionID: string; status: Discussion["status"] }[]
    token: string
    planned: ReturnType<typeof planPrivateRevision>
    privateHead?: PrivateHead
    boundary?: MigrationBoundary
    nativeHead: NativeCheckpointHead
    store: PrivateStore
  }

  function preparedMigrationEvidence(
    owner: Owner,
    root: string,
    boundary: MigrationBoundary,
    nativeHead: NativeCheckpointHead,
  ): { source: LegacySource; token: string; planned: ReturnType<typeof planPrivateRevision> } {
    if (boundary.state !== "prepared") {
      fail(`migration boundary is ${boundary.state}; no prepared migration retry is available`)
    }
    const source = sourceOf(nativeHead)
    if (!sameSource(boundary.source, source)) fail("prepared migration source changed")
    const expectedToken = migrationToken({ project: input.project.id, owner, source })
    if (boundary.token !== expectedToken) fail("prepared migration token does not match its source")
    assertMarker(nativeHead.migration, source, boundary.private.digest, boundary.token)
    const planned = planPrivateRevision({
      stateRoot: root,
      project: input.project.id,
      owner,
      revision: 1,
      previous: null,
      snapshot: nativeHead.snapshot,
      legacy: source,
    })
    if (planned.digest !== boundary.private.digest) {
      fail("prepared migration private digest diverged from the native source")
    }
    return { source, token: boundary.token, planned }
  }

  async function migrationPlan(owner: Owner): Promise<MigrationPlan> {
    const root = await resolveStateRoot()
    let store = await privateStore(owner, root)
    let privateHead: PrivateHead | undefined
    let boundary: MigrationBoundary | undefined
    let nativeHead: NativeCheckpointHead | undefined
    try {
      privateHead = await store.load()
    } catch (loadError) {
      // Ordinary new-owner failures remain closed. Only an exact prepared
      // boundary with a fresh, matching native source/marker/token may inspect an
      // interrupted first publish through a narrowly scoped recovery store.
      boundary = await readMigrationBoundary(root, input.project.id, owner)
      nativeHead = await native.inspect(owner)
      if (boundary?.state !== "prepared" || !nativeHead) throw loadError
      const evidence = preparedMigrationEvidence(owner, root, boundary, nativeHead)
      const recoveryStore = await openPrivateStore({
        stateRoot: root,
        project: input.project.id,
        owner,
        recovery: {
          revision: 1,
          digest: evidence.planned.digest,
          legacy: evidence.source,
          snapshot: evidence.planned.snapshot,
        },
      })
      privateHead = await recoveryStore.load()
      const pending = privateStores.get(owner.sessionID)
      if (pending && await pending.catch(() => undefined) === store) privateStores.delete(owner.sessionID)
      store = recoveryStore
    }

    if (boundary === undefined && nativeHead === undefined) {
      boundary = await readMigrationBoundary(root, input.project.id, owner)
      nativeHead = await native.inspect(owner)
    }

    if (boundary) {
      if (!nativeHead) fail("prepared migration source is missing")
      const evidence = preparedMigrationEvidence(owner, root, boundary, nativeHead)
      if (privateHead) assertPlannedPrivate(privateHead, evidence.planned, evidence.source)
      const lifecycle = await assertMigrationQuiescent(owner, nativeHead.snapshot)
      return {
        kind: "prepared",
        source: evidence.source,
        lifecycle,
        token: evidence.token,
        planned: evidence.planned,
        ...(privateHead === undefined ? {} : { privateHead }),
        boundary,
        nativeHead,
        store,
      }
    }

    if (!nativeHead) {
      if (privateHead) fail("owner is already using private storage; no migration is required")
      fail("owner has no native checkpoint to migrate and is already on private storage")
    }
    const source = sourceOf(nativeHead)
    const computedToken = migrationToken({ project: input.project.id, owner, source })
    const marker = nativeHead.migration
    if (!marker && privateHead) {
      fail("native and private checkpoint stores both exist without migration evidence")
    }
    const planned = planPrivateRevision({
      stateRoot: root,
      project: input.project.id,
      owner,
      revision: 1,
      previous: null,
      snapshot: nativeHead.snapshot,
      legacy: source,
    })
    let kind: MigrationPlan["kind"]
    let token: string
    if (marker) {
      if (!sameSource(marker.source, source)) {
        fail("native migration marker conflicts with the current source")
      }
      assertMarker(marker, source, planned.digest, marker.token)
      if (marker.token !== computedToken) fail("native migration marker token does not match its source")
      if (privateHead) assertPlannedPrivate(privateHead, planned, source)
      kind = "marker-only"
      token = marker.token
    } else {
      kind = "new"
      token = computedToken
    }
    const lifecycle = await assertMigrationQuiescent(owner, nativeHead.snapshot)
    return {
      kind,
      source,
      lifecycle,
      token,
      planned,
      ...(privateHead === undefined ? {} : { privateHead }),
      nativeHead,
      store,
    }
  }

  type SourceDeletionPlan = {
    root: string
    store: PrivateStore
    privateHead: PrivateHead
    boundary: MigrationBoundary
    source: LegacySource
    token: string
    nativeHead?: NativeCheckpointHead
  }

  async function sourceDeletionPlan(owner: Owner): Promise<SourceDeletionPlan> {
    const root = await resolveStateRoot()
    const store = await privateStore(owner, root)
    const privateHead = await store.load()
    if (!privateHead) fail("source deletion requires a committed private checkpoint")
    const boundary = await readMigrationBoundary(root, input.project.id, owner)
    if (!boundary) fail("source deletion requires a committed migration boundary")
    if (boundary.state === "retired") fail("migration source is already marked retired")
    if (boundary.state !== "committed" && boundary.state !== "retiring") {
      fail(`source deletion requires a committed migration, not ${boundary.state}`)
    }
    if (!migratedPrivateHead(boundary, privateHead)) {
      fail("private migration evidence does not match the source-deletion boundary")
    }
    const nativeHead = await native.inspectExact(owner, boundary.source.storeID)
    if (nativeHead) {
      const nativeSource = sourceOf(nativeHead)
      if (!sameSource(nativeSource, boundary.source)) fail("native source changed before deletion")
      assertMarker(nativeHead.migration, boundary.source, boundary.private.digest, boundary.token)
    } else if (boundary.state === "committed") {
      fail("committed migration source is missing; deletion requires an explicit retiring retry")
    }
    const token = sourceDeletionToken({
      project: input.project.id,
      owner,
      source: boundary.source,
      boundaryToken: boundary.token,
      boundaryPrivate: boundary.private,
      private: { revision: privateHead.revision, digest: privateHead.digest },
    })
    return {
      root,
      store,
      privateHead,
      boundary,
      source: boundary.source,
      token,
      ...(nativeHead === undefined ? {} : { nativeHead }),
    }
  }

  async function writeBoundaryVerified(root: string, owner: Owner, boundary: MigrationBoundary): Promise<MigrationBoundary> {
    await writeMigrationBoundary(root, boundary)
    const readBack = await readMigrationBoundary(root, input.project.id, owner)
    if (!readBack || JSON.stringify(readBack) !== JSON.stringify(boundary)) {
      fail("migration boundary did not verify after publication")
    }
    return readBack
  }

  return {
    load: async (owner, invocation) => {
      if (mode === "native") return native.load(owner, invocation)
      if (process.platform !== "linux") {
        const resolution = await resolveBackend(owner, invocation)
        if (resolution.selection.kind !== "native") {
          fail(`conflict: ${resolution.selection.kind === "conflict" ? resolution.selection.reason : resolution.selection.kind}`)
        }
        return native.load(owner, invocation)
      }
      const resolution = await resolveBackend(owner, invocation)
      if (resolution.selection.kind === "native") return native.load(owner, invocation)
      if (!privateSelection(resolution.selection)) {
        fail(`conflict: ${resolution.selection.kind === "conflict" ? resolution.selection.reason : resolution.selection.kind}`)
      }
      const current = resolution.privateHead
      const cached = privateHeads.get(owner.sessionID)
      if (cached !== undefined && cached !== null
        && (!current || current.revision !== cached.revision || current.digest !== cached.digest)) {
        fail("private head changed outside this retained runtime")
      }
      if (!current) {
        privateHeads.set(owner.sessionID, null)
        return undefined
      }
      privateHeads.set(owner.sessionID, { revision: current.revision, digest: current.digest })
      return structuredClone(current.snapshot)
    },

    noteOwnerDeleted: (sessionID) => {
      if (typeof sessionID === "string" && sessionID.trim().length > 0) deletedOwners.add(sessionID)
    },

    noteOwnerDeletionRetained: (sessionID) => {
      if (typeof sessionID === "string" && sessionID.trim().length > 0) {
        recordOwnerIssue(sessionID, "deletion containment or write evidence is unconfirmed")
      }
    },

    save: async (owner, snapshot, context, invocation) => {
      if (deletedOwners.has(owner.sessionID)) fail("owner session was deleted; new writes are refused")
      if (mode === "native") return native.save(owner, snapshot, context, invocation)
      if (process.platform !== "linux") {
        const resolution = await resolveBackend(owner, invocation)
        if (resolution.selection.kind !== "native") {
          fail(`conflict: ${resolution.selection.kind === "conflict" ? resolution.selection.reason : resolution.selection.kind}`)
        }
        return native.save(owner, snapshot, context, invocation)
      }
      let resolution = await resolveBackend(owner, invocation)
      if (resolution.selection.kind === "native") return native.save(owner, snapshot, context, invocation)
      if (!privateSelection(resolution.selection)) {
        fail(`conflict: ${resolution.selection.kind === "conflict" ? resolution.selection.reason : resolution.selection.kind}`)
      }

      if (!resolution.privateHead) {
        // Reconfirm absence under the retained writer lock before the first private publish.
        resolution = await resolveBackend(owner, invocation)
        if (resolution.selection.kind === "native") fail("backend changed before the first private save")
        if (!privateSelection(resolution.selection) || resolution.privateHead) {
          fail("private state changed before the first private save")
        }
      }

      const store = resolution.privateStore
      if (!store) fail("private store is unavailable")
      const current = resolution.privateHead
      const cached = privateHeads.get(owner.sessionID)
      if (cached === undefined) {
        if (current) fail("an existing private store must be loaded before saving")
      } else if (cached === null) {
        if (current) fail("private state changed before the first private save")
      } else if (!current || current.revision !== cached.revision || current.digest !== cached.digest) {
        fail("private head changed by an independent writer; refusing stale save")
      }

      const head = current
        ? await store.append({ revision: current.revision, digest: current.digest }, snapshot, current.legacy)
        : await store.append({ revision: 0, digest: null }, snapshot)
      privateHeads.set(owner.sessionID, { revision: head.revision, digest: head.digest })
    },

    maintenance: {
      migrationPreview: async (owner) => {
        if (mode === "native") fail("migration preview is unavailable in explicit native mode")
        if (process.platform !== "linux") fail("storage maintenance is supported only on Linux")
        const plan = await migrationPlan(owner)
        return {
          ownerSessionID: owner.sessionID,
          agent: owner.agent,
          source: { ...plan.source },
          lifecycle: plan.lifecycle.map((entry) => ({ ...entry })),
          intended: { backend: "private", privateRevision: 1, boundary: "prepared" },
          token: plan.token,
          command: `storage migrate ${plan.token} --writer-handover-confirmed`,
        } satisfies MigrationPreview
      },

      migrate: async (owner, token) => {
        try {
          if (mode === "native") fail("migration is unavailable in explicit native mode")
          if (process.platform !== "linux") fail("storage maintenance is supported only on Linux")
          if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) fail("migration token is invalid")
          const plan = await migrationPlan(owner)
          if (token !== plan.token) fail("migration token is stale or does not match the current source")

          let marker = plan.nativeHead.migration
          if (!marker) {
            marker = {
              kind: "opencode-debate-migrated",
              version: 1,
              privateOwnerKey: privateOwnerKey(input.project.id, owner),
              source: { ...plan.source },
              private: { revision: 1, digest: plan.planned.digest },
              token: plan.token,
            }
            await native.markMigrated(owner, marker, plan.source)
            const readBack = await native.inspect(owner)
            if (!readBack?.migration || JSON.stringify(readBack.migration) !== JSON.stringify(marker)
              || !sameSource(sourceOf(readBack), plan.source)) {
              fail("native migration marker did not verify after publication")
            }
          } else {
            assertMarker(marker, plan.source, plan.planned.digest, plan.token)
          }

          const root = await resolveStateRoot()
          let boundary = plan.boundary
          if (!boundary) {
            boundary = await writeBoundaryVerified(root, owner, boundaryFor(
              owner,
              plan.source,
              { revision: 1, digest: plan.planned.digest },
              plan.token,
              "prepared",
            ))
          } else if (boundary.state !== "prepared") {
            fail(`migration boundary is ${boundary.state}; no prepared retry is available`)
          }

          let currentNative = await native.inspect(owner)
          if (!currentNative || !sameSource(sourceOf(currentNative), plan.source)) {
            fail("native source changed after the migration marker was written")
          }

          const store = plan.store
          let privateHead = await store.load()
          if (!privateHead) {
            privateHead = await store.append({ revision: 0, digest: null }, plan.planned.snapshot, plan.source)
            if (privateHead.revision !== 1 || privateHead.digest !== plan.planned.digest) {
              fail("private migration import did not match the prepared digest")
            }
          } else {
            assertPlannedPrivate(privateHead, plan.planned, plan.source)
          }
          const verified = await store.load()
          if (!verified) fail("private migration import is missing after publication")
          assertPlannedPrivate(verified, plan.planned, plan.source)

          currentNative = await native.inspect(owner)
          if (!currentNative || !sameSource(sourceOf(currentNative), plan.source)) {
            fail("native source changed before the migration could commit")
          }

          const committed = await writeBoundaryVerified(root, owner, { ...boundary, state: "committed" })
          if (committed.state !== "committed") fail("migration boundary did not commit")
          privateHeads.set(owner.sessionID, { revision: verified.revision, digest: verified.digest })
          return {
            source: { ...plan.source },
            privateRevision: verified.revision,
            privateDigest: verified.digest,
          }
        } catch (error) {
          // A failed private read/append poisons the cached Task 1 store instance.
          // Retrying from a fresh instance revalidates any complete revision, which
          // is safe while the maintenance/writer lock is still held.
          privateStores.delete(owner.sessionID)
          throw error
        }
      },

      sourceDeletionPreview: async (owner) => {
        if (mode === "native") fail("source deletion is unavailable in explicit native mode")
        if (process.platform !== "linux") fail("storage maintenance is supported only on Linux")
        const plan = await sourceDeletionPlan(owner)
        return {
          source: { ...plan.source },
          private: { revision: plan.privateHead.revision, digest: plan.privateHead.digest },
          token: plan.token,
          command: `storage delete-source ${plan.source.storeID} ${plan.token}`,
        } satisfies SourceDeletionPreview
      },

      deleteSource: async (owner, storeID, token) => {
        if (mode === "native") fail("source deletion is unavailable in explicit native mode")
        if (process.platform !== "linux") fail("storage maintenance is supported only on Linux")
        if (typeof storeID !== "string" || storeID.length === 0) fail("an exact native store ID is required")
        if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) fail("source deletion token is invalid")
        const plan = await sourceDeletionPlan(owner)
        if (storeID !== plan.source.storeID) fail("the supplied native store ID does not match the migration source")
        if (token !== plan.token) fail("source deletion token is stale or does not match the current private head")
        const root = await resolveStateRoot()
        let boundary = plan.boundary
        if (boundary.state === "committed") {
          boundary = await writeBoundaryVerified(root, owner, { ...boundary, state: "retiring" })
        }
        if (boundary.state !== "retiring") fail("source deletion intent is not durable")
        await native.delete(owner, plan.source)
        const retired = await writeBoundaryVerified(root, owner, { ...boundary, state: "retired" })
        if (retired.state !== "retired") fail("source deletion did not retire the migration boundary")
      },

      reconcileDeletedOwner: async (sessionID) => {
        if (typeof sessionID !== "string" || sessionID.trim().length === 0) return
        // The tombstone is synchronous and precedes the queue so a concurrent save
        // cannot race ahead of the deletion decision while cleanup is waiting.
        deletedOwners.add(sessionID)
        if (process.platform !== "linux") return
        return withCleanupQueue(async () => {
          let root: string
          try {
            root = await resolveStateRoot()
          } catch {
            recordOwnerIssue(sessionID, "storage path is unavailable")
            return
          }
          // The owner key binds the current project and directory; agent is not part
          // of its derivation, so a deleted parent can be located without activation.
          const key = privateOwnerKey(input.project.id, {
            sessionID,
            agent: "",
            directory: input.directory,
          })
          await reconcileTarget(root, sessionID, key)
        })
      },

      reconcileOrphanedStores: () => withCleanupQueue(async () => {
        if (process.platform !== "linux") return
        let root: string
        try {
          root = await resolveStateRoot()
        } catch {
          recordOrphanIssue("orphan reconciliation could not resolve the storage path")
          return
        }
        let entries
        try {
          entries = await readdir(privateStoreRoot(root))
        } catch (error) {
          if (errorCode(error) === "ENOENT") return
          recordOrphanIssue("orphan reconciliation could not inspect the storage root")
          return
        }
        for (const name of entries) {
          if (!OWNER_KEY_PATTERN.test(name)) continue
          const directory = join(privateStoreRoot(root), name)
          let inspection: OwnerDirectoryInspection
          try {
            assertRemovalDirectory(await lstat(directory), "owner directory")
            inspection = await inspectOwnerDirectory(directory, name)
          } catch {
            recordOrphanIssue("an owner store could not be inspected")
            continue
          }
          if (inspection.kind === "no-head") {
            let ownerSessionID: string | undefined
            try {
              ownerSessionID = (await readOwnerFromBoundary(root, name))?.sessionID
            } catch {
              // The directory itself is retained; report without content.
            }
            if (ownerSessionID) {
              recordOwnerIssue(ownerSessionID, "owner store has no committed head; retained for inspection")
            } else {
              recordOrphanIssue("an owner store without a committed head was retained")
            }
            continue
          }
          if (inspection.kind !== "owner") continue
          const sessionID = inspection.owner.sessionID
          const presence = await parentPresence(sessionID)
          if (presence === "present") continue
          if (presence === "unknown") {
            recordOwnerIssue(sessionID, "parent session absence could not be proven")
            continue
          }
          try {
            await removeSafeOwner(root, inspection.owner, name)
            ownerIssues.delete(sessionID)
          } catch {
            recordOwnerIssue(sessionID, "owner store cleanup could not be completed safely")
          }
        }

        let boundaryEntries: string[]
        try {
          boundaryEntries = await readdir(join(privateStoreRoot(root), "migrations"))
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            recordOrphanIssue("orphan migration boundaries could not be inspected")
          }
          return
        }
        for (const name of boundaryEntries) {
          if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue
          const key = name.slice(0, -5)
          try {
            const owner = await readOwnerFromBoundary(root, key)
            if (!owner) continue
            try {
              await lstat(join(privateStoreRoot(root), key))
              continue // The owner-directory pass owns this store.
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw error
            }
            const presence = await parentPresence(owner.sessionID)
            if (presence === "present") continue
            if (presence === "unknown") {
              recordOwnerIssue(owner.sessionID, "parent session absence could not be proven")
              continue
            }
            await removeBoundaryOnly(root, owner, key)
            ownerIssues.delete(owner.sessionID)
          } catch {
            recordOrphanIssue("an orphan migration boundary could not be completed safely")
          }
        }
      }),

      status: async (owner) => {
        const platform = process.platform === "linux" ? "linux" as const : "other" as const
        if (mode === "native") {
          return { platform, selected: "native", migration: "none", compactionEligible: false, issues: [] }
        }
        if (platform === "other") {
          const probe = await native.probe(owner)
          return {
            platform,
            selected: probe?.migration ? "conflict" : "native",
            migration: probe?.migration ? "conflict" : "none",
            compactionEligible: false,
            issues: [
              ...(probe?.migration ? ["linux migration marker is not supported on this platform"] : []),
              ...issuesFor(owner.sessionID),
            ],
          }
        }
        try {
          const root = await resolveStateRoot()
          const store = await privateStore(owner, root)
          const privateHead = await store.load()
          const boundary = await readMigrationBoundary(root, input.project.id, owner)
          const probe = await native.probe(owner)
          // A retired/committed private owner may retain unrelated participant
          // children; absence evidence must not turn a valid private selection
          // into a conflict just because those children are not checkpoint stores.
          const nativeHead = probe !== undefined || privateHead === undefined
            ? await native.inspect(owner)
            : undefined
          const selection = selectStorageBackend(platform, {
            ...(nativeHead === undefined ? {} : { native: nativeHead }),
            ...(privateHead === undefined ? {} : { private: privateHead }),
            ...(boundary === undefined ? {} : { boundary }),
          })
          const selected: StorageState["selected"] = selection.kind === "none" ? "unsupported" : selection.kind
          return {
            platform,
            selected,
            migration: boundary?.state ?? (nativeHead?.migration ? "conflict" : "none"),
            ...(nativeHead === undefined ? {} : { nativeStoreID: nativeHead.storeID }),
            ...(privateHead === undefined ? {} : { privateRevision: privateHead.revision }),
            compactionEligible: selection.kind === "private" && privateHead !== undefined
              && isCompactionEligible(privateHead.snapshot),
            issues: [
              ...(selection.kind === "conflict" ? [selection.reason] : []),
              ...issuesFor(owner.sessionID),
            ],
          }
        } catch (error) {
          return {
            platform,
            selected: "conflict",
            migration: "conflict",
            compactionEligible: false,
            issues: [
              error instanceof Error ? error.message : "storage status is unavailable",
              ...issuesFor(owner.sessionID),
            ],
          }
        }
      },

      compactIfEligible: async (owner, predicate) => {
        const sessionID = owner.sessionID
        maintenanceRuns.add(sessionID)
        maintenancePublicationStarted.delete(sessionID)
        try {
          if (mode === "native" || process.platform !== "linux") {
            return { status: "legacy", reason: "compaction is available only for private Linux storage" }
          }
          const resolution = await resolveBackend(owner)
          if (resolution.selection.kind === "native") {
            return { status: "legacy", reason: "the selected backend is the native checkpoint store" }
          }
          if (resolution.selection.kind === "conflict") {
            return { status: "not-eligible", reason: `storage selection conflict: ${resolution.selection.reason}` }
          }
          if (resolution.selection.kind !== "private") {
            return { status: "not-eligible", reason: "no committed private checkpoint is selected" }
          }

          const store = resolution.privateStore
          const current = resolution.privateHead
          if (!store || !current) return { status: "not-eligible", reason: "the private checkpoint head is unavailable" }
          const cached = privateHeads.get(owner.sessionID)
          if (cached === undefined) {
            return { status: "not-eligible", reason: "the private checkpoint was not loaded by this retained runtime" }
          }
          if (cached === null) return { status: "not-eligible", reason: "there is no committed private checkpoint" }
          if (current.revision !== cached.revision || current.digest !== cached.digest) {
            return { status: "not-eligible", reason: "the private checkpoint head changed independently" }
          }

          let eligible: boolean
          try { eligible = predicate(structuredClone(current.snapshot)) }
          catch { return { status: "not-eligible", reason: "the compaction eligibility check failed" } }
          if (!eligible) return { status: "not-eligible", reason: "the current checkpoint is not fully settled" }

          const head = await store.compact(
            { revision: current.revision, digest: current.digest },
            current.snapshot,
          )
          privateHeads.set(owner.sessionID, { revision: head.revision, digest: head.digest })
          return { status: "compacted", revision: head.revision, digest: head.digest }
        } catch (error) {
          const stage: MaintenanceFailureStage = maintenancePublicationStarted.has(sessionID)
            ? "publication" : "preflight"
          throw new MaintenanceFailure(stage, `Automatic-debate maintenance ${stage} failure: ${
            error instanceof Error ? error.message : String(error)}`, { cause: error })
        } finally {
          maintenancePublicationStarted.delete(sessionID)
          maintenanceRuns.delete(sessionID)
        }
      },
    },
  }
}

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
  openPrivateStore,
  privateOwnerKey,
  privateStoreRoot,
  type PrivateHead,
  type PrivateStore,
} from "./private-store.ts"
import type {
  CheckpointSnapshot,
  Owner,
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

export interface StoreMaintenance extends CompactionMaintenance {
  reconcileDeletedOwner(sessionID: string): Promise<void>
  reconcileOrphanedStores(): Promise<void>
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

/** Native checkpoint state stays native; a prior migration marker must never
 * make its source resumable after migration support has been removed. */
export function selectStorageBackend(platform: NodeJS.Platform, inventory: {
  native?: NativeCheckpointHead
  private?: PrivateHead
}): StorageSelection {
  const native = inventory.native
  const privateHead = inventory.private
  if (native?.migration) return { kind: "conflict", reason: "linux-migration-marker" }
  if (platform !== "linux") {
    return { kind: "native" }
  }
  if (native && privateHead) return { kind: "conflict", reason: "native-and-private" }
  if (native) return { kind: "native" }
  return privateHead ? { kind: "private" } : { kind: "new-private" }
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
): ManagedCheckpointStore {
  const native: NativeCheckpointStore = createCheckpointStore(input, parseConversationState, retainedRefusals)
  const privateStores = new Map<string, Promise<PrivateStore>>()
  const privateHeads = new Map<string, { revision: number; digest: string } | null>()
  const maintenanceRuns = new Set<string>()
  const maintenancePublicationStarted = new Set<string>()
  const deletedOwners = new Set<string>()
  let stateRoot: string | undefined
  let cleanupTail: Promise<void> = Promise.resolve()

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

  async function removeOwnerArtifacts(root: string, key: string, hasHead: boolean): Promise<void> {
    const current = join(resolve(root), "opencode-debate")
    assertRemovalDirectory(await lstat(current), "plugin directory")
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

    for (const path of files) await unlink(path)
    await syncRemovalDirectory(ownerDirectory)
    await rmdir(ownerDirectory)
    await syncRemovalDirectory(current)
  }

  async function removeSafeOwner(root: string, owner: Owner, key: string): Promise<void> {
    const store = await openPrivateStore({ stateRoot: root, project: input.project.id, owner })
    const head = await store.load()
    if (!head) throw new Error("owner store has no committed head")
    if (!isOwnerRemovalSafe(head)) throw new Error("owner store retains unresolved evidence")
    await removeOwnerArtifacts(root, key, true)
  }

  async function reconcileTarget(root: string, sessionID: string, key: string): Promise<void> {
    const presence = await parentPresence(sessionID)
    if (presence !== "absent") return
    const directory = join(privateStoreRoot(root), key)
    let inspection: OwnerDirectoryInspection
    try {
      const stats = await lstat(directory)
      assertRemovalDirectory(stats, "owner directory")
      inspection = await inspectOwnerDirectory(directory, key)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      return
    }

    try {
      if (inspection.kind !== "owner") {
        // An empty or pending-only directory can also be a lost committed
        // revision. There is no private head to prove removal safety, so retain
        // it as evidence rather than treating it as an unused store.
        return
      }
      if (inspection.owner.sessionID !== sessionID) return
      await removeSafeOwner(root, inspection.owner, key)
    } catch {
      // Unknown, corrupt or incomplete deletion evidence is retained.
    }
  }

  async function resolveBackend(owner: Owner, invocation?: CurrentInvocation): Promise<Resolution> {
    if (mode === "native") return { selection: { kind: "native" } }
    if (process.platform !== "linux") {
      const probe = await native.probe(owner)
      // Non-Linux remains native-only. A retained Linux migration marker is
      // refusal evidence, not authority to continue from the native source.
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
    if (!privateHead) {
      const nativeHead = await native.inspect(owner, invocation)
      return {
        selection: selectStorageBackend(process.platform, nativeHead ? { native: nativeHead } : {}),
        privateStore: store,
      }
    }

    const probe = await native.probe(owner)
    return {
      selection: selectStorageBackend(process.platform, {
        private: privateHead,
        ...(probe === undefined ? {} : { native: {
          storeID: probe.storeID,
          revision: 0,
          head: "",
          digest: "",
          snapshot: { state: { version: 1 as const, discussions: [], outbox: [] } },
          ...(probe.migration === undefined ? {} : { migration: probe.migration }),
        } }),
      }),
      privateHead,
      privateStore: store,
    }
  }

  function privateSelection(selection: StorageSelection): boolean {
    return selection.kind === "private" || selection.kind === "new-private"
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
        ? await store.append({ revision: current.revision, digest: current.digest }, snapshot)
        : await store.append({ revision: 0, digest: null }, snapshot)
      privateHeads.set(owner.sessionID, { revision: head.revision, digest: head.digest })
    },

    maintenance: {
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
          return
        }
        let entries
        try {
          entries = await readdir(privateStoreRoot(root))
        } catch (error) {
          if (errorCode(error) === "ENOENT") return
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
            continue
          }
          if (inspection.kind === "no-head") continue
          if (inspection.kind !== "owner") continue
          const sessionID = inspection.owner.sessionID
          const presence = await parentPresence(sessionID)
          if (presence !== "absent") continue
          try {
            await removeSafeOwner(root, inspection.owner, name)
          } catch { /* Unknown or corrupt deletion evidence is retained. */ }
        }
      }),

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

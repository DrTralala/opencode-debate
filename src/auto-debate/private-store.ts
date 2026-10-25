import { createHash, randomUUID } from "node:crypto"
import { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } from "node:constants"
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import type {
  CheckpointSnapshot,
  LegacySource,
  MigrationBoundary,
  Owner,
  RuntimeJournal,
  StorageBinding,
} from "./types.ts"
import {
  assertRuntimeProofPrefix,
  cloneCheckpointSnapshot,
  parseConversationState,
  parseRuntimeJournal,
} from "./validation.ts"

export type StoreBoundary = "opened" | "written" | "file-synced" | "closed" | "renamed"
  | "directory-synced" | "verified" | "base-verified" | "superseded-removed"

export type PrivateHead = {
  revision: number
  digest: string
  snapshot: CheckpointSnapshot
  legacy?: LegacySource
  compaction?: { throughRevision: number; throughDigest: string }
}

export interface PrivateStore {
  readonly directory: string
  load(): Promise<PrivateHead | undefined>
  append(expected: { revision: number; digest: string | null }, snapshot: CheckpointSnapshot, legacy?: LegacySource): Promise<PrivateHead>
  compact(expected: { revision: number; digest: string }, snapshot: CheckpointSnapshot): Promise<PrivateHead>
  close(): Promise<void>
}

type Hooks = { boundary?: (point: StoreBoundary) => Promise<void> }
type GenesisRecovery = {
  revision: 1
  digest: string
  legacy: LegacySource
  snapshot: CheckpointSnapshot
}
type Options = { stateRoot: string; project: string; owner: Owner; hooks?: Hooks; recovery?: GenesisRecovery }
type RecoveryPlan = RecordPlan & { legacy: LegacySource }
type ParsedRecord = {
  revision: number
  digest: string
  previous: string | null
  compaction?: { throughRevision: number; throughDigest: string }
  legacy?: LegacySource
  snapshot: CheckpointSnapshot
}
type StatLike = {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  mode: number
  uid: number
  nlink: number
  ino: number
  dev: number
}

const KIND = "opencode-debate-private-checkpoint"
const VERSION = 1
const ROOT_COMPONENTS = ["opencode-debate", "auto-debate", "v2"] as const
const REVISION_WIDTH = 16
const FINAL_PATTERN = /^(\d{16})\.json$/
const PENDING_PATTERN = /^\.pending-(\d{16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

class PrivateStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PrivateStoreError"
  }
}

function storeError(operation: string, revision: number | undefined, category: string): PrivateStoreError {
  const label = revision === undefined ? operation : `${operation} revision ${revision}`
  return new PrivateStoreError(`Automatic-debate private store ${label}: ${category}`)
}

function codeOf(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function sameLegacy(left: LegacySource | undefined, right: LegacySource | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function copyLegacy(value: LegacySource): LegacySource {
  return { storeID: value.storeID, revision: value.revision, head: value.head, digest: value.digest }
}

function validateLegacy(value: unknown): LegacySource {
  if (!isPlainObject(value) || !hasExactKeys(value, ["storeID", "revision", "head", "digest"])) {
    throw new Error("Automatic-debate checkpoint legacy source is invalid")
  }
  if (!nonEmptyString(value.storeID) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !nonEmptyString(value.head) || typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) {
    throw new Error("Automatic-debate checkpoint legacy source is invalid")
  }
  return { storeID: value.storeID, revision: value.revision as number, head: value.head, digest: value.digest }
}

function parseLegacy(value: unknown, operation: string, revision: number): LegacySource | undefined {
  if (value === null) return undefined
  try {
    return validateLegacy(value)
  } catch {
    throw storeError(operation, revision, "legacy source is invalid")
  }
}

function parseCompaction(value: unknown, operation: string, revision: number): ParsedRecord["compaction"] {
  if (value === null) return undefined
  if (!isPlainObject(value) || !hasExactKeys(value, ["throughRevision", "throughDigest"])
    || !Number.isSafeInteger(value.throughRevision) || (value.throughRevision as number) < 1
    || typeof value.throughDigest !== "string" || !DIGEST_PATTERN.test(value.throughDigest)) {
    throw storeError(operation, revision, "compaction metadata is invalid")
  }
  return { throughRevision: value.throughRevision as number, throughDigest: value.throughDigest }
}

function validateBinding(value: unknown, expected: StorageBinding, operation: string, revision: number): void {
  if (!isPlainObject(value) || !hasExactKeys(value, ["kind", "version", "project", "directory", "owner", "agent"])
    || value.kind !== expected.kind || value.version !== expected.version
    || value.project !== expected.project || value.directory !== expected.directory
    || value.owner !== expected.owner || value.agent !== expected.agent) {
    throw storeError(operation, revision, "binding is invalid")
  }
}

function validateExpected(expected: { revision: number; digest: string | null }, operation: string): void {
  if (!Number.isSafeInteger(expected.revision) || expected.revision < 0 || expected.revision === Number.MAX_SAFE_INTEGER) {
    throw storeError(operation, expected.revision, "revision is invalid")
  }
  if (expected.revision === 0) {
    if (expected.digest !== null) throw storeError(operation, expected.revision, "revision digest is invalid")
    return
  }
  if (typeof expected.digest !== "string" || !DIGEST_PATTERN.test(expected.digest)) {
    throw storeError(operation, expected.revision, "revision digest is invalid")
  }
}

function revisionName(operation: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision === Number.MAX_SAFE_INTEGER) {
    throw storeError(operation, revision, "revision is invalid")
  }
  return `${String(revision).padStart(REVISION_WIDTH, "0")}.json`
}

function assertDirectory(stats: StatLike, operation: string, revision?: number): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw storeError(operation, revision, "directory type is invalid")
  }
  if ((stats.mode & 0o7777) !== 0o700) {
    throw storeError(operation, revision, "directory mode is not 0700")
  }
  const uid = process.getuid?.()
  if (uid === undefined || stats.uid !== uid) {
    throw storeError(operation, revision, "directory owner is invalid")
  }
}

function assertFile(stats: StatLike, operation: string, revision?: number): void {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw storeError(operation, revision, "file type is invalid")
  }
  if ((stats.mode & 0o7777) !== 0o600) {
    throw storeError(operation, revision, "file mode is not 0600")
  }
  const uid = process.getuid?.()
  if (uid === undefined || stats.uid !== uid) {
    throw storeError(operation, revision, "file owner is invalid")
  }
  if (stats.nlink !== 1) {
    throw storeError(operation, revision, "file has multiple hard links")
  }
}

async function syncDirectory(path: string, operation: string, revision?: number): Promise<void> {
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    throw storeError(operation, revision, "directory sync failed")
  }
  try {
    await handle.sync()
  } catch {
    throw storeError(operation, revision, "directory sync failed")
  } finally {
    await handle.close()
  }
}

export function privateStoreRoot(stateRoot: string): string {
  return join(resolve(stateRoot), ...ROOT_COMPONENTS)
}

export function privateOwnerKey(project: string, owner: Owner): string {
  return sha256(JSON.stringify(["opencode-debate/private-owner/v1", project, resolve(owner.directory), owner.sessionID]))
}

function privateBinding(stateRoot: string, project: string, owner: Owner): StorageBinding {
  return {
    kind: "opencode-debate-storage",
    version: 1,
    project,
    directory: resolve(owner.directory),
    owner: owner.sessionID,
    agent: owner.agent,
  }
}

type RecordPlan = Readonly<{ snapshot: CheckpointSnapshot; payload: string; digest: string }>

function recordPlan(
  binding: StorageBinding,
  revision: number,
  previous: string | null,
  snapshot: CheckpointSnapshot,
  legacy: LegacySource | undefined,
  compaction: { throughRevision: number; throughDigest: string } | undefined,
): RecordPlan {
  const captured = cloneCheckpointSnapshot(snapshot, binding)
  const payload = JSON.stringify({
    kind: KIND,
    version: VERSION,
    binding,
    revision,
    previous,
    compaction: compaction ?? null,
    legacy: legacy ?? null,
    state: captured.state,
    ...(captured.runtimeProof === undefined ? {} : { runtimeProof: captured.runtimeProof }),
    ...(captured.legacyOutboxIDs === undefined ? {} : { legacyOutboxIDs: captured.legacyOutboxIDs }),
  })
  return { snapshot: captured, payload, digest: sha256(payload) }
}

/**
 * Build the exact revision record a private append would publish. Migration uses
 * this before writing its native marker and prepared boundary, so the durable
 * evidence can bind the planned digest before any private file exists.
 */
export function planPrivateRevision(options: {
  stateRoot: string
  project: string
  owner: Owner
  revision: number
  previous: string | null
  snapshot: CheckpointSnapshot
  legacy?: LegacySource
  compaction?: { throughRevision: number; throughDigest: string }
}): RecordPlan {
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) {
    throw new Error("Automatic-debate private revision plan is invalid")
  }
  const legacy = options.legacy === undefined ? undefined : copyLegacy(validateLegacy(options.legacy))
  return recordPlan(
    privateBinding(options.stateRoot, options.project, options.owner),
    options.revision,
    options.previous,
    options.snapshot,
    legacy,
    options.compaction,
  )
}

async function readOwnerEntry(path: string, operation: string, revision: number): Promise<string> {
  let before: StatLike
  try {
    before = await lstat(path)
  } catch {
    throw storeError(operation, revision, "file is unreadable")
  }
  assertFile(before, operation, revision)

  let handle
  try {
    handle = await open(path, O_RDONLY | O_NOFOLLOW)
  } catch {
    throw storeError(operation, revision, "file is unreadable")
  }
  try {
    let opened: StatLike
    try {
      opened = await handle.stat()
    } catch {
      throw storeError(operation, revision, "file is unreadable")
    }
    if (opened.ino !== before.ino || opened.dev !== before.dev) {
      throw storeError(operation, revision, "file was substituted while reading")
    }
    assertFile(opened, operation, revision)
    try {
      return await handle.readFile({ encoding: "utf8" })
    } catch {
      throw storeError(operation, revision, "file is unreadable")
    }
  } finally {
    await handle.close()
  }
}

class FileStore implements PrivateStore {
  private readonly binding: StorageBinding
  private readonly stateRoot: string
  private readonly hooks?: Hooks
  private readonly recovery?: RecoveryPlan
  readonly directory: string
  private tail = Promise.resolve()
  private closed = false
  private failedOrder: number | null = null
  private nextOrder = 0
  private highWater: { revision: number; digest: string } | undefined

  constructor(binding: StorageBinding, stateRoot: string, directory: string, hooks?: Hooks, recovery?: RecoveryPlan) {
    this.binding = binding
    this.stateRoot = stateRoot
    this.directory = directory
    this.hooks = hooks
    this.recovery = recovery
  }

  load(): Promise<PrivateHead | undefined> {
    if (this.closed) return Promise.reject(storeError("load", undefined, "closed"))
    const order = ++this.nextOrder
    const result = this.tail.then(async () => {
      try {
        const records = await this.readRecords("load")
        const head = this.verifyRecords(records, "load")
        this.assertHighWater(head, records, "load")
        if (head) this.highWater = { revision: head.revision, digest: head.digest }
        return head
      } catch (error) {
        // A failed load is ordered like any other operation: writes admitted
        // after it must fail closed, while writes admitted before it may finish.
        this.poisonOrder(order)
        throw error
      }
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  append(expected: { revision: number; digest: string | null }, snapshot: CheckpointSnapshot,
    legacy?: LegacySource): Promise<PrivateHead> {
    if (this.closed) return Promise.reject(storeError("append", expected.revision, "closed"))
    if (this.failedOrder !== null) return Promise.reject(storeError("append", expected.revision, "failed"))

    const order = ++this.nextOrder
    const expectedCopy = { revision: expected.revision, digest: expected.digest }
    let captured: CheckpointSnapshot
    let legacyCopy: LegacySource | undefined
    try {
      validateExpected(expectedCopy, "append")
      legacyCopy = legacy === undefined ? undefined : copyLegacy(validateLegacy(legacy))
      captured = cloneCheckpointSnapshot(snapshot, this.binding)
    } catch {
      this.poisonOrder(order)
      return Promise.reject(storeError("append", expected.revision, "value is invalid"))
    }

    const result = this.tail.then(async () => {
      if (this.failedOrder !== null && this.failedOrder < order) {
        throw storeError("append", expectedCopy.revision, "failed")
      }
      try {
        return await this.appendLocked(expectedCopy, captured, legacyCopy)
      } catch (error) {
        this.poisonOrder(order)
        throw error
      }
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  compact(expected: { revision: number; digest: string }, snapshot: CheckpointSnapshot): Promise<PrivateHead> {
    if (this.closed) return Promise.reject(storeError("compact", expected.revision, "closed"))
    if (this.failedOrder !== null) return Promise.reject(storeError("compact", expected.revision, "failed"))

    const order = ++this.nextOrder
    const expectedCopy = { revision: expected.revision, digest: expected.digest }
    let captured: CheckpointSnapshot
    try {
      validateExpected(expectedCopy, "compact")
      if (expectedCopy.digest === null) throw storeError("compact", expectedCopy.revision, "revision digest is invalid")
      captured = cloneCheckpointSnapshot(snapshot, this.binding)
    } catch {
      this.poisonOrder(order)
      return Promise.reject(storeError("compact", expected.revision, "value is invalid"))
    }

    const result = this.tail.then(async () => {
      if (this.failedOrder !== null && this.failedOrder < order) {
        throw storeError("compact", expectedCopy.revision, "failed")
      }
      try {
        return await this.compactLocked(expectedCopy, captured)
      } catch (error) {
        this.poisonOrder(order)
        throw error
      }
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }

  private poisonOrder(order: number): void {
    if (this.failedOrder === null || order < this.failedOrder) this.failedOrder = order
  }

  private async appendLocked(expected: { revision: number; digest: string | null }, snapshot: CheckpointSnapshot,
    legacy?: LegacySource): Promise<PrivateHead> {
    const records = await this.readRecords("append")
    const head = this.verifyRecords(records, "append")
    this.assertHighWater(head, records, "append")
    if ((head?.revision ?? 0) !== expected.revision || (head?.digest ?? null) !== expected.digest) {
      throw storeError("append", expected.revision, "expected revision does not match the committed head")
    }

    let effectiveLegacy: LegacySource | undefined
    if (head) {
      if (head.legacy) {
        if (legacy && !sameLegacy(head.legacy, legacy)) {
          throw storeError("append", expected.revision, "legacy source changed")
        }
        effectiveLegacy = head.legacy
      } else if (legacy) {
        throw storeError("append", expected.revision, "legacy source cannot be introduced after genesis")
      }
      assertRuntimeProofPrefix(head.snapshot.runtimeProof, snapshot.runtimeProof)
    } else {
      effectiveLegacy = legacy
    }

    if (!head && this.recovery) {
      if (!effectiveLegacy || !sameLegacy(effectiveLegacy, this.recovery.legacy)) {
        throw storeError("append", expected.revision, "recovery legacy source does not match the prepared intent")
      }
      const planned = recordPlan(this.binding, 1, null, snapshot, effectiveLegacy, undefined)
      if (planned.digest !== this.recovery.digest) {
        throw storeError("append", expected.revision, "recovery snapshot does not match the prepared intent")
      }
    }
    return this.publish("append", expected.revision + 1, head?.digest ?? null, snapshot, effectiveLegacy)
  }

  private async compactLocked(expected: { revision: number; digest: string }, snapshot: CheckpointSnapshot): Promise<PrivateHead> {
    const records = await this.readRecords("compact")
    const head = this.verifyRecords(records, "compact")
    this.assertHighWater(head, records, "compact")
    if (!head || head.revision !== expected.revision || head.digest !== expected.digest) {
      throw storeError("compact", expected.revision, "expected revision does not match the committed head")
    }
    assertRuntimeProofPrefix(head.snapshot.runtimeProof, snapshot.runtimeProof)

    const revision = head.revision + 1
    const published = await this.publish("compact", revision, head.digest, snapshot, head.legacy,
      { throughRevision: head.revision, throughDigest: head.digest }, async () => {
        await this.hook("base-verified", "compact", revision)
        await this.removeSuperseded(revision, "compact")
        await this.hook("superseded-removed", "compact", revision)
      })
    const verifiedRecords = await this.readRecords("compact")
    const verified = this.verifyRecords(verifiedRecords, "compact")
    this.assertHighWater(verified, verifiedRecords, "compact")
    if (!verified || verified.revision !== published.revision || verified.digest !== published.digest) {
      throw storeError("compact", revision, "compacted base was not completely persisted")
    }
    return verified
  }

  private async publish(operation: string, revision: number, previous: string | null, snapshot: CheckpointSnapshot,
    legacy: LegacySource | undefined, compaction?: { throughRevision: number; throughDigest: string },
    afterVerified?: () => Promise<void>): Promise<PrivateHead> {
    const finalName = revisionName(operation, revision)
    const finalPath = join(this.directory, finalName)
    if (await this.exists(finalPath, operation, revision)) {
      throw storeError(operation, revision, "destination revision already exists")
    }

    const plan = recordPlan(this.binding, revision, previous, snapshot, legacy, compaction)
    const { digest, payload } = plan
    const envelope = JSON.stringify({ payload, digest })

    await this.ensureOwnerChain(operation, revision)
    const pendingName = `.pending-${String(revision).padStart(REVISION_WIDTH, "0")}-${randomUUID()}`
    const pendingPath = join(this.directory, pendingName)

    let handle
    try {
      handle = await open(pendingPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    } catch {
      throw storeError(operation, revision, "pending file could not be created")
    }

    let handleClosed = false
    try {
      try {
        await handle.chmod(0o600)
      } catch {
        throw storeError(operation, revision, "pending file permissions could not be set")
      }
      await this.hook("opened", operation, revision)
      try {
        await handle.writeFile(envelope, "utf8")
      } catch {
        throw storeError(operation, revision, "pending file could not be written")
      }
      await this.hook("written", operation, revision)
      try {
        await handle.sync()
      } catch {
        throw storeError(operation, revision, "pending file could not be synced")
      }
      await this.hook("file-synced", operation, revision)
      try {
        await handle.close()
      } catch {
        throw storeError(operation, revision, "pending file could not be closed")
      }
      handleClosed = true
      await this.hook("closed", operation, revision)
    } finally {
      if (!handleClosed) {
        try {
          await handle.close()
        } catch {
          // The original publication failure remains authoritative.
        }
      }
    }

    if (await this.exists(finalPath, operation, revision)) {
      throw storeError(operation, revision, "destination revision already exists")
    }
    try {
      await rename(pendingPath, finalPath)
    } catch {
      throw storeError(operation, revision, "pending file could not be renamed")
    }
    await this.hook("renamed", operation, revision)

    const afterRename = await lstat(finalPath)
    assertFile(afterRename, operation, revision)
    await syncDirectory(this.directory, operation, revision)
    if (previous === null) await syncDirectory(privateStoreRoot(this.stateRoot), operation, revision)
    await this.hook("directory-synced", operation, revision)

    const verifiedRecords = await this.readRecords(operation)
    const verified = this.verifyRecords(verifiedRecords, operation)
    this.assertHighWater(verified, verifiedRecords, operation)
    if (!verified || verified.revision !== revision || verified.digest !== digest
      || JSON.stringify(verified.snapshot) !== JSON.stringify(snapshot)) {
      throw storeError(operation, revision, "published revision did not verify")
    }

    this.highWater = { revision, digest }
    await this.hook("verified", operation, revision)
    if (afterVerified) await afterVerified()
    return verified
  }

  private async removeSuperseded(revision: number, operation: string): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    const removals: { revision: number; name: string }[] = []
    for (const entry of entries) {
      if (PENDING_PATTERN.test(entry.name)) continue
      const match = FINAL_PATTERN.exec(entry.name)
      if (!match) throw storeError(operation, revision, "filename is invalid")
      const entryRevision = Number(match[1])
      if (!Number.isSafeInteger(entryRevision) || entryRevision < 1) {
        throw storeError(operation, revision, "filename is invalid")
      }
      if (entryRevision < revision) removals.push({ revision: entryRevision, name: entry.name })
    }
    removals.sort((left, right) => right.revision - left.revision)
    for (const entry of removals) {
      try {
        await unlink(join(this.directory, entry.name))
      } catch {
        throw storeError(operation, entry.revision, "superseded revision could not be removed")
      }
    }
    await syncDirectory(this.directory, operation, revision)
  }

  private async readRecords(operation: string): Promise<ParsedRecord[] | undefined> {
    if (!(await this.inspectChain(operation))) return undefined
    let ownerStats: StatLike
    try {
      ownerStats = await lstat(this.directory)
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined
      throw storeError(operation, undefined, "owner directory is unreadable")
    }
    assertDirectory(ownerStats, operation)

    let entries
    try {
      entries = await readdir(this.directory, { withFileTypes: true })
    } catch {
      throw storeError(operation, undefined, "owner directory is unreadable")
    }

    const files: { revision: number; path: string }[] = []
    const pendingRevisions: number[] = []
    const seen = new Set<number>()
    for (const entry of entries) {
      if (PENDING_PATTERN.test(entry.name)) {
        const match = PENDING_PATTERN.exec(entry.name)!
        const pendingRevision = Number(match[1])
        if (!Number.isSafeInteger(pendingRevision) || pendingRevision < 1) {
          throw storeError(operation, undefined, "pending filename is invalid")
        }
        const path = join(this.directory, entry.name)
        let stats: StatLike
        try {
          stats = await lstat(path)
        } catch {
          throw storeError(operation, pendingRevision, "pending file is unreadable")
        }
        assertFile(stats, operation, pendingRevision)
        pendingRevisions.push(pendingRevision)
        continue
      }
      const match = FINAL_PATTERN.exec(entry.name)
      if (!match) throw storeError(operation, undefined, "filename is invalid")
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw storeError(operation, undefined, "filename is invalid")
      }
      if (seen.has(revision)) throw storeError(operation, revision, "revision is duplicated")
      seen.add(revision)
      files.push({ revision, path: join(this.directory, entry.name) })
    }
    files.sort((left, right) => left.revision - right.revision)
    if (this.recovery && files.length === 0 && pendingRevisions.some((revision) => revision !== 1)) {
      throw storeError(operation, undefined, "pending revision is not the interrupted genesis revision")
    }

    const records: ParsedRecord[] = []
    for (const file of files) {
      const text = await readOwnerEntry(file.path, operation, file.revision)
      records.push(this.parseRecord(text, file.revision, operation))
    }
    return records
  }

  private parseRecord(text: string, fileRevision: number, operation: string): ParsedRecord {
    let envelope: unknown
    try {
      envelope = JSON.parse(text) as unknown
    } catch {
      throw storeError(operation, fileRevision, "committed revision is not valid JSON")
    }
    if (!isPlainObject(envelope) || !hasExactKeys(envelope, ["payload", "digest"])
      || typeof envelope.payload !== "string" || typeof envelope.digest !== "string"
      || !DIGEST_PATTERN.test(envelope.digest) || envelope.digest !== sha256(envelope.payload)) {
      throw storeError(operation, fileRevision, "record envelope or digest is invalid")
    }

    let payload: unknown
    try {
      payload = JSON.parse(envelope.payload) as unknown
    } catch {
      throw storeError(operation, fileRevision, "record payload is not valid JSON")
    }
    if (!isPlainObject(payload) || !hasExactKeys(payload,
      ["kind", "version", "binding", "revision", "previous", "compaction", "legacy", "state"],
      ["runtimeProof", "legacyOutboxIDs"])
      || payload.kind !== KIND || payload.version !== VERSION) {
      throw storeError(operation, fileRevision, "record envelope is invalid")
    }
    validateBinding(payload.binding, this.binding, operation, fileRevision)
    if (!Number.isSafeInteger(payload.revision) || (payload.revision as number) < 1) {
      throw storeError(operation, fileRevision, "revision is invalid")
    }
    const revision = payload.revision as number
    if (revision !== fileRevision) {
      throw storeError(operation, fileRevision, "duplicate or mismatched revision")
    }
    if (!(payload.previous === null || typeof payload.previous === "string" && DIGEST_PATTERN.test(payload.previous))) {
      throw storeError(operation, revision, "predecessor digest is invalid")
    }

    const compaction = parseCompaction(payload.compaction, operation, revision)
    if (compaction && (revision !== compaction.throughRevision + 1 || payload.previous !== compaction.throughDigest)) {
      throw storeError(operation, revision, "compaction predecessor is invalid")
    }
    const legacy = parseLegacy(payload.legacy, operation, revision)
    const state = parseConversationState(payload.state)
    if (state.discussions.some((discussion) => discussion.owner.sessionID !== this.binding.owner
      || discussion.owner.agent !== this.binding.agent
      || resolve(discussion.owner.directory) !== this.binding.directory)) {
      throw storeError(operation, revision, "state contains a foreign discussion owner")
    }
    const runtimeProof = parseRuntimeJournal(payload.runtimeProof, state, this.binding)
    const legacyOutboxIDs = this.parseLegacyOutboxIDs(payload.legacyOutboxIDs, operation, revision)

    return {
      revision,
      digest: envelope.digest,
      previous: payload.previous as string | null,
      ...(compaction === undefined ? {} : { compaction }),
      ...(legacy === undefined ? {} : { legacy }),
      snapshot: {
        state,
        ...(runtimeProof === undefined ? {} : { runtimeProof }),
        ...(legacyOutboxIDs === undefined ? {} : { legacyOutboxIDs }),
      },
    }
  }

  private parseLegacyOutboxIDs(value: unknown, operation: string, revision: number): readonly string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw storeError(operation, revision, "legacy outbox IDs are invalid")
    const seen = new Set<string>()
    for (const item of value) {
      if (!nonEmptyString(item) || seen.has(item)) {
        throw storeError(operation, revision, "legacy outbox IDs are invalid")
      }
      seen.add(item)
    }
    return [...value]
  }

  private verifyRecords(records: ParsedRecord[] | undefined, operation: string): PrivateHead | undefined {
    if (records === undefined) return undefined
    if (records.length === 0) {
      if (this.recovery) return undefined
      throw storeError(operation, undefined, "existing owner directory has no committed revisions")
    }
    const byRevision = new Map<number, ParsedRecord>()
    for (const record of records) {
      if (byRevision.has(record.revision)) throw storeError(operation, record.revision, "revision is duplicated")
      byRevision.set(record.revision, record)
    }
    const highest = records[records.length - 1].revision
    const base = [...records].reverse().find((record) => record.compaction !== undefined)

    if (base) {
      const compaction = base.compaction!
      const through = byRevision.get(compaction.throughRevision)
      if (through && through.digest !== compaction.throughDigest) {
        throw storeError(operation, base.revision, "compaction base digest is invalid")
      }
      if (through) {
        assertRuntimeProofPrefix(through.snapshot.runtimeProof, base.snapshot.runtimeProof)
        if (!sameLegacy(through.legacy, base.legacy)) {
          throw storeError(operation, base.revision, "legacy source changed across compaction")
        }
      }

      let prior: ParsedRecord | undefined
      for (let revision = 1; revision < base.revision; revision += 1) {
        const record = byRevision.get(revision)
        if (!record) {
          prior = undefined
          continue
        }
        if (record.previous === null) {
          if (revision !== 1) throw storeError(operation, revision, "predecessor digest is invalid")
        } else if (prior && record.previous !== prior.digest) {
          throw storeError(operation, revision, "duplicate or conflicting predecessor")
        }
        if (prior) {
          assertRuntimeProofPrefix(prior.snapshot.runtimeProof, record.snapshot.runtimeProof)
          if (!sameLegacy(prior.legacy, record.legacy)) {
            throw storeError(operation, revision, "legacy source changed")
          }
        }
        prior = record
      }

      let previous = base.digest
      let proof: RuntimeJournal | undefined = base.snapshot.runtimeProof
      let legacy = base.legacy
      for (let revision = base.revision + 1; revision <= highest; revision += 1) {
        const record = byRevision.get(revision)
        if (!record) throw storeError(operation, revision, "revision is missing")
        if (record.previous !== previous) throw storeError(operation, revision, "predecessor digest is invalid")
        assertRuntimeProofPrefix(proof, record.snapshot.runtimeProof)
        if (!sameLegacy(legacy, record.legacy)) throw storeError(operation, revision, "legacy source changed")
        previous = record.digest
        proof = record.snapshot.runtimeProof
        legacy = record.legacy
      }
    } else {
      let previous: string | null = null
      let proof: RuntimeJournal | undefined
      let legacy: LegacySource | undefined
      for (let revision = 1; revision <= highest; revision += 1) {
        const record = byRevision.get(revision)
        if (!record) throw storeError(operation, revision, "revision is missing")
        if (record.previous !== previous) throw storeError(operation, revision, "predecessor digest is invalid")
        assertRuntimeProofPrefix(proof, record.snapshot.runtimeProof)
        // A migration import may introduce the legacy source at genesis, but
        // every later append must carry it unchanged.
        if (revision > 1 && !sameLegacy(legacy, record.legacy)) {
          throw storeError(operation, revision, "legacy source changed")
        }
        previous = record.digest
        proof = record.snapshot.runtimeProof
        legacy = record.legacy
      }
    }

    const head = byRevision.get(highest)!
    return {
      revision: head.revision,
      digest: head.digest,
      snapshot: head.snapshot,
      ...(head.legacy === undefined ? {} : { legacy: head.legacy }),
      ...(head.compaction === undefined ? {} : { compaction: head.compaction }),
    }
  }

  private assertHighWater(head: PrivateHead | undefined, records: ParsedRecord[] | undefined, operation: string): void {
    if (!this.highWater) return
    const observedRecords = records ?? []
    const highWater = this.highWater
    if (!head || head.revision < highWater.revision) {
      throw storeError(operation, highWater.revision, "high-water revision was lost")
    }
    if (head.revision === highWater.revision && head.digest !== highWater.digest) {
      throw storeError(operation, highWater.revision, "high-water revision digest changed")
    }
    const observed = observedRecords.find((record) => record.revision === highWater.revision)
    if (observed) {
      if (observed.digest !== highWater.digest) {
        throw storeError(operation, highWater.revision, "high-water revision digest changed")
      }
      return
    }
    if (head.revision > highWater.revision) {
      const base = [...observedRecords].reverse().find((record) => record.compaction !== undefined)
      if (base && base.compaction!.throughRevision === highWater.revision
        && base.compaction!.throughDigest !== highWater.digest) {
        throw storeError(operation, highWater.revision, "high-water revision digest changed")
      }
    }
  }

  private async inspectChain(operation: string): Promise<boolean> {
    let current = resolve(this.stateRoot)
    for (const component of ROOT_COMPONENTS) {
      const next = join(current, component)
      let stats: StatLike
      try {
        stats = await lstat(next)
      } catch (error) {
        if (codeOf(error) === "ENOENT") return false
        throw storeError(operation, undefined, "directory is unreadable")
      }
      assertDirectory(stats, operation)
      current = next
    }
    return true
  }

  private async ensureOwnerChain(operation: string, revision: number): Promise<void> {
    let current = resolve(this.stateRoot)
    for (const component of ROOT_COMPONENTS) {
      const next = join(current, component)
      let stats: StatLike | undefined
      let created = false
      try {
        stats = await lstat(next)
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw storeError(operation, revision, "directory is unreadable")
        try {
          await mkdir(next, { mode: 0o700 })
          created = true
        } catch (createError) {
          if (codeOf(createError) !== "EEXIST") {
            throw storeError(operation, revision, "directory could not be created")
          }
        }
        try {
          if (created) await chmod(next, 0o700)
          stats = await lstat(next)
        } catch {
          throw storeError(operation, revision, "directory could not be verified")
        }
        assertDirectory(stats, operation, revision)
        await syncDirectory(current, operation, revision)
      }
      assertDirectory(stats, operation, revision)
      current = next
    }

    let ownerStats: StatLike | undefined
    let created = false
    try {
      ownerStats = await lstat(this.directory)
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw storeError(operation, revision, "owner directory is unreadable")
      try {
        await mkdir(this.directory, { mode: 0o700 })
        created = true
      } catch (createError) {
        if (codeOf(createError) !== "EEXIST") {
          throw storeError(operation, revision, "owner directory could not be created")
        }
      }
      try {
        if (created) await chmod(this.directory, 0o700)
        ownerStats = await lstat(this.directory)
      } catch {
        throw storeError(operation, revision, "owner directory could not be verified")
      }
      assertDirectory(ownerStats, operation, revision)
      await syncDirectory(current, operation, revision)
    }
    assertDirectory(ownerStats, operation, revision)
  }

  private async exists(path: string, operation: string, revision: number): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false
      throw storeError(operation, revision, "destination is unreadable")
    }
  }

  private async hook(point: StoreBoundary, operation: string, revision: number): Promise<void> {
    const boundary = this.hooks?.boundary
    if (typeof boundary !== "function") return
    try {
      await boundary.call(this.hooks, point)
    } catch {
      throw storeError(operation, revision, `boundary ${point} failed`)
    }
  }
}

const BOUNDARY_DIRECTORY = "migrations"
const BOUNDARY_KEYS = ["kind", "version", "state", "project", "directory", "owner", "agent", "source", "private", "token"] as const
const BOUNDARY_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u
const BOUNDARY_PENDING_PATTERN = /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

async function assertBoundaryEntries(
  directory: string,
  entries: readonly string[],
  target: string,
  operation: string,
): Promise<void> {
  for (const entry of entries) {
    if (entry === target || BOUNDARY_FILE_PATTERN.test(entry)) continue
    if (!BOUNDARY_PENDING_PATTERN.test(entry)) {
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory contains an unknown entry`)
    }
    let stats: StatLike
    try {
      stats = await lstat(join(directory, entry))
    } catch {
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: pending boundary is unreadable`)
    }
    // An interrupted atomic write may leave a partial regular file, but never a
    // symlink, directory, foreign owner or multiply linked file. The contents are
    // intentionally not read: the pending name is not committed boundary state.
    assertBoundaryFile(stats, operation)
  }
}

function assertBoundaryDirectory(stats: StatLike, operation: string): void {
  try {
    assertDirectory(stats, operation)
  } catch (error) {
    throw new PrivateStoreError(error instanceof Error ? error.message : "migration boundary directory is invalid")
  }
}

function assertBoundaryFile(stats: StatLike, operation: string): void {
  try {
    assertFile(stats, operation)
  } catch (error) {
    throw new PrivateStoreError(error instanceof Error ? error.message : "migration boundary file is invalid")
  }
}

function parseBoundary(value: unknown, expected?: { project: string; owner: Owner }): MigrationBoundary {
  if (!isPlainObject(value) || !hasExactKeys(value, BOUNDARY_KEYS)
    || value.kind !== "opencode-debate-migration-boundary" || value.version !== 1
    || !["prepared", "committed", "retiring", "retired"].includes(String(value.state))
    || !nonEmptyString(value.project) || !nonEmptyString(value.directory)
    || !nonEmptyString(value.owner) || !nonEmptyString(value.agent)
    || !isPlainObject(value.private) || !hasExactKeys(value.private, ["revision", "digest"])
    || !Number.isSafeInteger(value.private.revision) || (value.private.revision as number) < 1
    || typeof value.private.digest !== "string" || !DIGEST_PATTERN.test(value.private.digest)
    || typeof value.token !== "string" || !DIGEST_PATTERN.test(value.token)) {
    throw new PrivateStoreError("Automatic-debate migration boundary is invalid")
  }
  let source: LegacySource
  try {
    source = validateLegacy(value.source)
  } catch {
    throw new PrivateStoreError("Automatic-debate migration boundary source is invalid")
  }
  const directory = resolve(value.directory)
  if (expected && (value.project !== expected.project || value.owner !== expected.owner.sessionID
    || value.agent !== expected.owner.agent || directory !== resolve(expected.owner.directory))) {
    throw new PrivateStoreError("Automatic-debate migration boundary binding is invalid")
  }
  return {
    kind: "opencode-debate-migration-boundary",
    version: 1,
    state: value.state as MigrationBoundary["state"],
    project: value.project,
    directory,
    owner: value.owner,
    agent: value.agent,
    source,
    private: { revision: value.private.revision as number, digest: value.private.digest },
    token: value.token,
  }
}

export function migrationBoundaryPath(stateRoot: string, project: string, owner: Owner): string {
  return join(privateStoreRoot(stateRoot), BOUNDARY_DIRECTORY, `${privateOwnerKey(project, owner)}.json`)
}

export async function readMigrationBoundary(
  stateRoot: string,
  project: string,
  owner: Owner,
): Promise<MigrationBoundary | undefined> {
  const operation = "migration boundary read"
  let current = resolve(stateRoot)
  for (const component of ROOT_COMPONENTS) {
    const next = join(current, component)
    let stats: StatLike
    try {
      stats = await lstat(next)
    } catch (error) {
      if (codeOf(error) === "ENOENT") return undefined
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: plugin path is unreadable`)
    }
    assertBoundaryDirectory(stats, operation)
    current = next
  }

  const directory = join(current, BOUNDARY_DIRECTORY)
  let directoryStats: StatLike
  try {
    directoryStats = await lstat(directory)
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined
    throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory is unreadable`)
  }
  assertBoundaryDirectory(directoryStats, operation)

  const name = `${privateOwnerKey(project, owner)}.json`
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory is unreadable`)
  }
  await assertBoundaryEntries(directory, entries, name, operation)
  if (!entries.includes(name)) return undefined

  let text: string
  try {
    text = await readOwnerEntry(join(directory, name), operation, 1)
  } catch (error) {
    throw new PrivateStoreError(error instanceof Error ? error.message : "migration boundary is unreadable")
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(text) as unknown
  } catch {
    throw new PrivateStoreError("Automatic-debate migration boundary is invalid")
  }
  if (!isPlainObject(envelope) || !hasExactKeys(envelope, ["payload", "digest"])
    || typeof envelope.payload !== "string" || typeof envelope.digest !== "string"
    || !DIGEST_PATTERN.test(envelope.digest) || envelope.digest !== sha256(envelope.payload)) {
    throw new PrivateStoreError("Automatic-debate migration boundary envelope or digest is invalid")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(envelope.payload) as unknown
  } catch {
    throw new PrivateStoreError("Automatic-debate migration boundary payload is invalid")
  }
  return parseBoundary(parsed, { project, owner })
}

async function ensureBoundaryDirectory(stateRoot: string, operation: string): Promise<string> {
  let current = resolve(stateRoot)
  for (const component of ROOT_COMPONENTS) {
    const next = join(current, component)
    let stats: StatLike | undefined
    let created = false
    try {
      stats = await lstat(next)
    } catch (error) {
      if (codeOf(error) !== "ENOENT") {
        throw new PrivateStoreError(`Automatic-debate private store ${operation}: plugin path is unreadable`)
      }
      try {
        await mkdir(next, { mode: 0o700 })
        created = true
      } catch (createError) {
        if (codeOf(createError) !== "EEXIST") {
          throw new PrivateStoreError(`Automatic-debate private store ${operation}: plugin path could not be created`)
        }
      }
      try {
        if (created) await chmod(next, 0o700)
        stats = await lstat(next)
      } catch {
        throw new PrivateStoreError(`Automatic-debate private store ${operation}: plugin path could not be verified`)
      }
      assertBoundaryDirectory(stats, operation)
      await syncDirectory(current, operation)
    }
    assertBoundaryDirectory(stats, operation)
    current = next
  }

  const directory = join(current, BOUNDARY_DIRECTORY)
  let stats: StatLike | undefined
  let created = false
  try {
    stats = await lstat(directory)
  } catch (error) {
    if (codeOf(error) !== "ENOENT") {
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory is unreadable`)
    }
    try {
      await mkdir(directory, { mode: 0o700 })
      created = true
    } catch (createError) {
      if (codeOf(createError) !== "EEXIST") {
        throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory could not be created`)
      }
    }
    try {
      if (created) await chmod(directory, 0o700)
      stats = await lstat(directory)
    } catch {
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory could not be verified`)
    }
    assertBoundaryDirectory(stats, operation)
    await syncDirectory(current, operation)
  }
  assertBoundaryDirectory(stats, operation)
  return directory
}

export async function writeMigrationBoundary(stateRoot: string, boundary: MigrationBoundary): Promise<void> {
  const operation = "migration boundary write"
  const normalized = parseBoundary(boundary)
  const directory = await ensureBoundaryDirectory(stateRoot, operation)
  const name = `${privateOwnerKey(normalized.project, {
    sessionID: normalized.owner,
    agent: normalized.agent,
    directory: normalized.directory,
  })}.json`
  const finalPath = join(directory, name)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    throw new PrivateStoreError(`Automatic-debate private store ${operation}: migration directory is unreadable`)
  }
  await assertBoundaryEntries(directory, entries, name, operation)

  const payload = JSON.stringify(normalized)
  const envelope = JSON.stringify({ payload, digest: sha256(payload) })
  const pendingPath = join(directory, `.pending-${randomUUID()}`)
  let handle
  try {
    handle = await open(pendingPath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  } catch {
    throw new PrivateStoreError(`Automatic-debate private store ${operation}: pending file could not be created`)
  }
  let published = false
  try {
    try {
      await handle.chmod(0o600)
      await handle.writeFile(envelope, "utf8")
      await handle.sync()
      await handle.close()
    } catch {
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: pending file could not be written`)
    }
    try {
      await rename(pendingPath, finalPath)
      published = true
    } catch {
      throw new PrivateStoreError(`Automatic-debate private store ${operation}: pending file could not be renamed`)
    }
    await syncDirectory(directory, operation)
  } catch (error) {
    if (!published) {
      try { await unlink(pendingPath) } catch { /* The durable failure evidence remains authoritative. */ }
    }
    throw error
  } finally {
    try { await handle.close() } catch { /* Already closed or failed before publication. */ }
  }

  const readBack = await readMigrationBoundary(stateRoot, normalized.project, {
    sessionID: normalized.owner,
    agent: normalized.agent,
    directory: normalized.directory,
  })
  if (!readBack || JSON.stringify(readBack) !== JSON.stringify(normalized)) {
    throw new PrivateStoreError(`Automatic-debate private store ${operation}: boundary did not verify`)
  }
}

export async function openPrivateStore(options: Options): Promise<PrivateStore> {
  if (process.platform !== "linux") {
    throw new Error(`Automatic-debate private storage is unsupported on ${process.platform}`)
  }
  const project = options.project
  const owner = options.owner
  if (!nonEmptyString(project) || !nonEmptyString(owner.sessionID) || !nonEmptyString(owner.agent)
    || !nonEmptyString(owner.directory)) {
    throw new Error("Automatic-debate private store binding is invalid")
  }
  const stateRoot = resolve(options.stateRoot)
  const binding: StorageBinding = {
    kind: "opencode-debate-storage",
    version: 1,
    project,
    directory: resolve(owner.directory),
    owner: owner.sessionID,
    agent: owner.agent,
  }
  let recovery: RecoveryPlan | undefined
  if (options.recovery) {
    if (options.recovery.revision !== 1 || typeof options.recovery.digest !== "string"
      || !DIGEST_PATTERN.test(options.recovery.digest)) {
      throw new Error("Automatic-debate interrupted genesis recovery intent is invalid")
    }
    const legacy = copyLegacy(validateLegacy(options.recovery.legacy))
    const planned = recordPlan(binding, 1, null, options.recovery.snapshot, legacy, undefined)
    if (planned.digest !== options.recovery.digest) {
      throw new Error("Automatic-debate interrupted genesis recovery digest does not match its binding and snapshot")
    }
    recovery = { ...planned, legacy }
  }
  return new FileStore(
    binding,
    stateRoot,
    join(privateStoreRoot(stateRoot), privateOwnerKey(project, owner)),
    options.hooks,
    recovery,
  )
}

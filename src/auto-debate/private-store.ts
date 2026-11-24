import { createHash, randomUUID } from "node:crypto"
import { O_CREAT, O_EXCL, O_NOFOLLOW, O_RDONLY, O_WRONLY } from "node:constants"
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import type {
  CheckpointSnapshot,
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
  compaction?: { throughRevision: number; throughDigest: string }
}

export interface PrivateStore {
  readonly directory: string
  load(): Promise<PrivateHead | undefined>
  append(expected: { revision: number; digest: string | null }, snapshot: CheckpointSnapshot): Promise<PrivateHead>
  compact(expected: { revision: number; digest: string }, snapshot: CheckpointSnapshot): Promise<PrivateHead>
  close(): Promise<void>
}

type Hooks = { boundary?: (point: StoreBoundary) => Promise<void> }
type Options = { stateRoot: string; project: string; owner: Owner; hooks?: Hooks }
type ParsedRecord = {
  revision: number
  digest: string
  previous: string | null
  compaction?: { throughRevision: number; throughDigest: string }
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
const ROOT_COMPONENTS = ["opencode-debate"] as const
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
    state: captured.state,
    ...(captured.runtimeProof === undefined ? {} : { runtimeProof: captured.runtimeProof }),
    ...(captured.legacyOutboxIDs === undefined ? {} : { legacyOutboxIDs: captured.legacyOutboxIDs }),
  })
  return { snapshot: captured, payload, digest: sha256(payload) }
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
  readonly directory: string
  private tail = Promise.resolve()
  private closed = false
  private failedOrder: number | null = null
  private nextOrder = 0
  private highWater: { revision: number; digest: string } | undefined

  constructor(binding: StorageBinding, stateRoot: string, directory: string, hooks?: Hooks) {
    this.binding = binding
    this.stateRoot = stateRoot
    this.directory = directory
    this.hooks = hooks
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

  append(expected: { revision: number; digest: string | null }, snapshot: CheckpointSnapshot): Promise<PrivateHead> {
    if (this.closed) return Promise.reject(storeError("append", expected.revision, "closed"))
    if (this.failedOrder !== null) return Promise.reject(storeError("append", expected.revision, "failed"))

    const order = ++this.nextOrder
    const expectedCopy = { revision: expected.revision, digest: expected.digest }
    let captured: CheckpointSnapshot
    try {
      validateExpected(expectedCopy, "append")
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
        return await this.appendLocked(expectedCopy, captured)
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

  private async appendLocked(expected: { revision: number; digest: string | null }, snapshot: CheckpointSnapshot): Promise<PrivateHead> {
    const records = await this.readRecords("append")
    const head = this.verifyRecords(records, "append")
    this.assertHighWater(head, records, "append")
    if ((head?.revision ?? 0) !== expected.revision || (head?.digest ?? null) !== expected.digest) {
      throw storeError("append", expected.revision, "expected revision does not match the committed head")
    }

    if (head) {
      assertRuntimeProofPrefix(head.snapshot.runtimeProof, snapshot.runtimeProof)
    }
    return this.publish("append", expected.revision + 1, head?.digest ?? null, snapshot)
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
    const published = await this.publish("compact", revision, head.digest, snapshot,
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
    compaction?: { throughRevision: number; throughDigest: string },
    afterVerified?: () => Promise<void>): Promise<PrivateHead> {
    const finalName = revisionName(operation, revision)
    const finalPath = join(this.directory, finalName)
    if (await this.exists(finalPath, operation, revision)) {
      throw storeError(operation, revision, "destination revision already exists")
    }

    const plan = recordPlan(this.binding, revision, previous, snapshot, compaction)
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
      ["kind", "version", "binding", "revision", "previous", "compaction", "state"],
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
        }
        prior = record
      }

      let previous = base.digest
      let proof: RuntimeJournal | undefined = base.snapshot.runtimeProof
      for (let revision = base.revision + 1; revision <= highest; revision += 1) {
        const record = byRevision.get(revision)
        if (!record) throw storeError(operation, revision, "revision is missing")
        if (record.previous !== previous) throw storeError(operation, revision, "predecessor digest is invalid")
        assertRuntimeProofPrefix(proof, record.snapshot.runtimeProof)
        previous = record.digest
        proof = record.snapshot.runtimeProof
      }
    } else {
      let previous: string | null = null
      let proof: RuntimeJournal | undefined
      for (let revision = 1; revision <= highest; revision += 1) {
        const record = byRevision.get(revision)
        if (!record) throw storeError(operation, revision, "revision is missing")
        if (record.previous !== previous) throw storeError(operation, revision, "predecessor digest is invalid")
        assertRuntimeProofPrefix(proof, record.snapshot.runtimeProof)
        previous = record.digest
        proof = record.snapshot.runtimeProof
      }
    }

    const head = byRevision.get(highest)!
    return {
      revision: head.revision,
      digest: head.digest,
      snapshot: head.snapshot,
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
  return new FileStore(
    binding,
    stateRoot,
    join(privateStoreRoot(stateRoot), privateOwnerKey(project, owner)),
    options.hooks,
  )
}

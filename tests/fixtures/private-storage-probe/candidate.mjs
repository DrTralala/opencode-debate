import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** @typedef {{project: string, directory: string, owner: string, agent: string}} Binding */
/** @typedef {{revision: number, digest: string, value: unknown}} Head */
/** @typedef {'opened'|'written'|'file-synced'|'closed'|'renamed'|'directory-synced'|'verified'|'acknowledged'} Boundary */
/** @typedef {{boundary?: (point: Boundary) => Promise<void>}} Hooks */

const KIND = 'checkpoint-probe'
const VERSION = 1
const PENDING_PREFIX = '.pending-'
const FINAL_PATTERN = /^(\d{16})\.json$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const REVISION_WIDTH = 16

class CandidateError extends Error {
  constructor(operation, revision, category) {
    const label =
      revision === undefined || revision === null
        ? operation
        : `${operation} revision ${revision}`
    super(`${label}: ${category}`)
    this.name = 'CandidateError'
    this.operation = operation
    this.revision = revision ?? null
    this.category = category
  }
}

function fail(operation, revision, category) {
  return new CandidateError(operation, revision, category)
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()

  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function normalizeBinding(binding) {
  const fields = ['project', 'directory', 'owner', 'agent']

  if (!isPlainObject(binding) || !hasExactKeys(binding, fields)) {
    throw fail('create', undefined, 'binding')
  }

  for (const field of fields) {
    if (typeof binding[field] !== 'string') {
      throw fail('create', undefined, 'binding')
    }
  }

  return {
    project: binding.project,
    directory: binding.directory,
    owner: binding.owner,
    agent: binding.agent,
  }
}

function deriveKey(binding) {
  return sha256(
    JSON.stringify([
      binding.project,
      resolve(binding.directory),
      binding.owner,
    ]),
  )
}

function revisionFileName(operation, revision) {
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw fail(operation, revision, 'revision')
  }

  return `${String(revision).padStart(REVISION_WIDTH, '0')}.json`
}

function cloneJsonValue(value, stack = new WeakSet()) {
  if (value === null) {
    return null
  }

  const type = typeof value
  if (type === 'string' || type === 'boolean') {
    return value
  }

  if (type === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError('not JSON-compatible')
    }
    return value
  }

  if (type !== 'object' || stack.has(value)) {
    throw new TypeError('not JSON-compatible')
  }

  stack.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('not JSON-compatible')
      }

      const keys = Object.keys(value)
      if (keys.length !== value.length) {
        throw new TypeError('not JSON-compatible')
      }

      const copy = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index)
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('not JSON-compatible')
        }
        copy.push(cloneJsonValue(descriptor.value, stack))
      }
      return copy
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('not JSON-compatible')
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('not JSON-compatible')
    }

    const copy = {}
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('not JSON-compatible')
      }

      Object.defineProperty(copy, key, {
        value: cloneJsonValue(descriptor.value, stack),
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

function createEnvelope(binding, revision, previous, value) {
  const payload = JSON.stringify({
    kind: KIND,
    version: VERSION,
    binding,
    revision,
    previous,
    value,
  })
  const digest = sha256(payload)
  const envelope = JSON.stringify({ payload, digest })

  return { envelope, digest }
}

function parseEnvelope(
  text,
  operation,
  fileRevision,
  previousRevision,
  expectedPrevious,
  expectedBinding,
) {
  let envelope
  try {
    envelope = JSON.parse(text)
  } catch {
    throw fail(operation, fileRevision, 'json')
  }

  if (
    !isPlainObject(envelope) ||
    !hasExactKeys(envelope, ['payload', 'digest']) ||
    typeof envelope.payload !== 'string' ||
    typeof envelope.digest !== 'string'
  ) {
    throw fail(operation, fileRevision, 'envelope')
  }

  if (
    !DIGEST_PATTERN.test(envelope.digest) ||
    envelope.digest !== sha256(envelope.payload)
  ) {
    throw fail(operation, fileRevision, 'digest')
  }

  let payload
  try {
    payload = JSON.parse(envelope.payload)
  } catch {
    throw fail(operation, fileRevision, 'json')
  }

  if (
    !isPlainObject(payload) ||
    !hasExactKeys(payload, [
      'kind',
      'version',
      'binding',
      'revision',
      'previous',
      'value',
    ]) ||
    payload.kind !== KIND ||
    payload.version !== VERSION
  ) {
    throw fail(operation, fileRevision, 'envelope')
  }

  if (
    !isPlainObject(payload.binding) ||
    !hasExactKeys(payload.binding, ['project', 'directory', 'owner', 'agent'])
  ) {
    throw fail(operation, fileRevision, 'binding')
  }

  for (const field of ['project', 'directory', 'owner', 'agent']) {
    if (
      typeof payload.binding[field] !== 'string' ||
      payload.binding[field] !== expectedBinding[field]
    ) {
      throw fail(operation, fileRevision, 'binding')
    }
  }

  if (!Number.isSafeInteger(payload.revision) || payload.revision <= 0) {
    throw fail(operation, fileRevision, 'revision')
  }

  if (payload.revision !== fileRevision) {
    const category =
      payload.revision <= previousRevision ? 'duplicate-revision' : 'revision'
    throw fail(operation, fileRevision, category)
  }

  if (payload.previous === null) {
    if (fileRevision !== 1) {
      throw fail(operation, fileRevision, 'previous')
    }
  } else if (
    typeof payload.previous !== 'string' ||
    !DIGEST_PATTERN.test(payload.previous) ||
    payload.previous !== expectedPrevious
  ) {
    throw fail(operation, fileRevision, 'previous')
  }

  return {
    revision: payload.revision,
    digest: envelope.digest,
    value: payload.value,
  }
}

async function syncDirectory(directory, operation, revision) {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    throw fail(operation, revision, 'directory-sync')
  }
}

class Candidate {
  #root
  #binding
  #ownerDirectory
  #hooks
  #tail = Promise.resolve()
  #closed = false
  #nextOrder = 0
  #failedOrder = null

  constructor(root, binding, ownerDirectory, hooks) {
    this.#root = root
    this.#binding = binding
    this.#ownerDirectory = ownerDirectory
    this.#hooks = hooks
  }

  async load() {
    if (this.#closed) {
      throw fail('load', undefined, 'closed')
    }

    await this.#tail

    try {
      return await this.#readChain('load')
    } catch (error) {
      if (error instanceof CandidateError) {
        throw error
      }
      throw fail('load', undefined, 'failed')
    }
  }

  append(expectedRevision, value) {
    if (this.#closed) {
      return Promise.reject(fail('append', expectedRevision, 'closed'))
    }

    if (this.#failedOrder !== null) {
      return Promise.reject(fail('append', expectedRevision, 'failed'))
    }

    const order = (this.#nextOrder += 1)
    let cloned

    try {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision === Number.MAX_SAFE_INTEGER
      ) {
        throw fail('append', expectedRevision, 'revision')
      }

      cloned = cloneJsonValue(value)
    } catch (error) {
      this.#failedOrder = order
      return Promise.reject(
        error instanceof CandidateError
          ? error
          : fail('append', expectedRevision, 'value'),
      )
    }

    const result = this.#tail.then(async () => {
      if (this.#failedOrder !== null && this.#failedOrder < order) {
        throw fail('append', expectedRevision, 'failed')
      }

      try {
        return await this.#appendInternal(expectedRevision, cloned)
      } catch (error) {
        if (this.#failedOrder === null || order < this.#failedOrder) {
          this.#failedOrder = order
        }
        throw error instanceof CandidateError
          ? error
          : fail('append', expectedRevision, 'failed')
      }
    })

    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )

    return result
  }

  async close() {
    this.#closed = true
    await this.#tail
  }

  async #appendInternal(expectedRevision, value) {
    const head = await this.#readChain('append')
    const currentRevision = head?.revision ?? 0

    if (currentRevision !== expectedRevision) {
      throw fail('append', expectedRevision, 'revision')
    }

    const revision = expectedRevision + 1
    const finalName = revisionFileName('append', revision)
    const finalPath = join(this.#ownerDirectory, finalName)

    if (await this.#exists(finalPath, 'append', revision)) {
      throw fail('append', revision, 'destination')
    }

    const { envelope, digest } = createEnvelope(
      this.#binding,
      revision,
      head?.digest ?? null,
      value,
    )

    await this.#ensureOwnerDirectory('append', revision)

    const pendingName = `${PENDING_PREFIX}${String(revision).padStart(
      REVISION_WIDTH,
      '0',
    )}-${randomUUID()}`
    const pendingPath = join(this.#ownerDirectory, pendingName)

    let handle
    try {
      handle = await open(pendingPath, 'wx', 0o600)
    } catch {
      throw fail('append', revision, 'pending')
    }

    let handleClosed = false
    try {
      await this.#invokeHook('opened', revision)

      try {
        await handle.writeFile(envelope, 'utf8')
      } catch {
        throw fail('append', revision, 'write')
      }
      await this.#invokeHook('written', revision)

      try {
        await handle.sync()
      } catch {
        throw fail('append', revision, 'file-sync')
      }
      await this.#invokeHook('file-synced', revision)

      try {
        await handle.close()
      } catch {
        throw fail('append', revision, 'close')
      }
      handleClosed = true
      await this.#invokeHook('closed', revision)
    } finally {
      if (!handleClosed) {
        try {
          await handle.close()
        } catch {
          // The original failure remains the append error.
        }
      }
    }

    if (await this.#exists(finalPath, 'append', revision)) {
      throw fail('append', revision, 'destination')
    }

    try {
      await rename(pendingPath, finalPath)
    } catch {
      throw fail('append', revision, 'rename')
    }
    await this.#invokeHook('renamed', revision)

    await syncDirectory(this.#ownerDirectory, 'append', revision)
    if (head === undefined) {
      await syncDirectory(this.#root, 'append', revision)
    }
    await this.#invokeHook('directory-synced', revision)

    const verified = await this.#readChain('append')
    if (verified?.revision !== revision || verified.digest !== digest) {
      throw fail('append', revision, 'verify')
    }
    await this.#invokeHook('verified', revision)

    return verified
  }

  async #readChain(operation) {
    const ownerState = await this.#ownerState(operation)
    if (ownerState === null) {
      return undefined
    }

    if (ownerState.isSymbolicLink() || !ownerState.isDirectory()) {
      throw fail(operation, undefined, 'directory-type')
    }

    let entries
    try {
      entries = await readdir(this.#ownerDirectory, { withFileTypes: true })
    } catch {
      throw fail(operation, undefined, 'directory-read')
    }

    const files = []
    const seenRevisions = new Set()

    for (const entry of entries) {
      if (entry.name.startsWith(PENDING_PREFIX)) {
        continue
      }

      const match = FINAL_PATTERN.exec(entry.name)
      if (!match) {
        throw fail(operation, undefined, 'filename')
      }

      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        throw fail(operation, undefined, 'filename')
      }

      if (seenRevisions.has(revision)) {
        throw fail(operation, revision, 'duplicate-revision')
      }
      seenRevisions.add(revision)

      const filePath = join(this.#ownerDirectory, entry.name)
      let fileState
      try {
        fileState = await lstat(filePath)
      } catch {
        throw fail(operation, revision, 'file-type')
      }

      if (!fileState.isFile() || fileState.isSymbolicLink()) {
        throw fail(operation, revision, 'file-type')
      }

      files.push({ revision, path: filePath })
    }

    files.sort((left, right) => left.revision - right.revision)

    let expectedRevision = 1
    let previousDigest = null
    let head

    for (const file of files) {
      if (file.revision !== expectedRevision) {
        const category =
          file.revision < expectedRevision
            ? 'duplicate-revision'
            : 'missing-revision'
        throw fail(operation, file.revision, category)
      }

      let text
      try {
        text = await readFile(file.path, 'utf8')
      } catch {
        throw fail(operation, file.revision, 'read')
      }

      const parsed = parseEnvelope(
        text,
        operation,
        file.revision,
        file.revision - 1,
        previousDigest,
        this.#binding,
      )

      head = {
        revision: parsed.revision,
        digest: parsed.digest,
        value: parsed.value,
      }
      previousDigest = parsed.digest
      expectedRevision = file.revision + 1
    }

    return head
  }

  async #ownerState(operation) {
    try {
      return await lstat(this.#ownerDirectory)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null
      }
      throw fail(operation, undefined, 'directory')
    }
  }

  async #ensureOwnerDirectory(operation, revision) {
    const current = await this.#ownerState(operation)
    if (current !== null) {
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw fail(operation, revision, 'directory-type')
      }
      return
    }

    try {
      await mkdir(this.#ownerDirectory, { mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const raced = await this.#ownerState(operation)
        if (raced !== null) {
          if (raced.isSymbolicLink() || !raced.isDirectory()) {
            throw fail(operation, revision, 'directory-type')
          }
          return
        }
      }
      throw fail(operation, revision, 'directory-create')
    }
  }

  async #exists(path, operation, revision) {
    try {
      await lstat(path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return false
      }
      throw fail(operation, revision, 'destination')
    }
  }

  async #invokeHook(point, revision) {
    const boundary = this.#hooks?.boundary
    if (typeof boundary !== 'function') {
      return
    }

    try {
      await boundary.call(this.#hooks, point)
    } catch {
      throw fail('append', revision, 'hook')
    }
  }
}

/**
 * Create a probe candidate over a freshly allocated scratch root.
 * @param {string} root
 * @param {Binding} binding
 * @param {Hooks} [hooks]
 * @returns {Promise<Candidate>}
 */
export async function createCandidate(root, binding, hooks = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    throw fail('create', undefined, 'root')
  }

  let rootState
  try {
    rootState = await lstat(root)
  } catch {
    throw fail('create', undefined, 'root')
  }

  if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
    throw fail('create', undefined, 'root')
  }

  let normalizedBinding
  try {
    normalizedBinding = normalizeBinding(binding)
  } catch (error) {
    if (error instanceof CandidateError) {
      throw error
    }
    throw fail('create', undefined, 'binding')
  }

  const resolvedRoot = resolve(root)
  const ownerDirectory = join(resolvedRoot, deriveKey(normalizedBinding))

  return new Candidate(resolvedRoot, normalizedBinding, ownerDirectory, hooks)
}

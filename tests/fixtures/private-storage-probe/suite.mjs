import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCandidate } from './candidate.mjs'

const SCRATCH_PREFIX = join(tmpdir(), 'opencode-private-storage-probe-')
const FINAL_PATTERN = /^\d{16}\.json$/
const PENDING_PREFIX = '.pending-'
const WORKER_PATH = fileURLToPath(new URL('./worker.mjs', import.meta.url))
const SUITE_PATH = fileURLToPath(import.meta.url)
const PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM'])
const PLATFORM_LIMITATIONS = Object.freeze([
  'Static path checks do not prove resistance to adversarial substitution between the check and the use.',
  'The proposed production threat boundary excludes other ordinary users, but not the owning account or administrators.',
  'Node portable filesystem APIs do not establish no-follow or Windows reparse-point handle semantics equivalent to native handle options.',
])
const BOUNDARY_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 5_000
const TIMEOUT_PROBE_MS = 1_000
const PRE_ACK_BOUNDARIES = [
  'opened',
  'written',
  'file-synced',
  'closed',
]
const COMMITTED_BOUNDARIES = [
  'renamed',
  'directory-synced',
  'verified',
  'acknowledged',
]
const CRASH_BOUNDARIES = [...PRE_ACK_BOUNDARIES, ...COMMITTED_BOUNDARIES]
const HOOK_EXCEPTION_BOUNDARIES = CRASH_BOUNDARIES.filter(
  (boundary) => boundary !== 'acknowledged',
)
const activeRoots = new Set()

function bindingFor(root) {
  return {
    project: 'probe',
    directory: root,
    owner: 'fake-parent',
    agent: 'build',
  }
}

function ownerDirectoryFor(root, binding) {
  return join(
    resolve(root),
    sha256(
      JSON.stringify([
        binding.project,
        resolve(binding.directory),
        binding.owner,
      ]),
    ),
  )
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function withRoot(label, run) {
  const root = await mkdtemp(SCRATCH_PREFIX)
  activeRoots.add(root)

  let result
  try {
    result = await run(root)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(`${label}: ${detail}\nscratch preserved at ${root}`, {
      cause: error,
    })
    wrapped.scratchRoot = root
    throw wrapped
  }

  await rm(root, { recursive: true, force: true })
  activeRoots.delete(root)
  return result
}

async function inspectStore(root) {
  const rootEntries = await readdir(root, { withFileTypes: true })
  const ownerDirectories = rootEntries.filter((entry) => entry.isDirectory())

  assert.equal(ownerDirectories.length, 1, 'expected exactly one owner directory')
  assert.match(ownerDirectories[0].name, /^[0-9a-f]{64}$/)

  const ownerDirectory = join(root, ownerDirectories[0].name)
  const ownerEntries = await readdir(ownerDirectory, { withFileTypes: true })
  const finalNames = ownerEntries
    .map((entry) => entry.name)
    .filter((name) => FINAL_PATTERN.test(name))
    .sort()

  return { ownerDirectory, ownerEntries, finalNames }
}

async function seedStore(root, count) {
  const binding = bindingFor(root)
  const candidate = await createCandidate(root, binding)
  const heads = []

  try {
    for (let revision = 1; revision <= count; revision += 1) {
      heads.push(
        await candidate.append(revision - 1, {
          marker: `synthetic-${revision}`,
          findings: [`finding-${revision}`],
        }),
      )
    }
  } finally {
    await candidate.close()
  }

  const store = await inspectStore(root)
  return { binding, heads, ...store }
}

async function expectLoadRejects(root, binding, pattern) {
  const candidate = await createCandidate(root, binding)

  try {
    await assert.rejects(candidate.load(), (error) => {
      assert.match(error.message, pattern)
      assert.ok(
        !error.message.includes(root),
        'candidate errors must not expose the scratch path',
      )
      return true
    })
  } finally {
    await candidate.close()
  }
}

async function rewriteEnvelope(file, mutate) {
  const envelope = JSON.parse(await readFile(file, 'utf8'))
  const payload = JSON.parse(envelope.payload)

  mutate(payload, envelope)

  const payloadText = JSON.stringify(payload)
  const nextEnvelope = {
    payload: payloadText,
    digest: sha256(payloadText),
  }

  await writeFile(file, JSON.stringify(nextEnvelope), 'utf8')
}

async function checkRestartAndOwnership() {
  await withRoot('restart and ownership', async (root) => {
    const binding = bindingFor(root)
    const first = await createCandidate(root, binding)
    let firstClosed = false

    try {
      assert.equal(await first.load(), undefined)

      const saved = await first.append(0, {
        override: false,
        findings: ['synthetic'],
      })

      assert.equal(saved.revision, 1)
      assert.match(saved.digest, /^[0-9a-f]{64}$/)
      assert.deepEqual(saved.value, {
        override: false,
        findings: ['synthetic'],
      })

      await first.close()
      firstClosed = true

      const store = await inspectStore(root)
      assert.deepEqual(store.finalNames, ['0000000000000001.json'])

      const file = join(store.ownerDirectory, store.finalNames[0])
      const envelope = JSON.parse(await readFile(file, 'utf8'))
      assert.deepEqual(Object.keys(envelope).sort(), ['digest', 'payload'])
      assert.equal(envelope.digest, sha256(envelope.payload))
      assert.equal(envelope.digest, saved.digest)

      const payload = JSON.parse(envelope.payload)
      assert.deepEqual(Object.keys(payload).sort(), [
        'binding',
        'kind',
        'previous',
        'revision',
        'value',
        'version',
      ])
      assert.deepEqual(payload.binding, binding)
      assert.equal(payload.kind, 'checkpoint-probe')
      assert.equal(payload.version, 1)
      assert.equal(payload.revision, 1)
      assert.equal(payload.previous, null)
      assert.deepEqual(payload.value, saved.value)

      const restarted = await createCandidate(root, binding)
      try {
        assert.deepEqual(await restarted.load(), saved)
        await assert.rejects(restarted.append(0, { stale: true }), /revision/i)
      } finally {
        await restarted.close()
      }

      const wrongAgent = await createCandidate(root, {
        ...binding,
        agent: 'other',
      })
      try {
        await assert.rejects(wrongAgent.load(), /binding/i)
      } finally {
        await wrongAgent.close()
      }
    } finally {
      if (!firstClosed) {
        await first.close()
      }
    }
  })
}

async function checkCommittedFileMutations() {
  for (const field of ['owner', 'agent', 'project', 'directory']) {
    await withRoot(`altered ${field}`, async (root) => {
      const { binding, ownerDirectory, finalNames } = await seedStore(root, 2)
      const file = join(ownerDirectory, finalNames.at(-1))

      await rewriteEnvelope(file, (payload) => {
        payload.binding[field] =
          field === 'directory' ? '/synthetic/alternate-store' : `synthetic-${field}`
      })

      await expectLoadRejects(root, binding, /binding/i)
    })
  }

  await withRoot('invalid JSON', async (root) => {
    const { binding, ownerDirectory, finalNames } = await seedStore(root, 2)
    await writeFile(join(ownerDirectory, finalNames.at(-1)), '{"payload":', 'utf8')
    await expectLoadRejects(root, binding, /json/i)
  })

  await withRoot('invalid digest', async (root) => {
    const { binding, ownerDirectory, finalNames } = await seedStore(root, 2)
    const file = join(ownerDirectory, finalNames.at(-1))
    const envelope = JSON.parse(await readFile(file, 'utf8'))
    envelope.digest = '0'.repeat(64)
    await writeFile(file, JSON.stringify(envelope), 'utf8')
    await expectLoadRejects(root, binding, /digest/i)
  })

  await withRoot('missing interior revision', async (root) => {
    const { binding, ownerDirectory, finalNames } = await seedStore(root, 3)
    await rm(join(ownerDirectory, finalNames[1]))
    await expectLoadRejects(root, binding, /(missing|revision)/i)
  })

  await withRoot('duplicate logical revision', async (root) => {
    const { binding, ownerDirectory, finalNames } = await seedStore(root, 3)
    await copyFile(
      join(ownerDirectory, finalNames[1]),
      join(ownerDirectory, finalNames[2]),
    )
    await expectLoadRejects(root, binding, /(duplicate|revision)/i)
  })

  await withRoot('malformed final filename', async (root) => {
    const { binding, ownerDirectory, finalNames } = await seedStore(root, 2)
    await copyFile(
      join(ownerDirectory, finalNames[0]),
      join(ownerDirectory, '000000000000000.json'),
    )
    await expectLoadRejects(root, binding, /filename/i)
  })

  await withRoot('corrupt final tail', async (root) => {
    const { binding, ownerDirectory, finalNames } = await seedStore(root, 2)
    await writeFile(
      join(ownerDirectory, finalNames.at(-1)),
      '{"payload":"unterminated',
      'utf8',
    )
    await expectLoadRejects(root, binding, /json/i)
  })

  await withRoot('redirected owner directory', async (root) => {
    const { binding, ownerDirectory } = await seedStore(root, 1)
    const targetDirectory = `${ownerDirectory}-target`
    await rename(ownerDirectory, targetDirectory)
    await symlink(targetDirectory, ownerDirectory, 'dir')
    await expectLoadRejects(root, binding, /(directory|type)/i)
  })

  await withRoot('complete and unparseable pending files', async (root) => {
    const { binding, heads, ownerDirectory } = await seedStore(root, 1)
    const completeName = `${PENDING_PREFIX}0000000000000002-${randomUUID()}`
    const unparseableName = `${PENDING_PREFIX}0000000000000003-${randomUUID()}`

    const pendingPayload = JSON.stringify({
      kind: 'checkpoint-probe',
      version: 1,
      binding,
      revision: 2,
      previous: heads[0].digest,
      value: { marker: 'pending-complete' },
    })
    const pendingEnvelope = JSON.stringify({
      payload: pendingPayload,
      digest: sha256(pendingPayload),
    })

    await writeFile(join(ownerDirectory, completeName), pendingEnvelope, 'utf8')
    await writeFile(join(ownerDirectory, unparseableName), 'not json', 'utf8')

    const loader = await createCandidate(root, binding)
    try {
      assert.deepEqual(await loader.load(), heads[0])
      const names = await readdir(ownerDirectory)
      assert.ok(names.includes(completeName))
      assert.ok(names.includes(unparseableName))
    } finally {
      await loader.close()
    }
  })
}

async function checkQueuedSaves() {
  await withRoot('queued saves and input capture', async (root) => {
    const candidate = await createCandidate(root, bindingFor(root))
    let closed = false

    try {
      const input = { marker: 'before' }
      const one = candidate.append(0, input)
      input.marker = 'after'
      const two = candidate.append(1, { marker: 'second' })

      const [a, b] = await Promise.all([one, two])
      assert.equal(a.value.marker, 'before')
      assert.equal(b.revision, 2)
      assert.deepEqual(await candidate.load(), b)

      await candidate.close()
      closed = true
      await assert.rejects(candidate.append(2, {}), /closed/i)
    } finally {
      if (!closed) {
        await candidate.close()
      }
    }
  })
}

async function checkNonJsonInput() {
  const circular = {}
  circular.self = circular
  const cases = [
    ['bigint value', { marker: 1n }],
    ['undefined property', { marker: undefined }],
    ['circular value', circular],
  ]

  for (const [label, value] of cases) {
    await withRoot(label, async (root) => {
      const candidate = await createCandidate(root, bindingFor(root))
      try {
        await assert.rejects(candidate.append(0, value), /(json|value)/i)
        await assert.rejects(candidate.append(0, {}), /(failed|closed)/i)
      } finally {
        await candidate.close()
      }
    })
  }

  await withRoot('array accessor input', async (root) => {
    let getterCalls = 0
    const value = []
    Object.defineProperty(value, 0, {
      get() {
        getterCalls += 1
        return 'getter-result'
      },
      enumerable: true,
      configurable: true,
    })

    const candidate = await createCandidate(root, bindingFor(root))
    try {
      let appendError
      try {
        await candidate.append(0, value)
      } catch (error) {
        appendError = error
      }

      assert.equal(getterCalls, 0, 'append must not execute the getter')
      assert.ok(appendError, 'append must reject an array accessor')
      assert.match(appendError.message, /(json|value)/i)
      await assert.rejects(candidate.append(0, {}), /(failed|closed)/i)
    } finally {
      await candidate.close()
    }
  })

  await withRoot('symbol-keyed array input', async (root) => {
    const binding = bindingFor(root)
    const value = ['kept']
    value[Symbol('extra')] = 'extra'
    const candidate = await createCandidate(root, binding)
    let appendError

    try {
      try {
        await candidate.append(0, value)
      } catch (error) {
        appendError = error
      }
    } finally {
      await candidate.close()
    }

    const verifier = await createCandidate(root, binding)
    try {
      assert.equal(
        await verifier.load(),
        undefined,
        'rejected input must not commit a revision',
      )
    } finally {
      await verifier.close()
    }

    assert.ok(appendError, 'append must reject a symbol-keyed array property')
    assert.match(appendError.message, /(json|value)/i)
  })
}

async function checkExistingDestination() {
  await withRoot('existing destination', async (root) => {
    let destinationFile
    const hooks = {
      boundary: async (point) => {
        if (point !== 'opened') {
          return
        }

        const store = await inspectStore(root)
        destinationFile = join(store.ownerDirectory, '0000000000000001.json')
        await writeFile(destinationFile, 'occupied', { flag: 'wx' })
      },
    }

    const candidate = await createCandidate(root, bindingFor(root), hooks)
    try {
      await assert.rejects(candidate.append(0, { synthetic: true }), /destination/i)
      assert.ok(destinationFile)
      assert.equal(await readFile(destinationFile, 'utf8'), 'occupied')

      const names = await readdir(dirname(destinationFile))
      assert.ok(
        names.some((name) => name.startsWith(PENDING_PREFIX)),
        'the unpublished pending file must be retained',
      )
    } finally {
      await candidate.close()
    }
  })
}

function expectedHead(binding, revision, previous, value) {
  const payload = JSON.stringify({
    kind: 'checkpoint-probe',
    version: 1,
    binding,
    revision,
    previous,
    value,
  })

  return { revision, digest: sha256(payload), value }
}

function expectedSeedHead(binding) {
  return expectedHead(binding, 1, null, {
    marker: 'synthetic-1',
    findings: ['finding-1'],
  })
}

async function assertStoredHead(ownerDirectory, expected, binding, previous) {
  const fileName = `${String(expected.revision).padStart(16, '0')}.json`
  const text = await readFile(join(ownerDirectory, fileName), 'utf8')
  const envelope = JSON.parse(text)

  assert.deepEqual(Object.keys(envelope).sort(), ['digest', 'payload'])
  assert.equal(envelope.digest, sha256(envelope.payload))
  assert.equal(envelope.digest, expected.digest)
  assert.deepEqual(JSON.parse(envelope.payload), {
    kind: 'checkpoint-probe',
    version: 1,
    binding,
    revision: expected.revision,
    previous,
    value: expected.value,
  })
}

async function inspectPending(ownerDirectory) {
  const entries = await readdir(ownerDirectory, { withFileTypes: true })
  const pendingEntries = entries.filter((entry) =>
    entry.name.startsWith(PENDING_PREFIX),
  )

  assert.ok(pendingEntries.length <= 1, 'expected at most one pending file')

  if (pendingEntries.length === 0) {
    return undefined
  }

  const path = join(ownerDirectory, pendingEntries[0].name)
  const state = await stat(path)
  return { name: pendingEntries[0].name, path, size: state.size }
}

async function assertPendingEnvelope(pending, expected) {
  const envelope = JSON.parse(await readFile(pending.path, 'utf8'))

  assert.equal(envelope.digest, expected.digest)
  assert.equal(envelope.digest, sha256(envelope.payload))
  assert.deepEqual(JSON.parse(envelope.payload).value, expected.value)
}

function startSupervisedProcess(command, args, label) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Spreading the parent environment preserves BUN_BE_BUN=1, which embedded
    // Bun workers need in order to start as the same runtime.
    env: { ...process.env },
  })

  const state = {
    label,
    child,
    pid: child.pid,
    stdoutLines: [],
    stderr: '',
    records: [],
    protocolErrors: [],
    exit: null,
    spawnError: null,
    stdoutBuffer: '',
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    state.stdoutBuffer += chunk

    let newline
    while ((newline = state.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = state.stdoutBuffer.slice(0, newline)
      state.stdoutBuffer = state.stdoutBuffer.slice(newline + 1)

      if (line.length === 0) {
        continue
      }

      state.stdoutLines.push(line)

      let record
      try {
        record = JSON.parse(line)
      } catch {
        state.protocolErrors.push('stdout line was not JSON')
        continue
      }

      const keys =
        record !== null && typeof record === 'object' && !Array.isArray(record)
          ? Object.keys(record)
          : []

      if (
        keys.length !== 1 ||
        keys[0] !== 'boundary' ||
        typeof record.boundary !== 'string'
      ) {
        state.protocolErrors.push(
          'stdout record was not metadata-only {boundary}',
        )
        continue
      }

      state.records.push(record)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    state.stderr = (state.stderr + chunk).slice(-65_536)
  })

  state.exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      state.exit = { code, signal }
      resolve(state.exit)
    })
  })

  child.once('error', (error) => {
    state.spawnError = error instanceof Error ? error.message : String(error)
  })

  return state
}

function startWorker(root, boundary) {
  assert.ok(
    CRASH_BOUNDARIES.includes(boundary),
    `unsupported worker boundary: ${boundary}`,
  )

  return startSupervisedProcess(
    process.execPath,
    [WORKER_PATH, root, boundary],
    boundary,
  )
}

function workerError(message, state) {
  const stderr = state.stderr.trim()
  const stderrTail = stderr.length > 500 ? `...${stderr.slice(-500)}` : stderr
  const exit = state.exit === null ? 'none' : JSON.stringify(state.exit)

  return new Error(
    `${message}; pid=${state.pid ?? 'none'}; exit=${exit}; ` +
      `stderr=${stderrTail || '(empty)'}`,
  )
}

async function retainWorkerDiagnostics(root, label, state, extra) {
  const safeLabel = String(label).replace(/[^a-zA-Z0-9._-]/g, '_')
  const file = join(root, `worker-diagnostic-${safeLabel}.json`)
  const diagnostic = {
    label,
    pid: state.pid ?? null,
    expectedBoundary: extra.expectedBoundary ?? null,
    timeoutMs: extra.timeoutMs ?? null,
    elapsedMs: extra.elapsedMs ?? null,
    stdoutLines: state.stdoutLines,
    records: state.records,
    protocolErrors: state.protocolErrors,
    stderr: state.stderr,
    exit: state.exit,
    spawnError: state.spawnError,
    terminationError: extra.terminationError ?? null,
  }

  await writeFile(file, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8')
  return file
}

async function waitForExit(state) {
  if (state.exit !== null) {
    return state.exit
  }

  let timer
  try {
    return await Promise.race([
      state.exitPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `worker '${state.label}' exit was not confirmed within ` +
                  `${EXIT_TIMEOUT_MS}ms`,
              ),
            ),
          EXIT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function terminateWorker(state) {
  if (state.spawnError !== null || state.pid === undefined) {
    return state.exit
  }

  if (state.exit !== null) {
    return state.exit
  }

  try {
    state.child.kill('SIGKILL')
  } catch (error) {
    state.killError = error instanceof Error ? error.message : String(error)
  }

  return waitForExit(state)
}

function waitForBoundary(state, boundary, options = {}) {
  const {
    timeoutMs = BOUNDARY_TIMEOUT_MS,
    root,
    label = state.label,
  } = options
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    let settled = false
    let timer

    const removeWaiters = () => {
      clearTimeout(timer)
      state.child.stdout.off('data', check)
      state.child.off('exit', onExit)
      state.child.off('error', onError)
    }

    const finish = (handler, value) => {
      if (settled) {
        return
      }

      settled = true
      removeWaiters()
      handler(value)
    }

    const check = () => {
      if (state.protocolErrors.length > 0) {
        finish(
          reject,
          workerError(
            `worker '${label}' violated the stdout protocol: ` +
              state.protocolErrors.join('; '),
            state,
          ),
        )
        return
      }

      if (state.records.length === 0) {
        return
      }

      if (state.records.length > 1) {
        finish(
          reject,
          workerError(
            `worker '${label}' emitted more than one boundary record`,
            state,
          ),
        )
        return
      }

      const [record] = state.records
      if (record.boundary !== boundary) {
        finish(
          reject,
          workerError(
            `worker '${label}' emitted boundary '${record.boundary}' while ` +
              `waiting for '${boundary}'`,
            state,
          ),
        )
        return
      }

      finish(resolve, record)
    }

    const onExit = () => {
      if (settled) {
        return
      }

      if (state.records.length > 0) {
        check()
        return
      }

      finish(
        reject,
        workerError(
          `worker '${label}' exited before boundary '${boundary}'`,
          state,
        ),
      )
    }

    const onError = () => {
      finish(reject, workerError(`worker '${label}' failed to start`, state))
    }

    const onTimeout = () => {
      if (settled) {
        return
      }

      settled = true
      removeWaiters()

      void (async () => {
        let terminationError = null
        try {
          await terminateWorker(state)
        } catch (error) {
          terminationError =
            error instanceof Error ? error.message : String(error)
        }

        let diagnosticsPath = null
        if (root !== undefined) {
          try {
            diagnosticsPath = await retainWorkerDiagnostics(root, label, state, {
              expectedBoundary: boundary,
              timeoutMs,
              elapsedMs: Date.now() - startedAt,
              terminationError,
            })
          } catch (error) {
            terminationError ??=
              error instanceof Error ? error.message : String(error)
          }
        }

        const error = workerError(
          `worker '${label}' timed out after ${timeoutMs}ms waiting for ` +
            `boundary '${boundary}'`,
          state,
        )
        error.diagnosticsPath = diagnosticsPath
        error.diagnostics = {
          expectedBoundary: boundary,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          terminationError,
          diagnosticsPath,
        }

        reject(error)
      })()
    }

    state.child.stdout.on('data', check)
    state.child.once('exit', onExit)
    state.child.once('error', onError)
    timer = setTimeout(onTimeout, timeoutMs)

    check()
    if (state.exit !== null) {
      onExit()
    }
    if (state.spawnError !== null) {
      onError()
    }
  })
}

async function stopWorker(state) {
  if (
    state.spawnError === null &&
    state.pid !== undefined &&
    state.exit === null
  ) {
    await terminateWorker(state)
  }

  state.child.stdout?.destroy()
  state.child.stderr?.destroy()
}

async function checkCrashBoundary(boundary) {
  await withRoot(`crash boundary ${boundary}`, async (root) => {
    const { binding, heads, ownerDirectory } = await seedStore(root, 1)
    const expected1 = expectedSeedHead(binding)
    const expected2 = expectedHead(binding, 2, heads[0].digest, {
      marker: 'revision-two',
    })

    assert.deepEqual(heads[0], expected1)

    const worker = startWorker(root, boundary)
    try {
      const record = await waitForBoundary(worker, boundary, {
        root,
        label: boundary,
      })
      assert.deepEqual(record, { boundary })

      const exit = await terminateWorker(worker)
      assert.ok(exit, 'worker exit must be confirmed before recovery')
      assert.ok(
        worker.child.exitCode !== null || worker.child.signalCode !== null,
        'worker must have exited before recovery is opened',
      )

      const store = await inspectStore(root)
      const pending = await inspectPending(ownerDirectory)

      const recovered = await createCandidate(root, binding)
      try {
        if (PRE_ACK_BOUNDARIES.includes(boundary)) {
          assert.deepEqual(store.finalNames, ['0000000000000001.json'])
          await assertStoredHead(ownerDirectory, expected1, binding, null)
          assert.ok(pending, 'pre-acknowledgement crashes retain the pending file')

          if (boundary === 'opened') {
            assert.equal(pending.size, 0)
          } else {
            assert.ok(pending.size > 1, 'complete pending files must be retained')
            await assertPendingEnvelope(pending, expected2)
          }

          assert.deepEqual(await recovered.load(), expected1)
        } else {
          assert.deepEqual(store.finalNames, [
            '0000000000000001.json',
            '0000000000000002.json',
          ])
          assert.equal(
            pending,
            undefined,
            'renamed revisions must not retain a pending file',
          )
          await assertStoredHead(ownerDirectory, expected1, binding, null)
          await assertStoredHead(
            ownerDirectory,
            expected2,
            binding,
            heads[0].digest,
          )

          const loaded = await recovered.load()
          assert.deepEqual(loaded, expected2)
          assert.equal(loaded.digest, expected2.digest)
          assert.deepEqual(loaded.value, { marker: 'revision-two' })
        }
      } finally {
        await recovered.close()
      }
    } finally {
      await stopWorker(worker)
    }
  })
}

async function checkTruncatedPendingAfterTermination() {
  await withRoot('truncated pending after termination', async (root) => {
    const { binding, ownerDirectory } = await seedStore(root, 1)
    const expected1 = expectedSeedHead(binding)
    const worker = startWorker(root, 'written')

    try {
      const record = await waitForBoundary(worker, 'written', {
        root,
        label: 'truncated-pending',
      })
      assert.deepEqual(record, { boundary: 'written' })

      const pending = await inspectPending(ownerDirectory)
      assert.ok(pending, 'the written boundary must leave a pending file')
      assert.ok(pending.size > 1)
      await truncate(pending.path, 1)

      const exit = await terminateWorker(worker)
      assert.ok(exit, 'worker exit must be confirmed before recovery')
      assert.ok(
        worker.child.exitCode !== null || worker.child.signalCode !== null,
        'worker must have exited before recovery is opened',
      )
    } finally {
      await stopWorker(worker)
    }

    const store = await inspectStore(root)
    assert.deepEqual(store.finalNames, ['0000000000000001.json'])
    await assertStoredHead(ownerDirectory, expected1, binding, null)

    const pending = await inspectPending(ownerDirectory)
    assert.ok(pending, 'the truncated pending file must be retained')
    assert.equal(pending.size, 1)
    assert.equal(await readFile(pending.path, 'utf8'), '{')

    const recovered = await createCandidate(root, binding)
    try {
      assert.deepEqual(await recovered.load(), expected1)
    } finally {
      await recovered.close()
    }
  })
}

async function checkHookException(boundary) {
  await withRoot(`hook exception ${boundary}`, async (root) => {
    const { binding, heads, ownerDirectory } = await seedStore(root, 1)
    const expected1 = expectedSeedHead(binding)
    const expected2 = expectedHead(binding, 2, heads[0].digest, {
      marker: 'hook-failure',
    })
    const observed = []
    let acknowledged = false

    assert.deepEqual(heads[0], expected1)

    const candidate = await createCandidate(root, binding, {
      boundary: async (point) => {
        observed.push(point)
        if (point === boundary) {
          throw new Error('synthetic injected boundary failure')
        }
      },
    })

    try {
      let appendError
      try {
        await candidate.append(1, { marker: 'hook-failure' })
        acknowledged = true
      } catch (error) {
        appendError = error
      }

      assert.equal(acknowledged, false, 'a failed append must not be acknowledged')
      assert.ok(appendError, 'the injected boundary exception must reject append')
      assert.match(appendError.message, /hook/i)
      assert.equal(observed.at(-1), boundary)

      const boundaryIndex = HOOK_EXCEPTION_BOUNDARIES.indexOf(boundary)
      assert.deepEqual(
        observed,
        HOOK_EXCEPTION_BOUNDARIES.slice(0, boundaryIndex + 1),
        'no boundary after the injected failure may be invoked',
      )

      await assert.rejects(
        candidate.append(1, { marker: 'after-hook-failure' }),
        /(failed|closed)/i,
      )
    } finally {
      await candidate.close()
    }

    const store = await inspectStore(root)
    const pending = await inspectPending(ownerDirectory)
    const recovered = await createCandidate(root, binding)

    try {
      if (PRE_ACK_BOUNDARIES.includes(boundary)) {
        assert.deepEqual(store.finalNames, ['0000000000000001.json'])
        assert.ok(pending, 'pre-rename failures retain their pending file')
        await assertStoredHead(ownerDirectory, expected1, binding, null)
        assert.deepEqual(await recovered.load(), expected1)
      } else {
        assert.deepEqual(store.finalNames, [
          '0000000000000001.json',
          '0000000000000002.json',
        ])
        assert.equal(
          pending,
          undefined,
          'rename failures retain no pending file',
        )
        await assertStoredHead(ownerDirectory, expected1, binding, null)
        await assertStoredHead(
          ownerDirectory,
          expected2,
          binding,
          heads[0].digest,
        )

        const loaded = await recovered.load()
        assert.deepEqual(loaded, expected2)
        assert.equal(loaded.digest, expected2.digest)
        assert.deepEqual(loaded.value, { marker: 'hook-failure' })
      }
    } finally {
      await recovered.close()
    }
  })
}

async function checkCorruptReadBackAtRenamed() {
  await withRoot('corrupt read-back at renamed', async (root) => {
    const { binding, heads, ownerDirectory } = await seedStore(root, 1)
    let corrupted = false
    let acknowledged = false

    const candidate = await createCandidate(root, binding, {
      boundary: async (point) => {
        if (point !== 'renamed') {
          return
        }

        await writeFile(
          join(ownerDirectory, '0000000000000002.json'),
          '{"payload":"synthetic-corruption',
          'utf8',
        )
        corrupted = true
      },
    })

    try {
      let appendError
      try {
        await candidate.append(1, { marker: 'corrupt-read-back' })
        acknowledged = true
      } catch (error) {
        appendError = error
      }

      assert.equal(corrupted, true)
      assert.equal(acknowledged, false)
      assert.ok(appendError)
      assert.match(appendError.message, /(json|digest|envelope)/i)
      await assert.rejects(
        candidate.append(1, { marker: 'after-corruption' }),
        /(failed|closed)/i,
      )
    } finally {
      await candidate.close()
    }

    const store = await inspectStore(root)
    assert.deepEqual(store.finalNames, [
      '0000000000000001.json',
      '0000000000000002.json',
    ])
    assert.equal(
      await readFile(join(ownerDirectory, '0000000000000002.json'), 'utf8'),
      '{"payload":"synthetic-corruption',
    )
    assert.equal(await inspectPending(ownerDirectory), undefined)
    await expectLoadRejects(root, binding, /(json|digest|envelope)/i)
  })
}

async function checkCallerAcknowledgedException() {
  await withRoot('caller acknowledged exception', async (root) => {
    const { binding, heads, ownerDirectory } = await seedStore(root, 1)
    const expected2 = expectedHead(binding, 2, heads[0].digest, {
      marker: 'ack-caller',
    })
    const candidate = await createCandidate(root, binding)

    try {
      const saved = await candidate.append(1, { marker: 'ack-caller' })
      assert.deepEqual(saved, expected2)

      const notifyAcknowledged = () => {
        throw new Error('synthetic caller acknowledgement failure')
      }
      assert.throws(notifyAcknowledged, /acknowledgement/i)
    } finally {
      await candidate.close()
    }

    await assertStoredHead(ownerDirectory, expected2, binding, heads[0].digest)

    const recovered = await createCandidate(root, binding)
    try {
      const loaded = await recovered.load()
      assert.deepEqual(loaded, expected2)
      assert.equal(loaded.digest, expected2.digest)
      assert.deepEqual(loaded.value, { marker: 'ack-caller' })
    } finally {
      await recovered.close()
    }
  })
}

async function checkCorruptFinalAfterTermination() {
  await withRoot('corrupt final after termination', async (root) => {
    const { binding, ownerDirectory } = await seedStore(root, 1)
    const worker = startWorker(root, 'acknowledged')

    try {
      const record = await waitForBoundary(worker, 'acknowledged', {
        root,
        label: 'corrupt-final',
      })
      assert.deepEqual(record, { boundary: 'acknowledged' })

      const exit = await terminateWorker(worker)
      assert.ok(exit, 'worker exit must be confirmed before corruption')
      assert.ok(
        worker.child.exitCode !== null || worker.child.signalCode !== null,
        'worker must have exited before the final file is altered',
      )
    } finally {
      await stopWorker(worker)
    }

    const store = await inspectStore(root)
    assert.deepEqual(store.finalNames, [
      '0000000000000001.json',
      '0000000000000002.json',
    ])

    await writeFile(
      join(ownerDirectory, '0000000000000002.json'),
      '{"payload":"truncated-final',
      'utf8',
    )

    await expectLoadRejects(root, binding, /json/i)
  })
}

async function checkWorkerTimeoutDiagnostics() {
  await withRoot('worker timeout diagnostics', async (root) => {
    const script =
      "process.stderr.write('synthetic-timeout-marker\\n'); " +
      'setInterval(() => {}, 1000)'
    const worker = startSupervisedProcess(
      process.execPath,
      ['-e', script],
      'timeout-diagnostic',
    )

    try {
      let timeoutError
      try {
        await waitForBoundary(worker, 'opened', {
          root,
          label: 'timeout-diagnostic',
          timeoutMs: TIMEOUT_PROBE_MS,
        })
      } catch (error) {
        timeoutError = error
      }

      assert.ok(timeoutError, 'a worker timeout must reject supervision')
      assert.match(timeoutError.message, /timed out/i)
      assert.ok(timeoutError.diagnosticsPath, 'timeout diagnostics must be retained')

      const diagnostic = JSON.parse(
        await readFile(timeoutError.diagnosticsPath, 'utf8'),
      )
      assert.equal(diagnostic.label, 'timeout-diagnostic')
      assert.equal(diagnostic.expectedBoundary, 'opened')
      assert.equal(diagnostic.timeoutMs, TIMEOUT_PROBE_MS)
      assert.match(diagnostic.stderr, /synthetic-timeout-marker/)
      assert.ok(diagnostic.exit, 'timeout termination must be confirmed')
      assert.ok(worker.exit, 'the timed-out worker must be reaped')
      assert.ok(
        worker.child.exitCode !== null || worker.child.signalCode !== null,
        'the timed-out worker must no longer be running',
      )
    } finally {
      await stopWorker(worker)
    }
  })
}

function osErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : null
}

function isPermissionError(error) {
  return PERMISSION_ERROR_CODES.has(osErrorCode(error))
}

function modeLabel(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0')
}

function probeResult(result, detail = {}) {
  return { result, ...detail }
}

function failureDetail(operation, error) {
  return probeResult('FAIL', {
    operation,
    errorCode: osErrorCode(error),
    errorName: error instanceof Error ? error.name : null,
  })
}

async function probeFileSync() {
  return withRoot('platform file sync', async (root) => {
    const file = join(root, 'synthetic-file-sync-probe')
    let handle

    try {
      try {
        handle = await open(file, 'wx', 0o600)
      } catch (error) {
        return failureDetail('file-open', error)
      }

      try {
        await handle.writeFile('synthetic-file-sync-probe', 'utf8')
      } catch (error) {
        return failureDetail('file-write', error)
      }

      try {
        await handle.sync()
        return probeResult('PASS', { operation: 'file-sync' })
      } catch (error) {
        return failureDetail('file-sync', error)
      }
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          // The sync result remains the probe result.
        }
      }
    }
  })
}

async function probeDirectorySync() {
  return withRoot('platform directory sync', async (root) => {
    const directory = join(root, 'synthetic-directory-sync')
    const file = join(directory, 'synthetic-file')
    let handle

    try {
      try {
        await mkdir(directory, { mode: 0o700 })
        await writeFile(file, 'synthetic-directory-sync-probe', 'utf8')
      } catch (error) {
        return isPermissionError(error)
          ? probeResult('BLOCKED', {
              operation: 'fixture-create',
              errorCode: osErrorCode(error),
            })
          : failureDetail('fixture-create', error)
      }

      try {
        handle = await open(directory, 'r')
      } catch (error) {
        return failureDetail('directory-open', error)
      }

      try {
        await handle.sync()
        return probeResult('PASS', { operation: 'directory-sync' })
      } catch (error) {
        return failureDetail('directory-sync', error)
      }
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          // The sync result remains the probe result.
        }
      }
    }
  })
}

async function probeWindowsPermissions() {
  return withRoot('platform windows permissions', async (root) => {
    const directory = join(root, 'windows-mode-observation')
    const file = join(directory, 'windows-mode-observation-file')
    let directoryMode = null
    let fileMode = null
    let observationError = null

    try {
      await mkdir(directory, { mode: 0o700 })
      await writeFile(file, 'synthetic-windows-mode-probe', 'utf8')
      const [directoryState, fileState] = await Promise.all([
        stat(directory),
        stat(file),
      ])
      directoryMode = modeLabel(directoryState.mode)
      fileMode = modeLabel(fileState.mode)
    } catch (error) {
      observationError = osErrorCode(error)
    }

    return probeResult('BLOCKED', {
      aclPrivacy: 'UNVERIFIED',
      modeCheck: 'NOT_AN_ACL_TEST',
      ownership: 'NOT_ESTABLISHED',
      directoryMode,
      fileMode,
      errorCode: observationError,
      reason:
        'Windows ACL privacy has not been independently established; Node mode bits are not an ACL test',
    })
  })
}

async function probeLinuxPermissions() {
  return withRoot('platform linux permissions', async (root) => {
    if (
      typeof process.getuid !== 'function' ||
      typeof process.umask !== 'function'
    ) {
      return probeResult('BLOCKED', {
        reason: 'POSIX ownership or umask API is unavailable',
      })
    }

    const uid = process.getuid()
    const originalUmask = process.umask()

    try {
      // A permissive umask proves the explicit mode arguments are doing the work.
      process.umask(0)

      const { ownerDirectory, finalNames } = await seedStore(root, 1)
      const independentDirectory = join(root, 'independent-mode-directory')
      const independentFile = join(independentDirectory, 'independent-mode-file')

      await mkdir(independentDirectory, { mode: 0o700 })
      const handle = await open(independentFile, 'wx', 0o600)
      try {
        await handle.writeFile('synthetic-permission-probe', 'utf8')
      } finally {
        await handle.close()
      }

      const [
        ownerState,
        finalState,
        independentDirectoryState,
        independentFileState,
      ] = await Promise.all([
        stat(ownerDirectory),
        stat(join(ownerDirectory, finalNames[0])),
        stat(independentDirectory),
        stat(independentFile),
      ])

      const candidate = {
        directoryMode: modeLabel(ownerState.mode),
        fileMode: modeLabel(finalState.mode),
        directoryUid: ownerState.uid,
        fileUid: finalState.uid,
      }
      const independent = {
        directoryMode: modeLabel(independentDirectoryState.mode),
        fileMode: modeLabel(independentFileState.mode),
        directoryUid: independentDirectoryState.uid,
        fileUid: independentFileState.uid,
      }

      assert.equal(
        candidate.directoryMode,
        '0700',
        'candidate directory mode must be 0700',
      )
      assert.equal(candidate.fileMode, '0600', 'candidate file mode must be 0600')
      assert.equal(
        candidate.directoryUid,
        uid,
        'candidate directory owner must match process.getuid()',
      )
      assert.equal(
        candidate.fileUid,
        uid,
        'candidate file owner must match process.getuid()',
      )
      assert.equal(
        independent.directoryMode,
        '0700',
        'independent directory mode must be 0700',
      )
      assert.equal(
        independent.fileMode,
        '0600',
        'independent file mode must be 0600',
      )
      assert.equal(
        independent.directoryUid,
        uid,
        'independent directory owner must match process.getuid()',
      )
      assert.equal(
        independent.fileUid,
        uid,
        'independent file owner must match process.getuid()',
      )

      return probeResult('PASS', {
        umask: '0000',
        uid,
        candidate,
        independent,
      })
    } finally {
      process.umask(originalUmask)
    }
  })
}

async function probePermissions() {
  if (process.platform === 'win32') {
    return probeWindowsPermissions()
  }

  if (process.platform === 'linux') {
    return probeLinuxPermissions()
  }

  return probeResult('BLOCKED', {
    aclPrivacy: 'UNVERIFIED',
    modeCheck: 'NOT_AN_ACL_TEST',
    reason: `permission semantics are not established for ${process.platform}`,
  })
}

async function probeRedirectedPaths() {
  return withRoot('platform redirected paths', async (root) => {
    const binding = bindingFor(root)
    const fixture = process.platform === 'win32' ? 'directory-junction' : 'symlink'
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const ownerDirectory = ownerDirectoryFor(root, binding)
    const targetDirectory = `${ownerDirectory}-target`
    const sentinelPath = join(root, 'outside-owner-sentinel')
    const sentinelText = 'synthetic-outside-owner-sentinel'
    const seedValue = { marker: 'synthetic-redirect-seed' }
    const seedPayload = JSON.stringify({
      kind: 'checkpoint-probe',
      version: 1,
      binding,
      revision: 1,
      previous: null,
      value: seedValue,
    })
    const seedEnvelope = JSON.stringify({
      payload: seedPayload,
      digest: sha256(seedPayload),
    })

    try {
      // This static fixture is built without a candidate append so an
      // unavailable directory sync cannot hide the redirection result.
      await mkdir(ownerDirectory, { mode: 0o700 })
      await writeFile(
        join(ownerDirectory, '0000000000000001.json'),
        seedEnvelope,
        'utf8',
      )
      await writeFile(sentinelPath, sentinelText, 'utf8')
      await rename(ownerDirectory, targetDirectory)
      await symlink(targetDirectory, ownerDirectory, linkType)
    } catch (error) {
      if (isPermissionError(error)) {
        return probeResult('BLOCKED', {
          fixture,
          operation: 'fixture-create',
          errorCode: osErrorCode(error),
        })
      }
      return failureDetail('fixture-create', error)
    }

    const candidate = await createCandidate(root, binding)
    let loadError = null
    let appendError = null
    let acknowledged = false

    try {
      try {
        await candidate.load()
      } catch (error) {
        loadError = error
      }

      try {
        await candidate.append(1, { marker: 'redirect-write' })
        acknowledged = true
      } catch (error) {
        appendError = error
      }
    } finally {
      await candidate.close()
    }

    const sentinelAfter = await readFile(sentinelPath, 'utf8')
    const targetEntries = (await readdir(targetDirectory)).sort()

    assert.ok(
      loadError,
      'load must reject access through a redirected owner path',
    )
    assert.equal(
      loadError.category,
      'directory-type',
      'load must reject the redirect before reading through it',
    )
    assert.ok(
      appendError,
      'append must reject access through a redirected owner path',
    )
    assert.equal(
      appendError.category,
      'directory-type',
      'append must reject the redirect before writing through it',
    )
    assert.equal(
      acknowledged,
      false,
      'a redirected append must not be acknowledged',
    )
    assert.equal(
      sentinelAfter,
      sentinelText,
      'the outside-of-owner sentinel must be unchanged',
    )
    assert.deepEqual(
      targetEntries,
      ['0000000000000001.json'],
      'the redirect target must not receive a published revision',
    )

    return probeResult('PASS', {
      fixture,
      rejectedOperations: ['load', 'append'],
      sentinelUnchanged: true,
      targetEntriesUnchanged: true,
    })
  })
}

async function probeDirectorySyncAcknowledgement(directorySync) {
  return withRoot('platform directory-sync acknowledgement', async (root) => {
    const binding = bindingFor(root)

    if (directorySync.result === 'BLOCKED') {
      return probeResult('BLOCKED', {
        reason: 'the directory-sync capability probe was blocked',
        directorySyncErrorCode: directorySync.errorCode ?? null,
      })
    }

    if (directorySync.result === 'FAIL') {
      const candidate = await createCandidate(root, binding)
      let appendError = null
      let acknowledged = false

      try {
        try {
          await candidate.append(0, { marker: 'directory-sync-failure' })
          acknowledged = true
        } catch (error) {
          appendError = error
        }
      } finally {
        await candidate.close()
      }

      assert.equal(
        acknowledged,
        false,
        'a failed directory sync must not be acknowledged',
      )
      assert.ok(appendError, 'a failed directory sync must reject append')
      assert.equal(
        appendError.category,
        'directory-sync',
        'the candidate must report the directory-sync failure category',
      )

      return probeResult('PASS', {
        mode: 'os-directory-sync-failure',
        errorCategory: appendError.category,
        errorCode: directorySync.errorCode ?? null,
      })
    }

    const { ownerDirectory } = await seedStore(root, 1)
    let interrupted = false
    const candidate = await createCandidate(root, binding, {
      boundary: async (point) => {
        if (point === 'renamed') {
          await rename(ownerDirectory, `${ownerDirectory}-detached`)
          interrupted = true
        }
      },
    })
    let appendError = null
    let acknowledged = false

    try {
      try {
        await candidate.append(1, { marker: 'directory-sync-failure' })
        acknowledged = true
      } catch (error) {
        appendError = error
      }
    } finally {
      await candidate.close()
    }

    assert.equal(
      interrupted,
      true,
      'the injected directory-sync failure must run',
    )
    assert.equal(
      acknowledged,
      false,
      'a failed directory sync must not be acknowledged',
    )
    assert.ok(appendError, 'a failed directory sync must reject append')
    assert.equal(
      appendError.category,
      'directory-sync',
      'the candidate must report the directory-sync failure category',
    )

    return probeResult('PASS', {
      mode: 'injected-path-failure',
      errorCategory: appendError.category,
      errorCode: null,
    })
  })
}

export async function runPlatformChecks() {
  const report = {
    platform: process.platform,
    node: process.version,
    bun: process.versions?.bun ?? null,
    fileSync: 'BLOCKED',
    directorySync: 'BLOCKED',
    permissions: 'BLOCKED',
    redirectedPaths: 'BLOCKED',
    directorySyncAcknowledgement: 'BLOCKED',
    aclPrivacy: process.platform === 'win32' ? 'UNVERIFIED' : 'NOT_APPLICABLE',
    pathCheckScope: 'STATIC_ONLY',
    limitations: [...PLATFORM_LIMITATIONS],
    probes: {},
  }

  const capture = async (name, run) => {
    let detail
    try {
      detail = await run()
    } catch (error) {
      detail = probeResult('FAIL', {
        operation: name,
        errorCode: osErrorCode(error),
        errorName: error instanceof Error ? error.name : null,
        diagnostic: error instanceof Error ? error.message : String(error),
        diagnosticRoot: error?.scratchRoot ?? null,
      })
    }

    report[name] = detail.result
    report.probes[name] = detail
    return detail
  }

  await capture('fileSync', probeFileSync)
  const directorySync = await capture('directorySync', probeDirectorySync)
  await capture('permissions', probePermissions)
  await capture('redirectedPaths', probeRedirectedPaths)
  await capture('directorySyncAcknowledgement', () =>
    probeDirectorySyncAcknowledgement(directorySync),
  )

  return report
}

export async function runFormatChecks() {
  const initialRoots = activeRoots.size

  await checkRestartAndOwnership()
  await checkCommittedFileMutations()
  await checkQueuedSaves()
  await checkNonJsonInput()
  await checkExistingDestination()

  assert.equal(
    activeRoots.size,
    initialRoots,
    'format checks must clean their own scratch roots',
  )
}

export async function runCrashChecks() {
  const initialRoots = activeRoots.size

  // These are process-termination checks only. They do not claim power-loss,
  // kernel-crash, storage-controller cache-loss or simultaneous-writer safety.
  for (const boundary of CRASH_BOUNDARIES) {
    await checkCrashBoundary(boundary)
  }

  await checkTruncatedPendingAfterTermination()

  for (const boundary of HOOK_EXCEPTION_BOUNDARIES) {
    await checkHookException(boundary)
  }

  await checkCorruptReadBackAtRenamed()
  await checkCallerAcknowledgedException()
  await checkCorruptFinalAfterTermination()
  await checkWorkerTimeoutDiagnostics()

  assert.equal(
    activeRoots.size,
    initialRoots,
    'crash checks must clean their own scratch roots',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === SUITE_PATH) {
  const platform = await runPlatformChecks()
  const results = {
    fileSync: platform.fileSync,
    directorySync: platform.directorySync,
    permissions: platform.permissions,
    redirectedPaths: platform.redirectedPaths,
    directorySyncAcknowledgement: platform.directorySyncAcknowledgement,
    format: 'PASS',
    crash: 'PASS',
  }
  const diagnostics = {}

  console.log(JSON.stringify(platform))

  if (
    [
      results.fileSync,
      results.directorySync,
      results.permissions,
      results.redirectedPaths,
      results.directorySyncAcknowledgement,
    ].some((result) => result !== 'PASS')
  ) {
    process.exitCode = 1
  }

  for (const [name, run] of [
    ['format', runFormatChecks],
    ['crash', runCrashChecks],
  ]) {
    try {
      await run()
      console.log(JSON.stringify({ check: name, result: 'PASS' }))
    } catch (error) {
      results[name] = 'FAIL'
      const diagnosticRoot = error?.scratchRoot ?? null
      if (diagnosticRoot !== null) {
        diagnostics[name] = diagnosticRoot
      }
      console.log(
        JSON.stringify({
          check: name,
          result: 'FAIL',
          ...(diagnosticRoot === null ? {} : { diagnosticRoot }),
        }),
      )
      process.exitCode = 1
    }
  }

  console.log(
    JSON.stringify({
      check: 'private-storage-probe',
      result: process.exitCode ? 'FAIL' : 'PASS',
      results,
      diagnostics,
    }),
  )
}

import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { createCheckpointStore } from "../src/auto-debate/checkpoint.ts"
import { createRuntime } from "../src/auto-debate/opencode.ts"
import { createAutomaticDebatePlugin } from "../src/auto-debate/plugin.ts"
import {
  openPrivateStore,
  planPrivateRevision,
  privateOwnerKey,
  readMigrationBoundary,
  writeMigrationBoundary,
} from "../src/auto-debate/private-store.ts"
import { parseControl } from "../src/auto-debate/state.ts"
import { migrationToken, selectStorageBackend, sourceDeletionToken } from "../src/auto-debate/storage.ts"
import { AUTOMATIC_PARTICIPANT_KEY } from "../src/auto-debate/checkpoint.ts"
import { deliveryMessageID, parseConversationState } from "../src/auto-debate/validation.ts"
import type { DebateRegistry } from "../src/participants.ts"
import type {
  CheckpointSnapshot,
  Discussion,
  LegacySource,
  MigrationBoundary,
  NativeMigrationMarker,
  Owner,
  PanelMember,
  Rule,
  RuntimeReceipt,
} from "../src/auto-debate/types.ts"
import { privateStorageClient } from "./fixtures/private-storage-client.ts"

type Fixture = Awaited<ReturnType<typeof privateStorageClient>>

const nonce = "a".repeat(32)
const permission: Rule[] = [{ permission: "*", pattern: "*", action: "deny" }]
const member: PanelMember = {
  participant: { agent: "one", description: "one", model: "fake/one" },
  sessionID: "participant-one",
  runtimeAgent: "one",
}
const resolvedMember: PanelMember = {
  participant: { agent: "two", description: "two", model: "fake/two" },
  sessionID: "participant-two",
  runtimeAgent: "two",
}
const cancelledMember: PanelMember = {
  participant: { agent: "three", description: "three", model: "fake/three" },
  sessionID: "participant-three",
  runtimeAgent: "three",
}
const nonceTwo = "b".repeat(32)
const nonceThree = "d".repeat(32)
const promptTwo = "saved prompt two"
const promptThree = "saved prompt three"
const assistantTwo = "assistant-two"
const assistantThree = "assistant-three"

function textDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function brief(question = "Which option?") {
  return {
    question,
    objective: "Choose an option",
    facts: [],
    assumptions: [],
    constraints: [],
    alternatives: [],
    uncertainty: "The evidence is incomplete",
    neededOutcome: "A defensible decision",
  }
}

function discussion(
  owner: Owner,
  status: Discussion["status"],
  overrides: Partial<Discussion> = {},
): Discussion {
  return {
    id: `discussion-${status}`,
    owner,
    config: { enabled: true, maxRounds: 3, persistTranscripts: false },
    brief: brief(),
    panel: [structuredClone(member)],
    status,
    generation: 1,
    cycle: 1,
    results: [],
    evaluations: [],
    pendingTurns: [],
    followups: [],
    ...overrides,
  }
}

function preservationSnapshot(owner: Owner, project: string): CheckpointSnapshot {
  const resolved = discussion(owner, "resolved", {
    id: "discussion-resolved",
    panel: [structuredClone(resolvedMember)],
    results: [{
      cycle: 1, rounds: 2, status: "complete", reason: "round-limit", consensus: true,
      turns: [{ participant: "two", cycle: 1, round: 1, text: "saved turn" }], failures: [],
    }],
    evaluations: [{ cycle: 1, conclusion: "ship", caveats: [], rationale: "settled", next: "act" }],
  })
  const cancelled = discussion(owner, "cancelled", {
    id: "discussion-cancelled",
    panel: [structuredClone(cancelledMember)],
    cancellation: { pendingSessionIDs: [], errors: [] },
    results: [{
      cycle: 1, rounds: 1, status: "cancelled", reason: "explicit-stop", consensus: false,
      turns: [], failures: [],
    }],
  })
  const entries: RuntimeReceipt[] = [
    { kind: "member-bound", discussionID: "discussion-paused", member: structuredClone(member), nonce, permission },
    { kind: "member-bound", discussionID: "discussion-resolved", member: structuredClone(resolvedMember), nonce: nonceTwo, permission },
    { kind: "participant-start-open", sessionID: "participant-two", messageID: "start-two",
      discussionID: "discussion-resolved", generation: 0, cycle: 1, textDigest: textDigest(promptTwo) },
    { kind: "participant-start-closed", sessionID: "participant-two", messageID: "start-two",
      startup: "synchronous-response", outcome: "answer", assistantID: assistantTwo },
    { kind: "member-bound", discussionID: "discussion-cancelled", member: structuredClone(cancelledMember), nonce: nonceThree, permission },
    { kind: "participant-start-open", sessionID: "participant-three", messageID: "start-three",
      discussionID: "discussion-cancelled", generation: 0, cycle: 1, textDigest: textDigest(promptThree) },
    { kind: "participant-start-closed", sessionID: "participant-three", messageID: "start-three",
      startup: "synchronous-response", outcome: "answer", assistantID: assistantThree },
    { kind: "participant-fenced", sessionID: "participant-three" },
    { kind: "participant-stop-confirmed", sessionID: "participant-three" },
    { kind: "delivery-intent", delivery: { id: "delivery-settled", outboxIDs: ["outbox-settled"], text: "saved results" },
      messageID: deliveryMessageID(owner, project, "delivery-settled"),
      selection: { agent: owner.agent, model: { providerID: "fake", modelID: "fake-model" } } },
    { kind: "delivery-dispatch-open", deliveryID: "delivery-settled", attemptID: "attempt-settled" },
    { kind: "delivery-persisted", deliveryID: "delivery-settled", messageID: deliveryMessageID(owner, project, "delivery-settled") },
  ]
  return {
    state: {
      version: 1,
      discussions: [
        discussion(owner, "paused", {
          id: "discussion-paused",
          evaluations: [{ cycle: 1, conclusion: "investigate", caveats: [], rationale: "more", next: "continue" }],
          followups: [{ cycle: 2, feedback: "continue" }],
        }),
        resolved,
        cancelled,
      ],
      outbox: [{ id: "outbox-settled", discussionID: "discussion-resolved", cycle: 1, state: "acknowledged", messageID: "delivery-settled" }],
    },
    runtimeProof: { version: 1, entries },
  }
}

function pausedSnapshot(owner: Owner): CheckpointSnapshot {
  const entries: RuntimeReceipt[] = [
    { kind: "member-bound", discussionID: "discussion-paused", member: structuredClone(member), nonce, permission },
  ]
  return {
    state: {
      version: 1,
      discussions: [discussion(owner, "paused", {
        id: "discussion-paused",
        evaluations: [{ cycle: 1, conclusion: "investigate", caveats: [], rationale: "more", next: "continue" }],
        followups: [{ cycle: 2, feedback: "continue" }],
      })],
      outbox: [],
    },
    runtimeProof: { version: 1, entries },
  }
}

async function seedNative(f: Fixture, snapshot: CheckpointSnapshot) {
  const store = createCheckpointStore(f.input, parseConversationState)
  await store.save(f.owner, snapshot, {
    agent: f.owner.agent,
    model: { providerID: "fake", modelID: "fake-model" },
  })
  const head = await store.inspect(f.owner)
  assert.ok(head)
  return { store, head }
}

function installParticipant(f: Fixture, model = "fake/one"): void {
  f.sessions.set(member.sessionID, {
    id: member.sessionID,
    parentID: f.owner.sessionID,
    projectID: f.projectID,
    directory: f.owner.directory,
    agent: member.runtimeAgent,
    model: { providerID: "fake", id: "one" },
    permission: structuredClone(permission),
    metadata: {
      [AUTOMATIC_PARTICIPANT_KEY]: {
        kind: "opencode-debate-participant",
        version: 1,
        owner: f.owner.sessionID,
        project: f.projectID,
        directory: f.owner.directory,
        agent: member.runtimeAgent,
        nonce,
      },
    },
  })
  f.histories.set(member.sessionID, [])
  assert.equal(model, "fake/one")
}

function installPanelParticipant(
  f: Fixture,
  panelMember: PanelMember,
  participantNonce: string,
  options?: { startID?: string; prompt?: string; assistantID?: string; busy?: boolean },
): void {
  const separator = panelMember.participant.model.indexOf("/")
  assert.ok(separator > 0)
  const providerID = panelMember.participant.model.slice(0, separator)
  const modelID = panelMember.participant.model.slice(separator + 1)
  f.sessions.set(panelMember.sessionID, {
    id: panelMember.sessionID,
    parentID: f.owner.sessionID,
    projectID: f.projectID,
    directory: f.owner.directory,
    agent: panelMember.runtimeAgent,
    model: { providerID, id: modelID },
    permission: structuredClone(permission),
    metadata: {
      [AUTOMATIC_PARTICIPANT_KEY]: {
        kind: "opencode-debate-participant",
        version: 1,
        owner: f.owner.sessionID,
        project: f.projectID,
        directory: f.owner.directory,
        agent: panelMember.runtimeAgent,
        nonce: participantNonce,
      },
    },
  })
  const history: Record<string, unknown>[] = []
  if (options?.startID && options.prompt !== undefined) {
    history.push({
      info: {
        id: options.startID,
        sessionID: panelMember.sessionID,
        role: "user",
        agent: panelMember.runtimeAgent,
        model: { providerID, id: modelID },
        time: { created: 1 },
      },
      parts: [{ id: `part-${options.startID}`, type: "text", text: options.prompt,
        sessionID: panelMember.sessionID, messageID: options.startID }],
    })
    const assistantID = options.assistantID ?? `assistant-${options.startID}`
    history.push({
      info: {
        id: assistantID,
        sessionID: panelMember.sessionID,
        role: "assistant",
        parentID: options.startID,
        time: { created: 2, completed: 3 },
        finish: "stop",
      },
      parts: [{ id: `part-${assistantID}`, type: "text", text: "saved answer",
        sessionID: panelMember.sessionID, messageID: assistantID }],
    })
  }
  f.histories.set(panelMember.sessionID, history)
  if (options?.busy) f.statuses[panelMember.sessionID] = { type: "busy" }
}

function pluginRoot(f: Fixture): string {
  return join(f.stateRoot, "opencode-debate", "auto-debate", "v2")
}

function installDelete(
  f: Fixture,
  mode: "ok" | "forbidden" | "timeout" | "silent",
  onDelete?: () => Promise<void>,
): string[] {
  const calls: string[] = []
  const originalGet = f.session.get
  ;(f.session as unknown as { get: typeof originalGet }).get = async (request) => {
    if (!f.sessions.has(request.path.id)) {
      return { error: { name: "NotFoundError" }, response: new Response(null, { status: 404 }) } as never
    }
    return originalGet(request)
  }
  const originalDelete = (f.session as unknown as { delete?: unknown }).delete
  ;(f.session as unknown as { delete: (request: { path: { id: string } }) => Promise<unknown> }).delete = async (request) => {
    calls.push(request.path.id)
    if (mode === "timeout") throw new Error("native delete timed out")
    if (mode === "forbidden") {
      return { error: { name: "ForbiddenError" }, response: new Response(null, { status: 403 }) }
    }
    if (mode === "silent") return { data: true }
    await onDelete?.()
    f.sessions.delete(request.path.id)
    f.histories.delete(request.path.id)
    return { data: true }
  }
  assert.equal(originalDelete, undefined)
  return calls
}

async function prepareMigrationsDirectory(f: Fixture): Promise<string> {
  let current = f.stateRoot
  for (const component of ["opencode-debate", "auto-debate", "v2"]) {
    current = join(current, component)
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    await chmod(current, 0o700)
  }
  const migrations = join(current, "migrations")
  await mkdir(migrations, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  await chmod(migrations, 0o700)
  return migrations
}

async function prepareOwnerDirectory(f: Fixture): Promise<string> {
  await prepareMigrationsDirectory(f)
  const directory = join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))
  await mkdir(directory, { mode: 0o700 })
  await chmod(directory, 0o700)
  return directory
}

async function prepareInterruptedMigration(f: Fixture, options: {
  genesis: "empty" | "pending" | "pending-v2" | "unknown" | "symlink" | "pending-symlink"
  changeSource?: boolean
}) {
  const snapshot = pausedSnapshot(f.owner)
  const { store, head } = await seedNative(f, snapshot)
  installParticipant(f)
  const source = sourceOf(head)
  const planned = plannedImport(f, head.snapshot, source)
  const token = migrationToken({ project: f.projectID, owner: f.owner, source })
  await store.markMigrated(f.owner, markerFor(f, source, planned.digest, token), source)
  await writeMigrationBoundary(f.stateRoot, preparedBoundary(f, source, planned.digest, token))
  const directory = join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))
  if (options.genesis !== "symlink") await prepareOwnerDirectory(f)
  if (options.genesis === "pending" || options.genesis === "pending-v2") {
    const revision = options.genesis === "pending" ? 1 : 2
    const pending = join(directory, `.pending-${String(revision).padStart(16, "0")}-${randomUUID()}`)
    await writeFile(pending, '{"payload":', { mode: 0o600 })
    await chmod(pending, 0o600)
  } else if (options.genesis === "unknown") {
    const unknown = join(directory, "unknown-entry")
    await writeFile(unknown, "unexpected", { mode: 0o600 })
    await chmod(unknown, 0o600)
  } else if (options.genesis === "symlink") {
    await prepareMigrationsDirectory(f)
    const target = join(f.stateRoot, "symlink-target")
    await mkdir(target, { mode: 0o700 })
    await chmod(target, 0o700)
    await symlink(target, directory, "dir")
  } else if (options.genesis === "pending-symlink") {
    const target = join(f.stateRoot, "pending-target")
    await writeFile(target, "not a pending file", { mode: 0o600 })
    await chmod(target, 0o600)
    await symlink(target, join(directory, `.pending-0000000000000001-${randomUUID()}`))
  }
  if (options.changeSource) {
    const writer = createCheckpointStore(f.input, parseConversationState)
    const current = await writer.load(f.owner)
    assert.ok(current)
    await writer.save(f.owner, { ...current, state: { ...current.state, override: true } }, {
      agent: f.owner.agent,
      model: { providerID: "fake", modelID: "fake-model" },
    })
  }
  return { snapshot, head, source, planned, token, directory }
}

async function migrateFixture(f: Fixture) {
  const snapshot = pausedSnapshot(f.owner)
  const { head } = await seedNative(f, snapshot)
  installParticipant(f)
  const runtime = createRuntime(f.input, { storage: "auto" })
  const preview = await runtime.migrationPreview(f.owner)
  const result = await runtime.migrate(f.owner, preview.token)
  return { snapshot, head, runtime, preview, result }
}

function sourceOf(head: { storeID: string; revision: number; head: string; digest: string }): LegacySource {
  return { storeID: head.storeID, revision: head.revision, head: head.head, digest: head.digest }
}

function plannedImport(f: Fixture, snapshot: CheckpointSnapshot, source: LegacySource) {
  return planPrivateRevision({
    stateRoot: f.stateRoot,
    project: f.projectID,
    owner: f.owner,
    revision: 1,
    previous: null,
    snapshot,
    legacy: source,
  })
}

function markerFor(f: Fixture, source: LegacySource, digest: string, token: string): NativeMigrationMarker {
  return {
    kind: "opencode-debate-migrated",
    version: 1,
    privateOwnerKey: privateOwnerKey(f.projectID, f.owner),
    source: { ...source },
    private: { revision: 1, digest },
    token,
  }
}

function preparedBoundary(f: Fixture, source: LegacySource, digest: string, token: string): MigrationBoundary {
  return {
    kind: "opencode-debate-migration-boundary",
    version: 1,
    state: "prepared",
    project: f.projectID,
    directory: f.owner.directory,
    owner: f.owner.sessionID,
    agent: f.owner.agent,
    source: { ...source },
    private: { revision: 1, digest },
    token,
  }
}

test("storage control requires explicit two-phase migration and deletion syntax", () => {
  assert.deepEqual(parseControl("storage status"), { action: "storage", command: { action: "status" } })
  assert.deepEqual(parseControl("storage migrate"), { action: "storage", command: { action: "migrate" } })
  assert.deepEqual(parseControl(`storage migrate ${"a".repeat(64)} --writer-handover-confirmed`), {
    action: "storage",
    command: { action: "migrate", token: "a".repeat(64), confirmation: "writer-handover-confirmed" },
  })
  assert.deepEqual(parseControl("storage delete-source"), {
    action: "storage",
    command: { action: "delete-source" },
  })
  for (const invalid of [
    "storage", "storage migrate token", "storage migrate " + "a".repeat(64),
    "storage delete-source all " + "a".repeat(64),
    "storage delete-source ses_1",
    "storage delete-source ses_1 " + "A".repeat(64),
    "storage delete-source ses_1 " + "a".repeat(64) + " extra",
    "storage resume", "storage migrate --writer-handover-confirmed",
  ]) assert.throws(() => parseControl(invalid))
})

test("migration preview of a quiet paused native store is read-only and token-bound", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    const nativeHistoryLength = f.histories.get(head.storeID)!.length
    const createsBeforePreview = f.calls.filter((call) => call.method === "create").length
    const runtime = createRuntime(f.input, { storage: "auto" })

    const preview = await runtime.migrationPreview(f.owner)
    const source = sourceOf(head)
    assert.equal(preview.token, migrationToken({ project: f.projectID, owner: f.owner, source }))
    assert.deepEqual(preview.source, source)
    assert.deepEqual(preview.lifecycle, [{ discussionID: "discussion-paused", status: "paused" }])
    assert.deepEqual(preview.intended, { backend: "private", privateRevision: 1, boundary: "prepared" })
    assert.equal(preview.command, `storage migrate ${preview.token} --writer-handover-confirmed`)
    assert.equal(preview.ownerSessionID, f.owner.sessionID)
    assert.equal(preview.agent, f.owner.agent)

    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)
    assert.equal(f.histories.get(head.storeID)!.length, nativeHistoryLength)
    assert.equal(f.modelCalls(), 0)
    assert.equal(f.calls.filter((call) => call.method === "create").length, createsBeforePreview)
  } finally {
    await f.cleanup()
  }
})


async function privateRevision(f: Fixture, revision = 1) {
  const directory = join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))
  const text = await readFile(join(directory, `${String(revision).padStart(16, "0")}.json`), "utf8")
  return JSON.parse((JSON.parse(text) as { payload: string }).payload) as Record<string, unknown>
}

test("explicit migration records a marker and boundary before selecting private", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    f.sessions.get(head.storeID)!.metadata = {
      ...(f.sessions.get(head.storeID)!.metadata as Record<string, unknown>),
      unrelated: { retained: true },
    }
    const parentMetadataBefore = structuredClone(f.sessions.get(f.owner.sessionID)!.metadata)
    let privateExistedAtMarker: boolean | undefined
    const originalUpdate = f.session.update
    ;(f.session as unknown as { update: typeof originalUpdate }).update = async (request) => {
      privateExistedAtMarker = await stat(join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner)))
        .then(() => true, () => false)
      return originalUpdate(request)
    }
    const runtime = createRuntime(f.input, { storage: "auto" })

    const preview = await runtime.migrationPreview(f.owner)
    const result = await runtime.migrate(f.owner, preview.token)
    assert.deepEqual(result.source, sourceOf(head))
    assert.equal(result.privateRevision, 1)
    assert.equal(f.modelCalls(), 0)

    const marker = (f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"] as Record<string, unknown>
    assert.equal(marker.kind, "opencode-debate-migrated")
    assert.deepEqual(marker.source, sourceOf(head))
    assert.deepEqual(marker.private, { revision: 1, digest: result.privateDigest })
    assert.equal(marker.token, preview.token)
    assert.deepEqual((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>).unrelated, { retained: true })
    assert.equal(privateExistedAtMarker, false)
    assert.deepEqual(f.sessions.get(f.owner.sessionID)!.metadata, parentMetadataBefore)

    const payload = await privateRevision(f)
    assert.equal(payload.revision, 1)
    assert.equal(payload.previous, null)
    assert.deepEqual(payload.legacy, sourceOf(head))
    assert.deepEqual(payload.state, snapshot.state)
    assert.deepEqual(payload.runtimeProof, snapshot.runtimeProof)

    const boundary = await readMigrationBoundary(f.stateRoot, f.projectID, f.owner)
    assert.equal(boundary?.state, "committed")
    assert.deepEqual(boundary?.source, sourceOf(head))
    assert.deepEqual(boundary?.private, { revision: 1, digest: result.privateDigest })
    assert.equal(boundary?.token, preview.token)

    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
  } finally {
    await f.cleanup()
  }
})


test("migration preview blocks every non-quiescent lifecycle state without writing", async () => {
  const scenarios: { name: string; mutate: (snapshot: CheckpointSnapshot) => void }[] = [
    { name: "running", mutate: (snapshot) => { snapshot.state.discussions[0].status = "running" } },
    { name: "awaiting-evaluation", mutate: (snapshot) => { snapshot.state.discussions[0].status = "awaiting-evaluation" } },
    { name: "interrupted", mutate: (snapshot) => { snapshot.state.discussions[0].status = "interrupted" } },
    { name: "pending turn", mutate: (snapshot) => {
      snapshot.state.discussions[0].pendingTurns = [{
        participant: "one", cycle: 1, round: 1, text: "pending",
      }]
    } },
    { name: "pending outbox", mutate: (snapshot) => {
      snapshot.state.outbox = [{ id: "outbox-pending", discussionID: "discussion-paused", cycle: 1, state: "pending" }]
    } },
    { name: "pending cancellation", mutate: (snapshot) => {
      snapshot.state.discussions[0].cancellation = { pendingSessionIDs: [member.sessionID], errors: [] }
    } },
    { name: "cancellation error", mutate: (snapshot) => {
      snapshot.state.discussions[0].cancellation = { pendingSessionIDs: [], errors: ["stop failed"] }
    } },
    { name: "delivery uncertainty", mutate: (snapshot) => {
      snapshot.state.discussions[0].deliveryUncertainCycles = [{ cycle: 1, reason: "unknown delivery" }]
    } },
  ]

  for (const scenario of scenarios) {
    const f = await privateStorageClient()
    try {
      const snapshot = pausedSnapshot(f.owner)
      scenario.mutate(snapshot)
      const { head } = await seedNative(f, snapshot)
      installParticipant(f)
      const nativeHistoryLength = f.histories.get(head.storeID)!.length
      const creates = f.calls.filter((call) => call.method === "create").length
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.migrationPreview(f.owner), /quiescent|paused|resolved|cancelled|pending|delivery|cancellation|running|awaiting|interrupted/i, scenario.name)
      await assert.rejects(stat(pluginRoot(f)), /ENOENT/, scenario.name)
      assert.equal(f.histories.get(head.storeID)!.length, nativeHistoryLength, scenario.name)
      assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"], undefined, scenario.name)
      assert.equal(f.calls.filter((call) => call.method === "create").length, creates, scenario.name)
      assert.equal(f.modelCalls(), 0, scenario.name)
    } finally {
      await f.cleanup()
    }
  }
})


test("migration rejects a stale token and a source change after preview", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    const runtime = createRuntime(f.input, { storage: "auto" })
    const preview = await runtime.migrationPreview(f.owner)

    await assert.rejects(runtime.migrate(f.owner, "b".repeat(64)), /token|source/i)
    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)

    const writer = createCheckpointStore(f.input, parseConversationState)
    const current = await writer.load(f.owner)
    assert.deepEqual(current?.state, snapshot.state)
    assert.ok(current)
    await writer.save(f.owner, { ...current, state: { ...current.state, override: true } }, {
      agent: f.owner.agent,
      model: { providerID: "fake", modelID: "fake-model" },
    })
    const changed = await writer.inspect(f.owner)
    assert.equal(changed?.revision, head.revision + 1)
    await assert.rejects(runtime.migrate(f.owner, preview.token), /token|source|stale|changed/i)
    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)
    assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"], undefined)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})


test("a marker-only migration fails closed and retries with the stored token", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { store, head } = await seedNative(f, snapshot)
    installParticipant(f)
    const source = sourceOf(head)
    const planned = plannedImport(f, head.snapshot, source)
    const token = migrationToken({ project: f.projectID, owner: f.owner, source })
    const marker = markerFor(f, source, planned.digest, token)
    await store.markMigrated(f.owner, marker, source)
    const runtime = createRuntime(f.input, { storage: "auto" })

    await assert.rejects(runtime.load(f.owner), /marker|migration|conflict/i)
    const preview = await runtime.migrationPreview(f.owner)
    assert.equal(preview.token, token)
    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)

    const result = await runtime.migrate(f.owner, preview.token)
    assert.equal(result.privateDigest, planned.digest)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.token, token)
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a prepared boundary without a private revision retries to completion", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { store, head } = await seedNative(f, snapshot)
    installParticipant(f)
    const source = sourceOf(head)
    const planned = plannedImport(f, head.snapshot, source)
    const token = migrationToken({ project: f.projectID, owner: f.owner, source })
    await store.markMigrated(f.owner, markerFor(f, source, planned.digest, token), source)
    await writeMigrationBoundary(f.stateRoot, preparedBoundary(f, source, planned.digest, token))
    const runtime = createRuntime(f.input, { storage: "auto" })

    await assert.rejects(runtime.load(f.owner), /boundary|prepared|conflict/i)
    const preview = await runtime.migrationPreview(f.owner)
    assert.equal(preview.token, token)
    await runtime.migrate(f.owner, preview.token)

    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    const directory = join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")), ["0000000000000001.json"])
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a published private import before commit is verified and committed without duplication", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { store, head } = await seedNative(f, snapshot)
    installParticipant(f)
    const source = sourceOf(head)
    const planned = plannedImport(f, head.snapshot, source)
    const token = migrationToken({ project: f.projectID, owner: f.owner, source })
    await store.markMigrated(f.owner, markerFor(f, source, planned.digest, token), source)
    await writeMigrationBoundary(f.stateRoot, preparedBoundary(f, source, planned.digest, token))
    const privateStore = await openPrivateStore({ stateRoot: f.stateRoot, project: f.projectID, owner: f.owner })
    await privateStore.append({ revision: 0, digest: null }, planned.snapshot, source)
    await privateStore.close()

    const runtime = createRuntime(f.input, { storage: "auto" })
    await assert.rejects(runtime.load(f.owner), /boundary|prepared|conflict/i)
    const preview = await runtime.migrationPreview(f.owner)
    assert.equal(preview.token, token)
    await runtime.migrate(f.owner, preview.token)

    const directory = join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")), ["0000000000000001.json"])
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("marker-only and prepared retries reject divergent token or digest evidence", async () => {
  {
    const f = await privateStorageClient()
    try {
      const snapshot = pausedSnapshot(f.owner)
      const { store, head } = await seedNative(f, snapshot)
      installParticipant(f)
      const source = sourceOf(head)
      const planned = plannedImport(f, head.snapshot, source)
      await store.markMigrated(f.owner, markerFor(f, source, planned.digest, "c".repeat(64)), source)
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.migrationPreview(f.owner), /token|source|conflict/i)
      await assert.rejects(stat(pluginRoot(f)), /ENOENT/)
    } finally {
      await f.cleanup()
    }
  }
  {
    const f = await privateStorageClient()
    try {
      const snapshot = pausedSnapshot(f.owner)
      const { store, head } = await seedNative(f, snapshot)
      installParticipant(f)
      const source = sourceOf(head)
      const planned = plannedImport(f, head.snapshot, source)
      const token = migrationToken({ project: f.projectID, owner: f.owner, source })
      await store.markMigrated(f.owner, markerFor(f, source, planned.digest, token), source)
      await writeMigrationBoundary(f.stateRoot, preparedBoundary(f, source, "d".repeat(64), token))
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.migrationPreview(f.owner), /digest|marker|conflict|source/i)
    } finally {
      await f.cleanup()
    }
  }
  {
    const f = await privateStorageClient()
    try {
      const snapshot = pausedSnapshot(f.owner)
      const { store, head } = await seedNative(f, snapshot)
      installParticipant(f)
      const source = sourceOf(head)
      const planned = plannedImport(f, head.snapshot, source)
      const token = migrationToken({ project: f.projectID, owner: f.owner, source })
      await store.markMigrated(f.owner, markerFor(f, source, planned.digest, token), source)
      await writeMigrationBoundary(f.stateRoot, preparedBoundary(f, source, planned.digest, token))
      const privateStore = await openPrivateStore({ stateRoot: f.stateRoot, project: f.projectID, owner: f.owner })
      await privateStore.append({ revision: 0, digest: null }, {
        ...planned.snapshot,
        state: { ...planned.snapshot.state, override: true },
      }, source)
      await privateStore.close()
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.migrationPreview(f.owner), /diverged|private|source|digest/i)
    } finally {
      await f.cleanup()
    }
  }
})


test("migration preserves paused, resolved and cancelled retained state", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = preservationSnapshot(f.owner, f.projectID)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    installPanelParticipant(f, resolvedMember, nonceTwo, {
      startID: "start-two", prompt: promptTwo, assistantID: assistantTwo,
    })
    installPanelParticipant(f, cancelledMember, nonceThree, {
      startID: "start-three", prompt: promptThree, assistantID: assistantThree,
    })
    const runtime = createRuntime(f.input, { storage: "auto" })
    const preview = await runtime.migrationPreview(f.owner)
    assert.deepEqual(preview.lifecycle.map((entry) => entry.status), ["paused", "resolved", "cancelled"])

    await runtime.migrate(f.owner, preview.token)
    const payload = await privateRevision(f)
    assert.deepEqual(payload.state, snapshot.state)
    assert.deepEqual(payload.runtimeProof, snapshot.runtimeProof)
    assert.deepEqual(payload.legacy, sourceOf(head))
    const loaded = await runtime.load(f.owner)
    assert.deepEqual(loaded, snapshot.state)
    assert.deepEqual(loaded.discussions.map((item) => [item.id, item.status, item.panel.map((entry) => entry.sessionID)]), [
      ["discussion-paused", "paused", ["participant-one"]],
      ["discussion-resolved", "resolved", ["participant-two"]],
      ["discussion-cancelled", "cancelled", ["participant-three"]],
    ])
    assert.deepEqual(loaded.discussions[0].followups, [{ cycle: 2, feedback: "continue" }])
    assert.deepEqual(loaded.discussions[1].evaluations[0].conclusion, "ship")
    assert.deepEqual(loaded.discussions[1].results[0].turns[0].text, "saved turn")
    assert.deepEqual(loaded.outbox, snapshot.state.outbox)
    assert.equal(payload.runtimeProof && (payload.runtimeProof as unknown as { entries: { kind: string }[] }).entries
      .some((entry) => entry.kind === "delivery-persisted"), true)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})


test("non-Linux selection rejects a migration marker and permits native-only owners", () => {
  const snapshot = { state: { version: 1 as const, discussions: [], outbox: [] } }
  const source: LegacySource = { storeID: "native-store", revision: 1, head: "head", digest: "a".repeat(64) }
  const nativeHead = { ...source, snapshot }
  const marker: NativeMigrationMarker = {
    kind: "opencode-debate-migrated",
    version: 1,
    privateOwnerKey: "b".repeat(64),
    source,
    private: { revision: 1, digest: "c".repeat(64) },
    token: "d".repeat(64),
  }
  assert.deepEqual(selectStorageBackend("win32", { native: nativeHead }), { kind: "native" })
  assert.deepEqual(selectStorageBackend("win32", { native: { ...nativeHead, migration: marker } }), {
    kind: "conflict", reason: "linux-migration-marker",
  })
})

test("divergent native and private stores fail closed without a timestamp choice", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    const source = sourceOf(head)
    const planned = plannedImport(f, head.snapshot, source)
    const privateStore = await openPrivateStore({ stateRoot: f.stateRoot, project: f.projectID, owner: f.owner })
    await privateStore.append({ revision: 0, digest: null }, planned.snapshot, source)
    await privateStore.close()

    const runtime = createRuntime(f.input, { storage: "auto" })
    await assert.rejects(runtime.load(f.owner), /native-and-private|conflict|both/i)
    await assert.rejects(runtime.migrationPreview(f.owner), /native and private|conflict|both/i)
    assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"], undefined)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})


test("source deletion preview is read-only, exact and token-bound to the private head", async () => {
  const f = await privateStorageClient()
  try {
    const { head, runtime, result } = await migrateFixture(f)
    const calls = installDelete(f, "ok")
    const preview = await runtime.sourceDeletionPreview(f.owner)
    const boundary = await readMigrationBoundary(f.stateRoot, f.projectID, f.owner)
    assert.ok(boundary)
    assert.deepEqual(preview.source, sourceOf(head))
    assert.deepEqual(preview.private, { revision: result.privateRevision, digest: result.privateDigest })
    assert.equal(preview.token, sourceDeletionToken({
      project: f.projectID,
      owner: f.owner,
      source: sourceOf(head),
      boundaryToken: boundary.token,
      boundaryPrivate: boundary.private,
      private: preview.private,
    }))
    assert.equal(preview.command, `storage delete-source ${head.storeID} ${preview.token}`)
    assert.equal(calls.length, 0)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("source deletion writes retiring before deleting only the exact native child", async () => {
  const f = await privateStorageClient()
  try {
    const { snapshot, head, runtime } = await migrateFixture(f)
    const preview = await runtime.sourceDeletionPreview(f.owner)
    let stateAtDelete: string | undefined
    const calls = installDelete(f, "ok", async () => {
      stateAtDelete = (await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state
    })

    await runtime.deleteSource(f.owner, head.storeID, preview.token)
    assert.deepEqual(calls, [head.storeID])
    assert.equal(stateAtDelete, "retiring")
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "retired")
    assert.equal(f.sessions.has(head.storeID), false)
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    const status = await runtime.status(f.owner)
    assert.equal(status.selected, "private")
    assert.equal(status.migration, "retired")
    assert.equal(status.nativeStoreID, undefined)
    assert.equal(status.privateRevision, 1)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("deletion with a wrong exact ID or stale token performs no native deletion", async () => {
  const f = await privateStorageClient()
  try {
    const { head, runtime } = await migrateFixture(f)
    const stale = await runtime.sourceDeletionPreview(f.owner)
    const calls = installDelete(f, "ok")

    await assert.rejects(runtime.deleteSource(f.owner, "other-store", stale.token), /store ID|source/i)
    await assert.rejects(runtime.deleteSource(f.owner, head.storeID, "e".repeat(64)), /token|stale/i)
    assert.equal(calls.length, 0)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")

    await runtime.load(f.owner)
    await runtime.save(f.owner, { ...pausedSnapshot(f.owner).state, override: true })
    await assert.rejects(runtime.deleteSource(f.owner, head.storeID, stale.token), /token|stale|head/i)
    assert.equal(calls.length, 0)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")

    const fresh = await runtime.sourceDeletionPreview(f.owner)
    assert.notEqual(fresh.token, stale.token)
  } finally {
    await f.cleanup()
  }
})

test("a failed native deletion retains retiring evidence and blocks ordinary load", async () => {
  for (const mode of ["forbidden", "timeout", "silent"] as const) {
    const f = await privateStorageClient()
    try {
      const { head, runtime } = await migrateFixture(f)
      const preview = await runtime.sourceDeletionPreview(f.owner)
      const calls = installDelete(f, mode)

      await assert.rejects(runtime.deleteSource(f.owner, head.storeID, preview.token), /deletion|unconfirmed|failed|not-found|not found/i, mode)
      assert.deepEqual(calls, [head.storeID], mode)
      assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "retiring", mode)
      assert.equal(f.sessions.has(head.storeID), true, mode)
      await assert.rejects(runtime.load(f.owner), /retiring|conflict/i, mode)
      assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"] !== undefined, true, mode)
    } finally {
      await f.cleanup()
    }
  }
})

test("a crash after native deletion is completed only by an exact retiring retry", async () => {
  const f = await privateStorageClient()
  try {
    const { snapshot, head, runtime } = await migrateFixture(f)
    const preview = await runtime.sourceDeletionPreview(f.owner)
    const boundary = await readMigrationBoundary(f.stateRoot, f.projectID, f.owner)
    assert.ok(boundary)
    await writeMigrationBoundary(f.stateRoot, { ...boundary, state: "retiring" })
    f.sessions.delete(head.storeID)
    f.histories.delete(head.storeID)
    installDelete(f, "ok")

    await assert.rejects(runtime.load(f.owner), /retiring|conflict/i)
    await assert.rejects(runtime.deleteSource(f.owner, "other-store", preview.token), /store ID|source/i)
    await assert.rejects(runtime.deleteSource(f.owner, head.storeID, "f".repeat(64)), /token|stale/i)
    const resumed = await runtime.sourceDeletionPreview(f.owner)
    assert.equal(resumed.token, preview.token)
    await runtime.deleteSource(f.owner, head.storeID, resumed.token)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "retired")
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})


function commandText(output: { parts: unknown[] }): string {
  return output.parts.map((part) => (part as { text?: unknown }).text).filter((text): text is string => typeof text === "string").join("\n")
}

test("user-only storage commands preview and migrate without manager recovery or writes", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    const registry: DebateRegistry = {
      participants: [
        { agent: "one", description: "one", model: "fake/one" },
        { agent: "two", description: "two", model: "fake/two" },
        { agent: "three", description: "three", model: "fake/three" },
      ],
      sets: { default: ["one", "two", "three"] },
      defaultSet: "default",
    }
    const hooks = await createAutomaticDebatePlugin(registry)(f.input)
    await hooks.config?.({
      permission: {},
      agent: { build: { mode: "primary", permission: {} } },
      command: {},
    } as never)
    const invoke = async (arguments_: string) => {
      const output = { parts: [] as unknown[] }
      await hooks["command.execute.before"]!({
        command: "debate-auto",
        sessionID: f.owner.sessionID,
        arguments: arguments_,
      }, output as never)
      return commandText(output)
    }

    const preview = await invoke("storage migrate")
    const token = migrationToken({ project: f.projectID, owner: f.owner, source: sourceOf(head) })
    assert.match(preview, new RegExp(token))
    assert.match(preview, /No files or state were changed\. No debate was resumed and no model work was started\./)
    assert.match(preview, new RegExp(`/debate-auto storage migrate ${token} --writer-handover-confirmed`))
    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)

    const status = await invoke("storage status")
    assert.match(status, /selected: native/)
    assert.match(status, /migration: none/)

    const migrated = await invoke(`storage migrate ${token} --writer-handover-confirmed`)
    assert.match(migrated, /migration committed/i)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    const committedStatus = await invoke("storage status")
    assert.match(committedStatus, /selected: private/)
    assert.match(committedStatus, /migration: committed/)
    const deletion = await invoke("storage delete-source")
    assert.match(deletion, new RegExp(`storage delete-source ${head.storeID} [a-f0-9]{64}`))
    assert.match(deletion, /No files or state were changed/)
    assert.equal(f.modelCalls(), 0)
    assert.equal(f.calls.some((call) => call.method === "promptAsync"), false)
    assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"] !== undefined, true)
  } finally {
    await f.cleanup()
  }
})


test("storage commands are explicitly unsupported off Linux before touching plugin state", async () => {
  const f = await privateStorageClient()
  const original = process.platform
  try {
    const registry: DebateRegistry = {
      participants: [
        { agent: "one", description: "one", model: "fake/one" },
        { agent: "two", description: "two", model: "fake/two" },
        { agent: "three", description: "three", model: "fake/three" },
      ],
      sets: { default: ["one", "two", "three"] },
      defaultSet: "default",
    }
    const hooks = await createAutomaticDebatePlugin(registry)(f.input)
    await hooks.config?.({
      permission: {},
      agent: { build: { mode: "primary", permission: {} } },
      command: {},
    } as never)
    let pathCalls = 0
    const originalPath = f.input.client.path.get
    f.input.client.path.get = (async (request: unknown) => {
      pathCalls++
      return originalPath(request as never)
    }) as typeof f.input.client.path.get
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    const output = { parts: [] as unknown[] }
    await hooks["command.execute.before"]!({
      command: "debate-auto",
      sessionID: f.owner.sessionID,
      arguments: "storage migrate",
    }, output as never)
    assert.match(commandText(output), /unsupported on this platform/i)
    assert.equal(pathCalls, 0)
    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true })
    await f.cleanup()
  }
})


test("a boundary write failure after the marker leaves a retryable marker-only state", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    const migrations = await prepareMigrationsDirectory(f)
    const runtime = createRuntime(f.input, { storage: "auto" })
    const preview = await runtime.migrationPreview(f.owner)
    const originalUpdate = f.session.update
    let blocked = false
    ;(f.session as unknown as { update: typeof originalUpdate }).update = async (request) => {
      const result = await originalUpdate(request)
      if (!blocked) {
        blocked = true
        await chmod(migrations, 0o500)
      }
      return result
    }

    await assert.rejects(runtime.migrate(f.owner, preview.token), /mode|boundary|directory/i)
    const marker = (f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"]
    assert.equal(marker !== undefined, true)
    await assert.rejects(stat(join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))), /ENOENT/)

    await chmod(migrations, 0o700)
    assert.equal(await readMigrationBoundary(f.stateRoot, f.projectID, f.owner), undefined)
    const retry = await runtime.migrationPreview(f.owner)
    assert.equal(retry.token, preview.token)
    await runtime.migrate(f.owner, retry.token)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a marker write failure leaves native usable and no private evidence", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    const originalUpdate = f.session.update
    ;(f.session as unknown as { update: typeof originalUpdate }).update = async () => {
      throw new Error("injected marker write failure")
    }
    const runtime = createRuntime(f.input, { storage: "auto" })
    const preview = await runtime.migrationPreview(f.owner)
    await assert.rejects(runtime.migrate(f.owner, preview.token), /marker|failure/i)
    assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"], undefined)
    await assert.rejects(stat(join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))), /ENOENT/)
    assert.equal(await readMigrationBoundary(f.stateRoot, f.projectID, f.owner), undefined)
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)

    ;(f.session as unknown as { update: typeof originalUpdate }).update = originalUpdate
    await runtime.migrate(f.owner, preview.token)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})


test("a held storage preview rejects concurrent controls and idle-triggered work", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    await seedNative(f, snapshot)
    installParticipant(f)
    const registry: DebateRegistry = {
      participants: [
        { agent: "one", description: "one", model: "fake/one" },
        { agent: "two", description: "two", model: "fake/two" },
        { agent: "three", description: "three", model: "fake/three" },
      ],
      sets: { default: ["one", "two", "three"] },
      defaultSet: "default",
    }
    const hooks = await createAutomaticDebatePlugin(registry)(f.input)
    await hooks.config?.({
      permission: {},
      agent: { build: { mode: "primary", permission: {} } },
      command: {},
    } as never)

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { entered = resolve })
    let held = false
    const originalMessages = f.session.messages
    f.session.messages = (async (request: { path: { id: string } }) => {
      if (!held) {
        held = true
        entered()
        await gate
      }
      return originalMessages(request)
    }) as typeof f.session.messages

    const previewOutput = { parts: [] as unknown[] }
    const preview = hooks["command.execute.before"]!({
      command: "debate-auto",
      sessionID: f.owner.sessionID,
      arguments: "storage migrate",
    }, previewOutput as never)
    await blocked

    const controlOutput = { parts: [] as unknown[] }
    await hooks["command.execute.before"]!({
      command: "debate-auto",
      sessionID: f.owner.sessionID,
      arguments: "on",
    }, controlOutput as never)
    assert.match(commandText(controlOutput), /maintenance is in progress/i)
    await assert.rejects(hooks.event!({
      event: { type: "session.idle", properties: { sessionID: f.owner.sessionID } },
    } as never), /maintenance/i)

    release()
    await preview
    assert.match(commandText(previewOutput), /Automatic-debate migration preview/)
    await assert.rejects(stat(pluginRoot(f)), /ENOENT/)
  } finally {
    await f.cleanup()
  }
})


test("a poisoned private append can be retried in the same runtime after the obstruction is removed", async () => {
  const f = await privateStorageClient()
  try {
    const snapshot = pausedSnapshot(f.owner)
    const { head } = await seedNative(f, snapshot)
    installParticipant(f)
    await prepareMigrationsDirectory(f)
    const directory = join(pluginRoot(f), privateOwnerKey(f.projectID, f.owner))
    const runtime = createRuntime(f.input, { storage: "auto" })
    const preview = await runtime.migrationPreview(f.owner)
    const originalUpdate = f.session.update
    ;(f.session as unknown as { update: typeof originalUpdate }).update = async (request) => {
      const result = await originalUpdate(request)
      await mkdir(directory, { mode: 0o700 })
      await chmod(directory, 0o700)
      return result
    }

    await assert.rejects(runtime.migrate(f.owner, preview.token), /no committed revisions|failed|owner directory/i)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "prepared")
    assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"] !== undefined, true)

    await rm(directory, { recursive: true, force: true })
    ;(f.session as unknown as { update: typeof originalUpdate }).update = originalUpdate
    await runtime.migrate(f.owner, preview.token)
    assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed")
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")), ["0000000000000001.json"])
    assert.deepEqual(await runtime.load(f.owner), snapshot.state)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})


test("migration boundaries for multiple owners coexist and tolerate pending atomic writes", async () => {
  const f = await privateStorageClient()
  try {
    const ownerB: Owner = { ...f.owner, sessionID: "checkpoint-owner-b" }
    const sourceA: LegacySource = { storeID: "store-a", revision: 1, head: "head-a", digest: "a".repeat(64) }
    const sourceB: LegacySource = { storeID: "store-b", revision: 2, head: "head-b", digest: "b".repeat(64) }
    const boundaryA: MigrationBoundary = {
      kind: "opencode-debate-migration-boundary", version: 1, state: "committed",
      project: f.projectID, directory: f.owner.directory, owner: f.owner.sessionID, agent: f.owner.agent,
      source: sourceA, private: { revision: 1, digest: "c".repeat(64) }, token: "d".repeat(64),
    }
    const boundaryB: MigrationBoundary = {
      ...boundaryA, owner: ownerB.sessionID, source: sourceB,
      private: { revision: 1, digest: "e".repeat(64) }, token: "f".repeat(64),
    }
    await writeMigrationBoundary(f.stateRoot, boundaryA)
    await writeMigrationBoundary(f.stateRoot, boundaryB)
    assert.deepEqual(await readMigrationBoundary(f.stateRoot, f.projectID, f.owner), boundaryA)
    assert.deepEqual(await readMigrationBoundary(f.stateRoot, f.projectID, ownerB), boundaryB)

    const migrations = join(pluginRoot(f), "migrations")
    const pending = join(migrations, `.pending-${randomUUID()}`)
    await writeFile(pending, '{"payload":', { mode: 0o600 })
    await chmod(pending, 0o600)
    assert.deepEqual(await readMigrationBoundary(f.stateRoot, f.projectID, f.owner), boundaryA)
    await writeMigrationBoundary(f.stateRoot, boundaryA)
    assert.deepEqual(await readMigrationBoundary(f.stateRoot, f.projectID, f.owner), boundaryA)
    assert.equal((await readdir(migrations)).includes(pending.split("/").at(-1)!), true)

    const ownerC: Owner = { ...f.owner, sessionID: "checkpoint-owner-c" }
    const pendingC = join(migrations, `.pending-${randomUUID()}`)
    await writeFile(pendingC, '{"payload":', { mode: 0o600 })
    await chmod(pendingC, 0o600)
    assert.equal(await readMigrationBoundary(f.stateRoot, f.projectID, ownerC), undefined)
    const boundaryC: MigrationBoundary = {
      ...boundaryA, owner: ownerC.sessionID,
      private: { revision: 1, digest: "1".repeat(64) }, token: "2".repeat(64),
    }
    await writeMigrationBoundary(f.stateRoot, boundaryC)
    assert.deepEqual(await readMigrationBoundary(f.stateRoot, f.projectID, ownerC), boundaryC)

    const unknown = join(migrations, "unknown-entry")
    await writeFile(unknown, "unexpected", { mode: 0o600 })
    await chmod(unknown, 0o600)
    await assert.rejects(readMigrationBoundary(f.stateRoot, f.projectID, f.owner), /unknown entry/i)
  } finally {
    await f.cleanup()
  }
})

function busySnapshot(owner: Owner, status: "resolved" | "cancelled"): CheckpointSnapshot {
  const panelMember = status === "resolved" ? resolvedMember : cancelledMember
  const entries: RuntimeReceipt[] = [{
    kind: "member-bound", discussionID: `discussion-${status}`, member: structuredClone(panelMember),
    nonce: status === "resolved" ? nonceTwo : nonceThree, permission,
  }]
  if (status === "cancelled") {
    entries.push({ kind: "participant-fenced", sessionID: panelMember.sessionID })
    entries.push({ kind: "participant-stop-confirmed", sessionID: panelMember.sessionID })
  }
  return {
    state: {
      version: 1,
      discussions: [discussion(owner, status, {
        id: `discussion-${status}`,
        panel: [structuredClone(panelMember)],
        ...(status === "cancelled" ? { cancellation: { pendingSessionIDs: [], errors: [] } } : {}),
      })],
      outbox: [],
    },
    runtimeProof: { version: 1, entries },
  }
}

test("a busy resolved or cancelled member blocks migration even with confirmed cessation receipts", async () => {
  for (const status of ["resolved", "cancelled"] as const) {
    const f = await privateStorageClient()
    try {
      const snapshot = busySnapshot(f.owner, status)
      const { head } = await seedNative(f, snapshot)
      const panelMember = status === "resolved" ? resolvedMember : cancelledMember
      installPanelParticipant(f, panelMember, status === "resolved" ? nonceTwo : nonceThree, { busy: true })
      const runtime = createRuntime(f.input, { storage: "auto" })
      const token = migrationToken({ project: f.projectID, owner: f.owner, source: sourceOf(head) })

      await assert.rejects(runtime.migrationPreview(f.owner), /idle|quiescent|busy|not quiescent/i, status)
      await assert.rejects(runtime.migrate(f.owner, token), /idle|quiescent|busy|not quiescent/i, status)
      await assert.rejects(stat(pluginRoot(f)), /ENOENT/, status)
      assert.equal((f.sessions.get(head.storeID)!.metadata as Record<string, unknown>)["opencode-debate-migrated"], undefined, status)
      assert.equal(f.modelCalls(), 0, status)
    } finally {
      await f.cleanup()
    }
  }
})

test("an exact prepared retry recovers an empty or pending-only interrupted genesis", async () => {
  for (const genesis of ["empty", "pending"] as const) {
    const f = await privateStorageClient()
    try {
      const prepared = await prepareInterruptedMigration(f, { genesis })
      const runtime = createRuntime(f.input, { storage: "auto" })
      const preview = await runtime.migrationPreview(f.owner)
      assert.equal(preview.token, prepared.token, genesis)
      assert.deepEqual((await readdir(prepared.directory)).filter((name) => /^\d{16}\.json$/.test(name)), [], genesis)

      await runtime.migrate(f.owner, preview.token)
      assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "committed", genesis)
      const revisions = (await readdir(prepared.directory)).filter((name) => /^\d{16}\.json$/.test(name))
      assert.deepEqual(revisions, ["0000000000000001.json"], genesis)
      assert.deepEqual(await runtime.load(f.owner), prepared.snapshot.state, genesis)
      assert.equal(f.modelCalls(), 0, genesis)
    } finally {
      await f.cleanup()
    }
  }
})

test("ordinary new-owner recovery stays closed for interrupted genesis evidence", async () => {
  for (const genesis of ["empty", "pending"] as const) {
    const f = await privateStorageClient()
    try {
      const directory = await prepareOwnerDirectory(f)
      if (genesis === "pending") {
        const pending = join(directory, `.pending-0000000000000001-${randomUUID()}`)
        await writeFile(pending, '{"payload":', { mode: 0o600 })
        await chmod(pending, 0o600)
      }
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.load(f.owner), /no committed revisions|failed/i, genesis)
      await assert.rejects(runtime.save(f.owner, { version: 1, discussions: [], outbox: [] }), /no committed revisions|failed/i, genesis)
      await assert.rejects(runtime.migrationPreview(f.owner), /no committed revisions|failed/i, genesis)
      assert.deepEqual((await readdir(directory)).filter((name) => /^\d{16}\.json$/.test(name)), [], genesis)
      assert.equal(f.modelCalls(), 0, genesis)
    } finally {
      await f.cleanup()
    }
  }
})

test("interrupted-genesis recovery rejects wrong tokens, source changes, symlinks and unknown content", async () => {
  {
    const f = await privateStorageClient()
    try {
      const prepared = await prepareInterruptedMigration(f, { genesis: "empty" })
      const runtime = createRuntime(f.input, { storage: "auto" })
      await runtime.migrationPreview(f.owner)
      await assert.rejects(runtime.migrate(f.owner, "f".repeat(64)), /token/i)
      assert.equal((await readMigrationBoundary(f.stateRoot, f.projectID, f.owner))?.state, "prepared")
      assert.deepEqual((await readdir(prepared.directory)).filter((name) => /^\d{16}\.json$/.test(name)), [])
    } finally {
      await f.cleanup()
    }
  }
  {
    const f = await privateStorageClient()
    try {
      const prepared = await prepareInterruptedMigration(f, { genesis: "empty", changeSource: true })
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.migrationPreview(f.owner), /source changed|token/i)
      assert.deepEqual((await readdir(prepared.directory)).filter((name) => /^\d{16}\.json$/.test(name)), [])
    } finally {
      await f.cleanup()
    }
  }
  for (const genesis of ["unknown", "symlink", "pending-symlink"] as const) {
    const f = await privateStorageClient()
    try {
      const prepared = await prepareInterruptedMigration(f, { genesis })
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.migrationPreview(f.owner), /unknown|filename|symbolic|file type|directory/i, genesis)
      assert.deepEqual((await readdir(prepared.directory).catch(() => [])).filter((name) => /^\d{16}\.json$/.test(name)), [], genesis)
    } finally {
      await f.cleanup()
    }
  }
})

test("a pending revision other than the interrupted genesis is not recovered", async () => {
  const f = await privateStorageClient()
  try {
    const prepared = await prepareInterruptedMigration(f, { genesis: "pending-v2" })
    const runtime = createRuntime(f.input, { storage: "auto" })
    await assert.rejects(runtime.migrationPreview(f.owner), /genesis|pending revision/i)
    assert.deepEqual((await readdir(prepared.directory)).filter((name) => /^\d{16}\.json$/.test(name)), [])
  } finally {
    await f.cleanup()
  }
})

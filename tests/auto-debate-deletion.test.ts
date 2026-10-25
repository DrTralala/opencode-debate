import assert from "node:assert/strict"
import { link, mkdir, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import { createManager } from "../src/auto-debate/manager.ts"
import { createRuntime } from "../src/auto-debate/opencode.ts"
import { createAutomaticDebatePlugin } from "../src/auto-debate/plugin.ts"
import {
  migrationBoundaryPath,
  openPrivateStore,
  privateOwnerKey,
  writeMigrationBoundary,
} from "../src/auto-debate/private-store.ts"
import { selectStorageBackend } from "../src/auto-debate/storage.ts"
import type { DebateRegistry } from "../src/participants.ts"
import type {
  CheckpointSnapshot,
  ConversationState,
  Discussion,
  MigrationBoundary,
  NativeMigrationMarker,
  Owner,
  PanelMember,
  RuntimeReceipt,
} from "../src/auto-debate/types.ts"
import { privateStorageClient } from "./fixtures/private-storage-client.ts"

type Fixture = Awaited<ReturnType<typeof privateStorageClient>>

const initial: ConversationState = { version: 1, discussions: [], outbox: [] }
const initialSnapshot: CheckpointSnapshot = { state: initial }
const member: PanelMember = {
  participant: { agent: "one", description: "one", model: "fake/one" },
  sessionID: "child-one",
  runtimeAgent: "one",
}
const permission = [{ permission: "*", pattern: "*", action: "deny" as const }]

const registry: DebateRegistry = {
  participants: ["one", "two", "three"].map((agent) => ({
    agent, description: agent, model: `fake/${agent}`,
  })),
  sets: { default: ["one", "two", "three"] },
  defaultSet: "default",
}

function ownerStorePath(f: Fixture, owner: Owner): string {
  return join(f.stateRoot, "opencode-debate", "auto-debate", "v2", privateOwnerKey(f.projectID, owner))
}

async function ownerExists(f: Fixture, owner: Owner, project = f.projectID): Promise<boolean> {
  try {
    await stat(join(f.stateRoot, "opencode-debate", "auto-debate", "v2", privateOwnerKey(project, owner)))
    return true
  } catch {
    return false
  }
}

function addSession(f: Fixture, owner: Owner): void {
  const template = structuredClone(f.sessions.get(f.owner.sessionID)!) as Record<string, unknown>
  f.sessions.set(owner.sessionID, { ...template, id: owner.sessionID, agent: owner.agent,
    directory: owner.directory, projectID: f.projectID })
}

async function seedPrivate(f: Fixture, snapshot: CheckpointSnapshot = initialSnapshot, owner: Owner = f.owner): Promise<void> {
  const store = await openPrivateStore({ stateRoot: f.stateRoot, project: f.projectID, owner })
  await store.append({ revision: 0, digest: null }, snapshot)
  await store.close()
}

function discussion(owner: Owner, status: Discussion["status"], overrides: Partial<Discussion> = {}): Discussion {
  return {
    id: `discussion-${status}`,
    owner,
    config: { enabled: true, maxRounds: 3, persistTranscripts: false },
    brief: {
      question: "private question", objective: "private objective", facts: [],
      assumptions: [], constraints: [], alternatives: [], uncertainty: "private uncertainty",
      neededOutcome: "private outcome",
    },
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

function unsafeSnapshots(owner: Owner): { name: string; snapshot: CheckpointSnapshot }[] {
  const bound: RuntimeReceipt = {
    kind: "member-bound", discussionID: "discussion-running", member: structuredClone(member),
    nonce: "a".repeat(32), permission,
  }
  const openStart: RuntimeReceipt = {
    kind: "participant-start-open", sessionID: "child-one", messageID: "start-one",
    discussionID: "discussion-running", generation: 1, cycle: 1, textDigest: "b".repeat(64),
  }
  return [
    {
      name: "running discussion with an open participant start",
      snapshot: {
        state: { version: 1, discussions: [discussion(owner, "running")], outbox: [] },
        runtimeProof: { version: 1, entries: [bound, openStart] },
      },
    },
    {
      name: "resolved discussion without runtime proof",
      snapshot: { state: { version: 1, discussions: [discussion(owner, "resolved")], outbox: [] } },
    },
    {
      name: "resolved discussion with a pending outbox item",
      snapshot: {
        state: {
          version: 1,
          discussions: [discussion(owner, "resolved")],
          outbox: [{ id: "outbox-pending", discussionID: "discussion-resolved", cycle: 1, state: "pending" }],
        },
        runtimeProof: { version: 1, entries: [{
          kind: "member-bound", discussionID: "discussion-resolved", member: structuredClone(member),
          nonce: "c".repeat(32), permission,
        }] },
      },
    },
    {
      name: "cancelled discussion with pending containment",
      snapshot: {
        state: {
          version: 1,
          discussions: [discussion(owner, "cancelled", {
            cancellation: { pendingSessionIDs: ["child-one"], errors: [] },
          })],
          outbox: [],
        },
        runtimeProof: { version: 1, entries: [{
          kind: "member-bound", discussionID: "discussion-cancelled", member: structuredClone(member),
          nonce: "d".repeat(32), permission,
        }] },
      },
    },
    {
      name: "paused discussion without confirmed containment",
      snapshot: pausedUnconfirmedSnapshot(owner),
    },
  ]
}

function pausedUnconfirmedSnapshot(owner: Owner): CheckpointSnapshot {
  return {
    state: { version: 1, discussions: [discussion(owner, "paused")], outbox: [] },
    runtimeProof: { version: 1, entries: [{
      kind: "member-bound", discussionID: "discussion-paused", member: structuredClone(member),
      nonce: "e".repeat(32), permission,
    }] },
  }
}

function confirmedContainmentSnapshot(owner: Owner): CheckpointSnapshot {
  return {
    state: { version: 1, discussions: [discussion(owner, "paused")], outbox: [] },
    runtimeProof: { version: 1, entries: [
      { kind: "member-bound", discussionID: "discussion-paused", member: structuredClone(member),
        nonce: "f".repeat(32), permission },
      { kind: "participant-fenced", sessionID: member.sessionID },
      { kind: "participant-stop-confirmed", sessionID: member.sessionID },
    ] },
  }
}

test("confirmed parent deletion removes only that owner's private store through manager.withMaintenance", async () => {
  const f = await privateStorageClient()
  const runtime = createRuntime(f.input, { storage: "auto" })
  const manager = createManager({
    runtime,
    registry,
    canonicalise: (raw) => JSON.stringify({ turn: raw }),
    checkpoint: async () => {},
    id: () => "deletion-discussion",
  })
  try {
    const first = { ...f.owner, sessionID: "parent-a" }
    const second = { ...f.owner, sessionID: "parent-b" }
    addSession(f, first)
    addSession(f, second)
    await runtime.save(first, initial)
    await runtime.save(second, initial)
    assert.deepEqual(await runtime.load(first), initial)
    f.sessions.delete(first.sessionID)

    await manager.withMaintenance(first, () => runtime.maintenance.reconcileDeletedOwner(first.sessionID))
    assert.equal(await ownerExists(f, first), false)
    assert.equal(await ownerExists(f, second), true)
    assert.deepEqual(await createRuntime(f.input, { storage: "auto" }).load(second), initial)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await manager.dispose()
    await f.cleanup()
  }
})

test("confirmed parent deletion removes an unloaded safe private store", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner, sessionID: "parent-unloaded" }
    addSession(f, owner)
    await seedPrivate(f, initialSnapshot, owner)
    f.sessions.delete(owner.sessionID)

    await createRuntime(f.input, { storage: "auto" }).maintenance.reconcileDeletedOwner(owner.sessionID)
    assert.equal(await ownerExists(f, owner), false)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("startup reconciliation removes a missed safe parent store and leaves other scopes untouched", async () => {
  const f = await privateStorageClient()
  try {
    const victim = { ...f.owner, sessionID: "parent-missed-event" }
    addSession(f, victim)
    await createRuntime(f.input, { storage: "auto" }).save(victim, initial)
    f.sessions.delete(victim.sessionID)

    const otherDirectory: Owner = { sessionID: "other-directory", agent: "build", directory: "/other-directory" }
    const otherProject: Owner = { sessionID: "other-project", agent: "build", directory: f.owner.directory }
    await seedPrivate(f, initialSnapshot, otherDirectory)
    const otherStore = await openPrivateStore({ stateRoot: f.stateRoot, project: "other-project", owner: otherProject })
    await otherStore.append({ revision: 0, digest: null }, initialSnapshot)
    await otherStore.close()
    const sentinel = join(f.stateRoot, "outside-sentinel")
    await writeFile(sentinel, "retain", { mode: 0o600 })

    await createRuntime(f.input, { storage: "auto" }).maintenance.reconcileOrphanedStores()
    assert.equal(await ownerExists(f, victim), false)
    assert.equal(await ownerExists(f, otherDirectory), true)
    assert.equal(await ownerExists(f, otherProject, "other-project"), true)
    assert.equal((await stat(sentinel)).isFile(), true)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

const unsafeOwner: Owner = { sessionID: "unsafe-owner", agent: "build", directory: "/unsafe-directory" }

test("startup reconciliation completes a safely interrupted boundary-only cleanup", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    const boundary: MigrationBoundary = {
      kind: "opencode-debate-migration-boundary",
      version: 1,
      state: "committed",
      project: f.projectID,
      directory: owner.directory,
      owner: owner.sessionID,
      agent: owner.agent,
      source: { storeID: "native-source", revision: 1, head: "head", digest: "a".repeat(64) },
      private: { revision: 1, digest: "b".repeat(64) },
      token: "c".repeat(64),
    }
    await writeMigrationBoundary(f.stateRoot, boundary)
    f.sessions.delete(owner.sessionID)

    await createRuntime(f.input, { storage: "auto" }).maintenance.reconcileOrphanedStores()
    await assert.rejects(stat(migrationBoundaryPath(f.stateRoot, f.projectID, owner)), /ENOENT/)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a missing parent with unresolved private evidence is retained and reported", async () => {
  for (const scenario of unsafeSnapshots(unsafeOwner)) {
    const f = await privateStorageClient()
    try {
      const owner = { ...f.owner }
      scenario.snapshot = rewriteOwner(scenario.snapshot, owner)
      addSession(f, owner)
      await seedPrivate(f, scenario.snapshot, owner)
      f.sessions.delete(owner.sessionID)
      const runtime = createRuntime(f.input, { storage: "auto" })

      await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
      assert.equal(await ownerExists(f, owner), true, scenario.name)
      const status = await runtime.maintenance.status(owner)
      assert.ok(status.issues.length > 0, scenario.name)
      for (const issue of status.issues) {
        assert.equal(issue.includes("private question"), false, scenario.name)
        assert.equal(issue.includes(owner.sessionID), false, scenario.name)
      }
      assert.equal(f.modelCalls(), 0, scenario.name)
    } finally {
      await f.cleanup()
    }
  }
})

function rewriteOwner(snapshot: CheckpointSnapshot, owner: Owner): CheckpointSnapshot {
  const state = structuredClone(snapshot.state)
  for (const item of state.discussions) {
    item.owner = owner
    item.panel = item.panel.map((panelMember) => structuredClone(panelMember))
  }
  return { ...structuredClone(snapshot), state }
}

test("a loaded paused owner is retained when tombstoning prevents containment persistence", async () => {
  const f = await privateStorageClient()
  const runtime = createRuntime(f.input, { storage: "auto" })
  const manager = createManager({
    runtime,
    registry,
    canonicalise: (raw) => JSON.stringify({ turn: raw }),
    checkpoint: async () => {},
    id: () => "deletion-loaded-paused",
  })
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, pausedUnconfirmedSnapshot(owner), owner)
    assert.equal((await manager.status(owner)).length, 1)
    f.sessions.delete(owner.sessionID)

    runtime.noteOwnerDeleted(owner.sessionID)
    await manager.onDeleted(owner.sessionID)
    await manager.withMaintenance(owner, () =>
      runtime.maintenance.reconcileDeletedOwner(owner.sessionID))

    assert.equal(await ownerExists(f, owner), true)
    const status = await runtime.maintenance.status(owner)
    assert.ok(status.issues.length > 0)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await manager.dispose()
    await f.cleanup()
  }
})

test("a paused owner with confirmed stop evidence remains removable", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, confirmedContainmentSnapshot(owner), owner)
    f.sessions.delete(owner.sessionID)

    await createRuntime(f.input, { storage: "auto" }).maintenance.reconcileDeletedOwner(owner.sessionID)
    assert.equal(await ownerExists(f, owner), false)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a no-head owner directory is retained as evidence instead of erased", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, initialSnapshot, owner)
    const directory = ownerStorePath(f, owner)
    const revision = (await readdir(directory)).find((name) => /^\d{16}\.json$/.test(name))!
    await unlink(join(directory, revision))
    const pending = join(directory, `.pending-0000000000000001-${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}`)
    await writeFile(pending, '{"payload":', { mode: 0o600 })
    f.sessions.delete(owner.sessionID)
    const runtime = createRuntime(f.input, { storage: "auto" })

    await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
    assert.equal(await ownerExists(f, owner), true)
    assert.equal((await stat(pending)).isFile(), true)
    const status = await runtime.maintenance.status(owner)
    assert.ok(status.issues.length > 0)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a no-head owner with a complete boundary is retained by startup reconciliation", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    const boundary: MigrationBoundary = {
      kind: "opencode-debate-migration-boundary",
      version: 1,
      state: "committed",
      project: f.projectID,
      directory: owner.directory,
      owner: owner.sessionID,
      agent: owner.agent,
      source: { storeID: "native-source", revision: 1, head: "head", digest: "a".repeat(64) },
      private: { revision: 1, digest: "b".repeat(64) },
      token: "c".repeat(64),
    }
    await writeMigrationBoundary(f.stateRoot, boundary)
    const directory = ownerStorePath(f, owner)
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    f.sessions.delete(owner.sessionID)
    const runtime = createRuntime(f.input, { storage: "auto" })

    await runtime.maintenance.reconcileOrphanedStores()
    assert.equal(await ownerExists(f, owner), true)
    assert.equal((await stat(migrationBoundaryPath(f.stateRoot, f.projectID, owner))).isFile(), true)
    const status = await runtime.maintenance.status(owner)
    assert.ok(status.issues.length > 0)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("a missing parent is not proven by absent data or an empty child listing", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, initialSnapshot, owner)
    f.sessions.delete(owner.sessionID)
    const originalGet = f.session.get
    ;(f.session as unknown as { get: typeof originalGet }).get = async () => ({ data: undefined }) as never
    const runtime = createRuntime(f.input, { storage: "auto" })

    await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
    assert.equal(await ownerExists(f, owner), true)
    assert.deepEqual(await f.session.children({ path: { id: owner.sessionID } }), { data: [] })
    const status = await runtime.maintenance.status(owner)
    assert.ok(status.issues.length > 0)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("deleting a child session never removes the parent private store", async () => {
  const f = await privateStorageClient()
  try {
    const child: Owner = { ...f.owner, sessionID: "child-deleted" }
    addSession(f, child)
    await seedPrivate(f, initialSnapshot, f.owner)
    f.sessions.delete(child.sessionID)

    await createRuntime(f.input, { storage: "auto" }).maintenance.reconcileDeletedOwner(child.sessionID)
    assert.equal(await ownerExists(f, f.owner), true)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("403, 500, timeout and unavailable parent lookups retain the store and report an issue", async () => {
  const scenarios: { name: string; lookup: () => Promise<unknown> | unknown }[] = [
    { name: "403", lookup: () => ({ error: { name: "ForbiddenError" }, response: new Response(null, { status: 403 }) }) },
    { name: "500", lookup: () => ({ error: { name: "InternalServerError" }, response: new Response(null, { status: 500 }) }) },
    { name: "timeout", lookup: () => { throw new Error("request timed out") } },
    { name: "unavailable", lookup: () => ({ error: { name: "ServiceUnavailable" } }) },
  ]
  for (const scenario of scenarios) {
    const f = await privateStorageClient()
    try {
      const owner = { ...f.owner }
      addSession(f, owner)
      await seedPrivate(f, initialSnapshot, owner)
      f.sessions.delete(owner.sessionID)
      const originalGet = f.session.get
      ;(f.session as unknown as { get: typeof originalGet }).get = async () => scenario.lookup() as never
      const runtime = createRuntime(f.input, { storage: "auto" })

      await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
      assert.equal(await ownerExists(f, owner), true, scenario.name)
      const status = await runtime.maintenance.status(owner)
      assert.ok(status.issues.length > 0, scenario.name)
      assert.equal(f.modelCalls(), 0, scenario.name)
    } finally {
      await f.cleanup()
    }
  }
})

test("symlinked entries, hard-linked revisions and unexpected files are retained", async () => {
  const mutations: { name: string; mutate: (f: Fixture, directory: string) => Promise<void> }[] = [
    {
      name: "symlinked entry",
      mutate: async (f, directory) => {
        const revision = (await readdir(directory)).find((name) => /^\d{16}\.json$/.test(name))!
        await symlink(join(directory, revision), join(directory, "0000000000000002.json"))
        assert.equal(f.modelCalls(), 0)
      },
    },
    {
      name: "hard-linked revision",
      mutate: async (f, directory) => {
        const revision = (await readdir(directory)).find((name) => /^\d{16}\.json$/.test(name))!
        await link(join(directory, revision), join(f.stateRoot, "hard-link-sentinel"))
      },
    },
    {
      name: "unexpected owner entry",
      mutate: async (_f, directory) => {
        await writeFile(join(directory, "unexpected-entry"), "retain", { mode: 0o600 })
      },
    },
  ]
  for (const scenario of mutations) {
    const f = await privateStorageClient()
    try {
      const owner = { ...f.owner }
      addSession(f, owner)
      await seedPrivate(f, initialSnapshot, owner)
      await scenario.mutate(f, ownerStorePath(f, owner))
      f.sessions.delete(owner.sessionID)
      const runtime = createRuntime(f.input, { storage: "auto" })

      await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
      assert.equal(await ownerExists(f, owner), true, scenario.name)
      const status = await runtime.maintenance.status(owner)
      assert.ok(status.issues.length > 0, scenario.name)
      if (scenario.name === "hard-linked revision") {
        assert.equal((await stat(join(f.stateRoot, "hard-link-sentinel"))).nlink, 2)
      }
    } finally {
      await f.cleanup()
    }
  }
})

test("non-Linux performs no scan or deletion and still rejects a native migration marker", async () => {
  const f = await privateStorageClient()
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, initialSnapshot, owner)
    f.sessions.delete(owner.sessionID)
    const runtime = createRuntime(f.input, { storage: "auto" })
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
    await runtime.maintenance.reconcileOrphanedStores()
    assert.equal(await ownerExists(f, owner), true)

    const marker: NativeMigrationMarker = {
      kind: "opencode-debate-migrated", version: 1, privateOwnerKey: "a".repeat(64),
      source: { storeID: "native-child", revision: 1, head: "head", digest: "b".repeat(64) },
      private: { revision: 1, digest: "c".repeat(64) }, token: "d".repeat(64),
    }
    assert.deepEqual(selectStorageBackend("win32", {
      native: {
        storeID: "native-child", revision: 1, head: "head", digest: "b".repeat(64),
        snapshot: initialSnapshot, migration: marker,
      },
    }), { kind: "conflict", reason: "linux-migration-marker" })
  } finally {
    Object.defineProperty(process, "platform", descriptor)
    await f.cleanup()
  }
})

test("the plugin session.deleted hook reconciles an unloaded safe owner without activation or model work", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, initialSnapshot, owner)
    f.sessions.delete(owner.sessionID)
    const hooks = await createAutomaticDebatePlugin(registry)(f.input)
    try {
      await hooks.event?.({ event: {
        type: "session.deleted",
        properties: { info: { id: owner.sessionID } },
      } } as never)
      assert.equal(await ownerExists(f, owner), false)
      assert.equal(f.modelCalls(), 0)
      assert.equal(f.calls.some((call) => call.method === "create"), false)
    } finally {
      await hooks.dispose?.()
    }
  } finally {
    await f.cleanup()
  }
})

test("a migrated private store is not resurrected as native state after parent deletion", async () => {
  const f = await privateStorageClient()
  try {
    const owner = { ...f.owner }
    addSession(f, owner)
    await seedPrivate(f, initialSnapshot, owner)
    f.sessions.delete(owner.sessionID)
    const runtime = createRuntime(f.input, { storage: "auto" })
    await runtime.maintenance.reconcileDeletedOwner(owner.sessionID)
    assert.equal(await ownerExists(f, owner), false)

    await assert.rejects(runtime.save(owner, initial), /owner session|failed|no data/i)
    assert.equal(await ownerExists(f, owner), false)
    assert.equal(f.calls.some((call) => call.method === "create"), false)
  } finally {
    await f.cleanup()
  }
})

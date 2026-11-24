import assert from "node:assert/strict"
import { chmod, link, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "node:test"
import type { ToolContext } from "@opencode-ai/plugin"
import { createCheckpointStore, type CurrentInvocation } from "../src/auto-debate/checkpoint.ts"
import { createRuntime } from "../src/auto-debate/opencode.ts"
import { privateOwnerKey } from "../src/auto-debate/private-store.ts"
import { selectStorageBackend } from "../src/auto-debate/storage.ts"
import { parseConversationState } from "../src/auto-debate/validation.ts"
import type { NativeMigrationMarker, Owner } from "../src/auto-debate/types.ts"
import { privateStorageClient } from "./fixtures/private-storage-client.ts"

type Fixture = Awaited<ReturnType<typeof privateStorageClient>>
const emptyState = { version: 1 as const, discussions: [] as never[], outbox: [] as never[] }

function pluginRoot(f: Fixture): string {
  return join(f.stateRoot, "opencode-debate")
}

function ownerDirectory(f: Fixture, owner: Owner = f.owner): string {
  return join(pluginRoot(f), privateOwnerKey(f.projectID, owner))
}

async function privateChain(f: Fixture): Promise<string> {
  let current = f.stateRoot
  for (const component of ["opencode-debate"]) {
    current = join(current, component)
    await mkdir(current, { mode: 0o700 })
    await chmod(current, 0o700)
  }
  return current
}

async function revisionPayload(f: Fixture, owner: Owner = f.owner, revision = 1) {
  const text = await readFile(join(ownerDirectory(f, owner), `${String(revision).padStart(16, "0")}.json`), "utf8")
  return JSON.parse((JSON.parse(text) as { payload: string }).payload) as Record<string, unknown>
}

function currentInvocation(f: Fixture, args: Record<string, unknown>, suffix: string) {
  const messageID = `native-assistant-${suffix}`
  const callID = `native-call-${suffix}`
  const part = {
    id: `native-part-${suffix}`,
    sessionID: f.owner.sessionID,
    messageID,
    type: "tool",
    tool: "auto_debate",
    callID,
    state: { status: "running", input: args, time: { start: 2 } },
  }
  const history = f.histories.get(f.owner.sessionID) ?? []
  history.push({
    info: { id: messageID, sessionID: f.owner.sessionID, role: "assistant", agent: f.owner.agent,
      parentID: "native-user", time: { created: 1 } },
    parts: [part],
  })
  f.histories.set(f.owner.sessionID, history)
  const context = {
    sessionID: f.owner.sessionID,
    agent: f.owner.agent,
    directory: f.owner.directory,
    worktree: f.owner.directory,
    messageID,
    callID,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  } as unknown as ToolContext
  return { context, messageID, callID }
}

function finishRefusal(f: Fixture, invocation: ReturnType<typeof currentInvocation>): void {
  const message = f.histories.get(f.owner.sessionID)!
    .find((entry) => (entry.info as Record<string, unknown>).id === invocation.messageID)!
  ;(message.info as Record<string, unknown>).time = { created: 1, completed: 4 }
  const part = (message.parts as Record<string, unknown>[])[0]
  part.state = { ...(part.state as Record<string, unknown>), status: "error",
    error: "The user rejected permission to use this specific tool call.", time: { start: 2, end: 3 } }
}

test("a new Linux owner stores state privately with no checkpoint child", async () => {
  const f = await privateStorageClient()
  try {
    const runtime = createRuntime(f.input, { storage: "auto" })
    assert.equal(await runtime.load(f.owner), undefined)
    const initial = { version: 1 as const, discussions: [], outbox: [] }
    await runtime.save(f.owner, initial)
    assert.deepEqual(await runtime.load(f.owner), initial)
    assert.equal(f.sessions.size, 1, "only the parent session exists")
    assert.equal(f.calls.some((call) => call.method === "create"), false,
      "no native checkpoint child may be created for a new Linux owner")
    assert.equal(f.modelCalls(), 0)
    assert.ok((await readdir(f.stateRoot, { recursive: true })).some((path) =>
      path.startsWith("opencode-debate/") && path.endsWith("0000000000000001.json")))
  } finally {
    await f.cleanup()
  }
})

test("auto mode does not discover or alter the old v2 private store for the same owner", async () => {
  const f = await privateStorageClient()
  try {
    const oldDirectory = join(pluginRoot(f), "auto-debate", "v2", privateOwnerKey(f.projectID, f.owner))
    await mkdir(oldDirectory, { recursive: true, mode: 0o700 })
    const oldRevision = join(oldDirectory, "0000000000000001.json")
    const contents = "old private state is not a fallback"
    await writeFile(oldRevision, contents, { mode: 0o600 })

    const runtime = createRuntime(f.input, { storage: "auto" })
    assert.equal(await runtime.load(f.owner), undefined)
    assert.equal(await readFile(oldRevision, "utf8"), contents)
    assert.deepEqual(await readdir(oldDirectory), ["0000000000000001.json"])
    assert.equal(f.calls.some((call) => call.method === "create"), false)
    assert.equal(f.modelCalls(), 0)
  } finally {
    await f.cleanup()
  }
})

test("Linux auto mode rejects a missing API state path instead of creating a native store", async () => {
  const f = await privateStorageClient()
  try {
    f.input.client.path.get = async () => ({ error: { name: "Unavailable" } }) as never
    const runtime = createRuntime(f.input, { storage: "auto" })
    await assert.rejects(runtime.load(f.owner), /state path|unavailable/i)
    await assert.rejects(runtime.save(f.owner, emptyState), /state path|unavailable/i)
    assert.equal(f.calls.some((call) => call.method === "create"), false)
  } finally {
    await f.cleanup()
  }
})

test("an existing native owner stays native in auto mode without creating private storage", async () => {
  const f = await privateStorageClient()
  try {
    await createRuntime(f.input, { storage: "native" }).save(f.owner, emptyState)
    const runtime = createRuntime(f.input, { storage: "auto" })
    assert.deepEqual(await runtime.load(f.owner), emptyState)
    assert.equal((await readdir(f.stateRoot, { recursive: true })).some((path) =>
      path === "opencode-debate" || path.startsWith("opencode-debate/")), false)
  } finally {
    await f.cleanup()
  }
})

test("Linux auto mode rejects every unsafe private path without native creation", async () => {
  const scenarios: {
    name: string
    prepare: (f: Fixture) => Promise<void>
    pattern: RegExp
  }[] = [
    {
      name: "relative state path",
      prepare: async (f) => {
        f.input.client.path.get = async () => ({ data: { state: "relative/state" } }) as never
      },
      pattern: /state path|absolute|unavailable/i,
    },
    {
      name: "file state path",
      prepare: async (f) => {
        const file = join(f.stateRoot, "state-file")
        await writeFile(file, "not a directory")
        f.input.client.path.get = async () => ({ data: { state: file } }) as never
      },
      pattern: /unreadable|directory|state path|unsafe/i,
    },
    {
      name: "symlinked plugin root",
      prepare: async (f) => {
        const target = join(f.stateRoot, "target")
        await mkdir(target, { mode: 0o700 })
        await symlink(target, join(f.stateRoot, "opencode-debate"), "dir")
      },
      pattern: /directory|symbolic|unsafe|real/i,
    },
    {
      name: "owner directory mode is not 0700",
      prepare: async (f) => {
        await privateChain(f)
        await mkdir(ownerDirectory(f), { mode: 0o755 })
        await chmod(ownerDirectory(f), 0o755)
      },
      pattern: /mode|directory/i,
    },
    {
      name: "revision mode is not 0600",
      prepare: async (f) => {
        await privateChain(f)
        await mkdir(ownerDirectory(f), { mode: 0o700 })
        const revision = join(ownerDirectory(f), "0000000000000001.json")
        await writeFile(revision, "{}", { mode: 0o644 })
        await chmod(revision, 0o644)
      },
      pattern: /mode|file|0600/i,
    },
    {
      name: "revision has multiple hard links",
      prepare: async (f) => {
        await privateChain(f)
        await mkdir(ownerDirectory(f), { mode: 0o700 })
        const revision = join(ownerDirectory(f), "0000000000000001.json")
        await writeFile(revision, "{}", { mode: 0o600 })
        await chmod(revision, 0o600)
        await link(revision, join(f.stateRoot, "revision-hard-link"))
      },
      pattern: /link|multiple/i,
    },
    {
      name: "unknown owner-directory entry",
      prepare: async (f) => {
        await privateChain(f)
        await mkdir(ownerDirectory(f), { mode: 0o700 })
        const unknown = join(ownerDirectory(f), "unknown-entry")
        await writeFile(unknown, "{}", { mode: 0o600 })
        await chmod(unknown, 0o600)
      },
      pattern: /filename|unknown|entry|invalid/i,
    },
  ]

  for (const scenario of scenarios) {
    const f = await privateStorageClient()
    try {
      await scenario.prepare(f)
      const runtime = createRuntime(f.input, { storage: "auto" })
      await assert.rejects(runtime.load(f.owner), scenario.pattern, scenario.name)
      await assert.rejects(runtime.save(f.owner, emptyState), scenario.pattern, scenario.name)
      assert.equal(f.calls.some((call) => call.method === "create"), false, scenario.name)
    } finally {
      await f.cleanup()
    }
  }
})

test("the backend selection preserves native compatibility and fails closed on markers or mixed state", () => {
  const snapshot = { state: { version: 1 as const, discussions: [], outbox: [] } }
  const source = { storeID: "native-store", revision: 2, head: "msg-head", digest: "a".repeat(64) }
  const nativeHead = { ...source, snapshot }
  const marker: NativeMigrationMarker = {
    kind: "opencode-debate-migrated", version: 1, privateOwnerKey: "b".repeat(64), source,
    private: { revision: 1, digest: "c".repeat(64) }, token: "d".repeat(64),
  }
  const markedNative = { ...nativeHead, migration: marker }
  const privateHead = { revision: 1, digest: "c".repeat(64), snapshot }

  assert.deepEqual(selectStorageBackend("win32", { native: nativeHead }), { kind: "native" })
  assert.deepEqual(selectStorageBackend("win32", { native: markedNative }), {
    kind: "conflict", reason: "linux-migration-marker",
  })
  assert.deepEqual(selectStorageBackend("win32", { private: privateHead }), { kind: "native" })

  assert.deepEqual(selectStorageBackend("linux", {}), { kind: "new-private" })
  assert.deepEqual(selectStorageBackend("linux", { native: nativeHead }), { kind: "native" })
  assert.deepEqual(selectStorageBackend("linux", { native: markedNative }), {
    kind: "conflict", reason: "linux-migration-marker",
  })
  assert.deepEqual(selectStorageBackend("linux", { private: privateHead }), { kind: "private" })
  assert.deepEqual(selectStorageBackend("linux", { native: nativeHead, private: privateHead }), {
    kind: "conflict", reason: "native-and-private",
  })
})


test("migration-marker-only renamed native children fail closed instead of disappearing", async () => {
  for (const binding of ["missing", "corrupt"] as const) {
    const f = await privateStorageClient()
    try {
      const id = `marker-only-${binding}`
      const source = { storeID: id, revision: 1, head: "native-head", digest: "a".repeat(64) }
      const marker: NativeMigrationMarker = {
        kind: "opencode-debate-migrated", version: 1, privateOwnerKey: privateOwnerKey(f.projectID, f.owner),
        source, private: { revision: 1, digest: "b".repeat(64) }, token: "c".repeat(64),
      }
      const metadata: Record<string, unknown> = { "opencode-debate-migrated": marker }
      if (binding === "corrupt") metadata["opencode-debate-checkpoint-store"] = { kind: "opencode-debate-store", version: 1 }
      f.sessions.set(id, {
        id, parentID: f.owner.sessionID, projectID: f.projectID, directory: f.owner.directory,
        title: "Renamed ordinary research", agent: f.owner.agent,
        model: { providerID: "fake", id: "fake-model" }, permission: [], metadata,
      })
      f.histories.set(id, [])

      const store = createCheckpointStore(f.input, parseConversationState)
      await assert.rejects(store.probe(f.owner), /binding|marker|corrupt|missing/i, binding)
      await assert.rejects(store.inspect(f.owner), /binding|marker|corrupt|missing/i, binding)
      await assert.rejects(createRuntime(f.input, { storage: "native" }).load(f.owner),
        /binding|marker|corrupt|missing/i, binding)
      await assert.rejects(createRuntime(f.input, { storage: "auto" }).load(f.owner),
        /binding|marker|corrupt|missing/i, binding)
      assert.deepEqual(selectStorageBackend("win32", {
        native: { ...source, snapshot: { state: emptyState }, migration: marker },
      }), { kind: "conflict", reason: "linux-migration-marker" })
    } finally {
      await f.cleanup()
    }
  }
})

test("a host-witnessed first invocation is admitted into absent-native inspection and private save", async () => {
  const f = await privateStorageClient()
  try {
    const runtime = createRuntime(f.input, { storage: "auto" })
    const invocation = currentInvocation(f, { action: "start" }, "admitted")
    runtime.noteToolInvocation({ tool: "auto_debate", sessionID: f.owner.sessionID, callID: invocation.callID })
    await runtime.admitToolInvocation(f.owner, invocation.context)

    assert.equal(f.calls.some((call) => call.method === "create"), false)
    const payload = await revisionPayload(f)
    assert.deepEqual((payload as { runtimeProof: { entries: unknown[] } }).runtimeProof.entries[0], {
      kind: "owner-invocation-admitted",
      messageID: invocation.messageID,
      callID: invocation.callID,
      partID: `native-part-admitted`,
    })
    assert.deepEqual(await runtime.load(f.owner), emptyState)

    f.histories.get(f.owner.sessionID)!.push({
      info: { id: "prior-work", sessionID: f.owner.sessionID, role: "assistant", agent: f.owner.agent,
        parentID: "native-user", time: { created: 9, completed: 10 } },
      parts: [{ id: "prior-part", sessionID: f.owner.sessionID, messageID: "prior-work",
        type: "text", text: "opencode-debate/checkpoint/prior" }],
    })
    assert.deepEqual(await createRuntime(f.input, { storage: "auto" }).load(f.owner), emptyState,
      "an existing private owner uses only native probe, never absence evidence")
  } finally {
    await f.cleanup()
  }
})

test("a retained host refusal followed by approval still allows the first private save", async () => {
  const f = await privateStorageClient()
  try {
    const runtime = createRuntime(f.input, { storage: "auto" })
    const args = { action: "start" }
    const refused = currentInvocation(f, args, "refused")
    runtime.noteToolInvocation({ tool: "auto_debate", sessionID: f.owner.sessionID, callID: refused.callID })
    await runtime.refuseToolInvocation(f.owner, refused.context)
    finishRefusal(f, refused)

    const approved = currentInvocation(f, args, "approved")
    runtime.noteToolInvocation({ tool: "auto_debate", sessionID: f.owner.sessionID, callID: approved.callID })
    await runtime.admitToolInvocation(f.owner, approved.context)

    assert.equal(f.calls.some((call) => call.method === "create"), false)
    assert.equal(f.modelCalls(), 0)
    const payload = await revisionPayload(f)
    assert.deepEqual((payload as { runtimeProof: { entries: unknown[] } }).runtimeProof.entries, [{
      kind: "owner-invocation-admitted",
      messageID: approved.messageID,
      callID: approved.callID,
      partID: "native-part-approved",
    }])
    assert.deepEqual(await runtime.load(f.owner), emptyState)
  } finally {
    await f.cleanup()
  }
})


test("a private owner rejects an independent writer's advance instead of saving stale state", async () => {
  const f = await privateStorageClient()
  try {
    const first = createRuntime(f.input, { storage: "auto" })
    assert.equal(await first.load(f.owner), undefined)
    await first.save(f.owner, emptyState)

    const second = createRuntime(f.input, { storage: "auto" })
    assert.deepEqual(await second.load(f.owner), emptyState)
    await second.save(f.owner, { ...emptyState, override: true })

    await assert.rejects(first.save(f.owner, { ...emptyState, override: false }), /independent|stale|changed/i)
    assert.deepEqual(await second.load(f.owner), { ...emptyState, override: true })
    assert.equal(f.calls.some((call) => call.method === "create"), false)
  } finally {
    await f.cleanup()
  }
})

test("a first private save rejects state that appeared after an absent load", async () => {
  const f = await privateStorageClient()
  try {
    const waiting = createRuntime(f.input, { storage: "auto" })
    assert.equal(await waiting.load(f.owner), undefined)

    const writer = createRuntime(f.input, { storage: "auto" })
    assert.equal(await writer.load(f.owner), undefined)
    await writer.save(f.owner, emptyState)

    await assert.rejects(waiting.save(f.owner, { ...emptyState, override: true }), /changed|first private|private state/i)
    assert.deepEqual(await writer.load(f.owner), emptyState)
    assert.equal(f.calls.some((call) => call.method === "create"), false)
  } finally {
    await f.cleanup()
  }
})


test("native probe and inspect are read-only and expose the verified head", async () => {
  const f = await privateStorageClient()
  try {
    const store = createCheckpointStore(f.input, parseConversationState)
    assert.equal(await store.probe(f.owner), undefined)
    assert.equal(await store.inspect(f.owner), undefined)
    assert.equal(f.calls.some((call) => call.method === "create"), false)

    await store.save(f.owner, { state: emptyState },
      { agent: f.owner.agent, model: { providerID: "fake", modelID: "fake-model" } })
    const probe = await store.probe(f.owner)
    assert.equal(typeof probe?.storeID, "string")
    const head = await store.inspect(f.owner)
    assert.equal(head?.storeID, probe?.storeID)
    assert.equal(head?.revision, 1)
    assert.deepEqual(head?.snapshot.state, emptyState)
    assert.equal(f.calls.filter((call) => call.method === "create").length, 1)
    assert.equal(f.modelCalls(), 0)

    await store.probe(f.owner)
    await store.inspect(f.owner)
    assert.equal(f.calls.filter((call) => call.method === "create").length, 1,
      "probe/inspect must not create another native child")
  } finally {
    await f.cleanup()
  }
})

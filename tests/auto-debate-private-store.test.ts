import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  openPrivateStore,
  privateOwnerKey,
  privateStoreRoot,
  type StoreBoundary,
} from "../src/auto-debate/private-store.ts"
import type { CheckpointSnapshot, ConversationState, Owner, StorageBinding } from "../src/auto-debate/types.ts"

const project = "project-1"
const owner: Owner = { sessionID: "private-owner-1", agent: "build", directory: "/workspace/private-test" }
const initial: CheckpointSnapshot = { state: { version: 1, discussions: [], outbox: [] } }

function bindingFor(): StorageBinding {
  return {
    kind: "opencode-debate-storage",
    version: 1,
    project,
    directory: owner.directory,
    owner: owner.sessionID,
    agent: owner.agent,
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

async function withRoot<T>(run: (stateRoot: string) => Promise<T>): Promise<T> {
  const stateRoot = await mkdtemp(join(tmpdir(), "opencode-debate-private-store-"))
  try {
    return await run(stateRoot)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
}

function optionsFor(stateRoot: string, hooks?: { boundary?: (point: StoreBoundary) => Promise<void> }) {
  return { stateRoot, project, owner, ...(hooks === undefined ? {} : { hooks }) }
}

function ownerDirectoryFor(stateRoot: string): string {
  return join(privateStoreRoot(stateRoot), privateOwnerKey(project, owner))
}

function revisionPath(stateRoot: string, revision: number): string {
  return join(ownerDirectoryFor(stateRoot), `${String(revision).padStart(16, "0")}.json`)
}

async function seedRevisions(stateRoot: string, count: number): Promise<{ revision: number; digest: string }> {
  const store = await openPrivateStore(optionsFor(stateRoot))
  let head: { revision: number; digest: string } | undefined
  for (let revision = 1; revision <= count; revision += 1) {
    head = await store.append({ revision: head?.revision ?? 0, digest: head?.digest ?? null },
      { state: { version: 1, override: revision % 2 === 0, discussions: [], outbox: [] } })
  }
  await store.close()
  return head!
}

async function rewritePayload(path: string, mutate: (payload: Record<string, unknown>) => void): Promise<void> {
  const envelope = JSON.parse(await readFile(path, "utf8")) as { payload: string; digest: string }
  const payload = JSON.parse(envelope.payload) as Record<string, unknown>
  mutate(payload)
  const payloadText = JSON.stringify(payload)
  await writeFile(path, JSON.stringify({ payload: payloadText, digest: sha256(payloadText) }), "utf8")
}

async function fileNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort()
}

test("private store publishes, syncs, reads back and reloads one revision", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "opencode-debate-private-store-"))
  try {
    const options = { stateRoot, project, owner }
    const store = await openPrivateStore(options)
    assert.equal(await store.load(), undefined)
    const head = await store.append({ revision: 0, digest: null }, initial)
    assert.equal(head.revision, 1)
    assert.deepEqual(head.snapshot, initial)
    await store.close()

    const ownerDirectory = join(stateRoot, "opencode-debate", privateOwnerKey(project, owner))
    const revisionPath = join(ownerDirectory, "0000000000000001.json")
    assert.equal((await stat(ownerDirectory)).mode & 0o777, 0o700)
    assert.equal((await stat(revisionPath)).mode & 0o777, 0o600)
    assert.equal((await stat(revisionPath)).nlink, 1)
    assert.deepEqual(await readdir(ownerDirectory), ["0000000000000001.json"])

    const reopened = await openPrivateStore(options)
    assert.deepEqual((await reopened.load())?.snapshot, initial)
    await reopened.close()
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("queued append captures the caller snapshot and rejects a stale expected revision", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "opencode-debate-private-store-"))
  try {
    const store = await openPrivateStore({ stateRoot, project, owner })
    const input: CheckpointSnapshot = { state: { version: 1, override: false, discussions: [], outbox: [] } }
    const firstPromise = store.append({ revision: 0, digest: null }, input)
    input.state.override = true
    const first = await firstPromise
    assert.equal(first.snapshot.state.override, false)
    const second = await store.append({ revision: first.revision, digest: first.digest },
      { state: { version: 1, override: true, discussions: [], outbox: [] } })
    assert.equal(second.revision, 2)
    await assert.rejects(store.append({ revision: first.revision, digest: first.digest }, initial), /revision/i)
    assert.equal((await store.load())?.revision, 2)
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("paths and owner keys are deterministic and exclude the agent", () => {
  assert.equal(privateStoreRoot("/var/state"), join("/var/state", "opencode-debate"))
  assert.equal(privateOwnerKey(project, owner), privateOwnerKey(project, { ...owner, agent: "other" }))
  assert.notEqual(privateOwnerKey(project, owner), privateOwnerKey("project-2", owner))
  assert.match(privateOwnerKey(project, owner), /^[a-f0-9]{64}$/)
})

test("the old v2 tree is ignored and left untouched by new private state", async () => {
  await withRoot(async (stateRoot) => {
    const oldDirectory = join(stateRoot, "opencode-debate", "auto-debate", "v2", privateOwnerKey(project, owner))
    await mkdir(oldDirectory, { recursive: true, mode: 0o700 })
    const oldRevision = join(oldDirectory, "0000000000000001.json")
    const oldContents = "old v2 data must not be read or changed"
    await writeFile(oldRevision, oldContents, { mode: 0o600 })

    const store = await openPrivateStore(optionsFor(stateRoot))
    assert.equal(await store.load(), undefined)
    assert.equal((await store.append({ revision: 0, digest: null }, initial)).revision, 1)
    await store.close()

    assert.equal(await readFile(oldRevision, "utf8"), oldContents)
    assert.deepEqual(await fileNames(oldDirectory), ["0000000000000001.json"])
    assert.equal((await stat(join(stateRoot, "opencode-debate", privateOwnerKey(project, owner)))).isDirectory(), true)
  })
})

test("private storage refuses a non-Linux platform before touching the filesystem", async () => {
  const original = process.platform
  await withRoot(async (stateRoot) => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      await assert.rejects(openPrivateStore(optionsFor(stateRoot)), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, "Automatic-debate private storage is unsupported on win32")
        return true
      })
      await assert.rejects(readdir(join(stateRoot, "opencode-debate")), /ENOENT/)
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true })
    }
  })
})

test("committed revision mutations reject instead of returning the preceding head", async (t) => {
  await t.test("invalid JSON", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await writeFile(revisionPath(stateRoot, 2), '{"payload":', "utf8")
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /json/i)
      await store.close()
    })
  })

  await t.test("bad digest", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      const path = revisionPath(stateRoot, 2)
      const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
      envelope.digest = "0".repeat(64)
      await writeFile(path, JSON.stringify(envelope), "utf8")
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /digest/i)
      await store.close()
    })
  })

  for (const field of ["project", "directory", "owner", "agent"]) {
    await t.test(`altered binding ${field}`, async () => {
      await withRoot(async (stateRoot) => {
        await seedRevisions(stateRoot, 2)
        await rewritePayload(revisionPath(stateRoot, 2), (payload) => {
          const binding = payload.binding as Record<string, unknown>
          binding[field] = field === "directory" ? "/workspace/foreign" : `foreign-${field}`
        })
        const store = await openPrivateStore(optionsFor(stateRoot))
        await assert.rejects(store.load(), /binding/i)
        await store.close()
      })
    })
  }

  await t.test("missing interior revision", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 3)
      await unlink(revisionPath(stateRoot, 2))
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /missing|revision/i)
      await store.close()
    })
  })

  await t.test("duplicate revision", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await copyFile(revisionPath(stateRoot, 1), revisionPath(stateRoot, 2))
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /duplicate|revision/i)
      await store.close()
    })
  })

  await t.test("malformed final filename", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      const directory = ownerDirectoryFor(stateRoot)
      await copyFile(revisionPath(stateRoot, 1), join(directory, "000000000000000.json"))
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /filename/i)
      await store.close()
    })
  })

  await t.test("corrupt final tail", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await writeFile(revisionPath(stateRoot, 2), '{"payload":"unterminated', "utf8")
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /json/i)
      await store.close()
    })
  })

  await t.test("unknown file in the owner directory", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await writeFile(join(ownerDirectoryFor(stateRoot), "notes.txt"), "unexpected", { mode: 0o600 })
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /filename/i)
      await store.close()
    })
  })

  await t.test("wrong owner directory mode", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await chmod(ownerDirectoryFor(stateRoot), 0o755)
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /mode|permission/i)
      await store.close()
    })
  })

  await t.test("wrong committed file mode", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await chmod(revisionPath(stateRoot, 2), 0o644)
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /mode|permission/i)
      await store.close()
    })
  })

  await t.test("hard-linked committed file", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      await link(revisionPath(stateRoot, 2), join(stateRoot, "hard-link"))
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /hard link|nlink/i)
      await store.close()
    })
  })

  await t.test("symlinked owner directory", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      const directory = ownerDirectoryFor(stateRoot)
      const target = `${directory}-target`
      await rename(directory, target)
      await symlink(target, directory, "dir")
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /directory|type/i)
      await store.close()
    })
  })

  await t.test("symlinked committed file", async () => {
    await withRoot(async (stateRoot) => {
      await seedRevisions(stateRoot, 2)
      const path = revisionPath(stateRoot, 2)
      const target = `${path}-target`
      await rename(path, target)
      await symlink(target, path)
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /file|type/i)
      await store.close()
    })
  })
})

test("complete and unparseable pending files are retained but never become state", async () => {
  await withRoot(async (stateRoot) => {
    await seedRevisions(stateRoot, 2)
    const directory = ownerDirectoryFor(stateRoot)
    const completeName = `.pending-0000000000000003-${randomUUID()}`
    const brokenName = `.pending-0000000000000004-${randomUUID()}`
    await writeFile(join(directory, completeName), await readFile(revisionPath(stateRoot, 2), "utf8"), { mode: 0o600 })
    await writeFile(join(directory, brokenName), "not json", { mode: 0o600 })

    const store = await openPrivateStore(optionsFor(stateRoot))
    assert.equal((await store.load())?.revision, 2)
    await store.close()

    const names = await fileNames(directory)
    assert.ok(names.includes(completeName))
    assert.ok(names.includes(brokenName))
  })
})

test("strict snapshot capture rejects non-JSON trees and poisons the instance", async (t) => {
  const bareState: ConversationState = { version: 1, discussions: [], outbox: [] }

  for (const [name, make] of [
    ["a bare ConversationState", () => bareState],
    ["a symbol key", () => {
      const state: Record<PropertyKey, unknown> = { version: 1, discussions: [], outbox: [] }
      state[Symbol("extra")] = true
      return { state }
    }],
    ["a sparse array", () => {
      const state: Record<string, unknown> = { version: 1, discussions: [], outbox: [] }
      const outbox = new Array(1)
      state.outbox = outbox
      return { state }
    }],
    ["an undefined array entry", () => ({ state: { version: 1, discussions: [], outbox: [undefined] } })],
    ["NaN", () => ({ state: { version: 1, discussions: [], outbox: [], extra: Number.NaN } })],
    ["Infinity", () => ({ state: { version: 1, discussions: [], outbox: [], extra: Number.POSITIVE_INFINITY } })],
    ["-0", () => ({ state: { version: 1, discussions: [], outbox: [], extra: -0 } })],
    ["an unknown undefined property", () => ({ state: { version: 1, discussions: [], outbox: [] }, extra: undefined })],
  ] as const) {
    await t.test(name, async () => {
      await withRoot(async (stateRoot) => {
        const store = await openPrivateStore(optionsFor(stateRoot))
        await assert.rejects(store.append({ revision: 0, digest: null }, make() as unknown as CheckpointSnapshot),
          /value|invalid|json|snapshot|checkpoint/i)
        await assert.rejects(store.append({ revision: 0, digest: null }, initial), /failed|closed/i)
        await store.close()
      })
    })
  }

  await t.test("getter-backed property is rejected without execution", async () => {
    await withRoot(async (stateRoot) => {
      let getterCalls = 0
      const state = { version: 1, discussions: [], outbox: [] } as Record<string, unknown>
      Object.defineProperty(state, "override", {
        get() {
          getterCalls += 1
          return false
        },
        enumerable: true,
        configurable: true,
      })
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.append({ revision: 0, digest: null }, { state } as unknown as CheckpointSnapshot),
        /value|invalid|accessor|snapshot|checkpoint/i)
      assert.equal(getterCalls, 0)
      await store.close()
    })
  })

  await t.test("toJSON is rejected without execution", async () => {
    await withRoot(async (stateRoot) => {
      let toJSONCalls = 0
      const state = {
        version: 1,
        discussions: [],
        outbox: [],
        toJSON() {
          toJSONCalls += 1
          return this
        },
      }
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.append({ revision: 0, digest: null }, { state } as unknown as CheckpointSnapshot),
        /value|invalid|json|snapshot|checkpoint/i)
      assert.equal(toJSONCalls, 0)
      await store.close()
    })
  })

  await t.test("declared optional undefined fields are omitted", async () => {
    await withRoot(async (stateRoot) => {
      const store = await openPrivateStore(optionsFor(stateRoot))
      const snapshot: CheckpointSnapshot = {
        state: { version: 1, override: undefined, discussions: [], outbox: [] },
        runtimeProof: undefined,
        legacyOutboxIDs: undefined,
      }
      const head = await store.append({ revision: 0, digest: null }, snapshot)
      assert.equal(Object.hasOwn(head.snapshot, "runtimeProof"), false)
      assert.equal(Object.hasOwn(head.snapshot, "legacyOutboxIDs"), false)
      assert.equal(Object.hasOwn(head.snapshot.state, "override"), false)
      await store.close()
    })
  })
})

test("the first queued failure prevents later queued appends from running", async () => {
  await withRoot(async (stateRoot) => {
    const store = await openPrivateStore(optionsFor(stateRoot))
    const first = store.append({ revision: 0, digest: null }, initial)
    const stale = store.append({ revision: 1, digest: "0".repeat(64) }, initial)
    const later = store.append({ revision: 1, digest: "0".repeat(64) }, initial)
    assert.equal((await first).revision, 1)
    await assert.rejects(stale, /revision/i)
    await assert.rejects(later, /failed/i)
    assert.equal((await store.load())?.revision, 1)
    await store.close()
  })
})

test("a failed load fences every append already queued behind it", async () => {
  await withRoot(async (stateRoot) => {
    const store = await openPrivateStore(optionsFor(stateRoot))
    const first = await store.append({ revision: 0, digest: null }, initial)
    const second = await store.append({ revision: first.revision, digest: first.digest },
      { state: { version: 1, override: true, discussions: [], outbox: [] } })
    assert.equal(second.revision, 2)

    const path = revisionPath(stateRoot, 2)
    const backup = await readFile(path)
    await writeFile(path, '{"payload":', "utf8")

    const load = store.load()
    const restored = load.catch((error: unknown) => {
      writeFileSync(path, backup)
      throw error
    })
    const queuedOne = store.append({ revision: second.revision, digest: second.digest }, initial)
    const queuedTwo = store.append({ revision: second.revision, digest: second.digest }, initial)

    await assert.rejects(restored, /json/i)
    const outcomes = await Promise.allSettled([queuedOne, queuedTwo])
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected")
      if (outcome.status === "rejected") assert.match(String(outcome.reason), /failed/i)
    }
    assert.deepEqual(await fileNames(ownerDirectoryFor(stateRoot)), [
      "0000000000000001.json",
      "0000000000000002.json",
    ])
    await store.close()
  })
})

test("an append admitted before later invalid input still completes", async () => {
  await withRoot(async (stateRoot) => {
    const store = await openPrivateStore(optionsFor(stateRoot))
    const admitted = store.append({ revision: 0, digest: null }, initial)
    const invalid = store.append({ revision: 0, digest: null },
      { version: 1, discussions: [], outbox: [] } as unknown as CheckpointSnapshot)
    await assert.rejects(invalid, /value/i)
    const head = await admitted
    assert.equal(head.revision, 1)
    await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial), /failed/i)
    assert.equal((await store.load())?.revision, 1)
    await store.close()
  })
})

test("an existing owner directory without a committed revision is not a new genesis", async (t) => {
  await t.test("empty owner directory", async () => {
    await withRoot(async (stateRoot) => {
      await mkdir(ownerDirectoryFor(stateRoot), { recursive: true, mode: 0o700 })
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /committed revisions/i)
      await assert.rejects(store.append({ revision: 0, digest: null }, initial), /committed revisions|failed/i)
      await store.close()
    })
  })

  await t.test("only a failed first pending file", async () => {
    await withRoot(async (stateRoot) => {
      const directory = ownerDirectoryFor(stateRoot)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, `.pending-0000000000000001-${randomUUID()}`), "{", { mode: 0o600 })
      const store = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(store.load(), /committed revisions/i)
      await assert.rejects(store.append({ revision: 0, digest: null }, initial), /committed revisions|failed/i)
      await store.close()
    })
  })

  await t.test("a first publication failure remains visible after restart", async () => {
    await withRoot(async (stateRoot) => {
      const store = await openPrivateStore(optionsFor(stateRoot, {
        boundary: async (point) => {
          if (point === "opened") throw new Error("injected first publication failure")
        },
      }))
      await assert.rejects(store.append({ revision: 0, digest: null }, initial), /boundary|injected/i)
      await store.close()

      const names = await fileNames(ownerDirectoryFor(stateRoot))
      assert.equal(names.length, 1)
      assert.match(names[0], /^\.pending-0000000000000001-/)

      const reopened = await openPrivateStore(optionsFor(stateRoot))
      await assert.rejects(reopened.load(), /committed revisions/i)
      await reopened.close()
    })
  })
})

test("high-water state rejects a lost suffix within one instance", async () => {
  await withRoot(async (stateRoot) => {
    const store = await openPrivateStore(optionsFor(stateRoot))
    let head = await store.append({ revision: 0, digest: null }, initial)
    head = await store.append({ revision: head.revision, digest: head.digest },
      { state: { version: 1, override: true, discussions: [], outbox: [] } })
    assert.equal(head.revision, 2)
    await unlink(revisionPath(stateRoot, 2))
    await assert.rejects(store.load(), /high-water|revision/i)
    await store.close()
  })
})

test("a fresh instance cannot detect whole-suffix loss by hashes alone", async () => {
  // This is the documented anti-rollback limitation: retained high-water only lives in memory.
  await withRoot(async (stateRoot) => {
    await seedRevisions(stateRoot, 2)
    await unlink(revisionPath(stateRoot, 2))
    const reopened = await openPrivateStore(optionsFor(stateRoot))
    assert.equal((await reopened.load())?.revision, 1)
    await reopened.close()
  })
})

test("crash boundaries before rename retain the pending file and the old head", async (t) => {
  for (const boundary of ["opened", "written", "file-synced", "closed"] as const) {
    await t.test(boundary, async () => {
      await withRoot(async (stateRoot) => {
        const head = await seedRevisions(stateRoot, 1)
        const store = await openPrivateStore(optionsFor(stateRoot, {
          boundary: async (point) => {
            if (point === boundary) throw new Error("injected crash")
          },
        }))
        await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial))
        await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial), /failed|closed/i)
        await store.close()

        const names = await fileNames(ownerDirectoryFor(stateRoot))
        assert.equal(names.filter((name) => name.startsWith(".pending-")).length, 1)
        assert.equal(names.includes("0000000000000002.json"), false)

        const reopened = await openPrivateStore(optionsFor(stateRoot))
        assert.equal((await reopened.load())?.revision, 1)
        await reopened.close()
      })
    })
  }
})

test("crash boundaries at or after rename leave a complete revision despite caller rejection", async (t) => {
  for (const boundary of ["renamed", "directory-synced", "verified"] as const) {
    await t.test(boundary, async () => {
      await withRoot(async (stateRoot) => {
        const head = await seedRevisions(stateRoot, 1)
        const store = await openPrivateStore(optionsFor(stateRoot, {
          boundary: async (point) => {
            if (point === boundary) throw new Error("injected crash")
          },
        }))
        await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial))
        await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial), /failed|closed/i)
        await store.close()

        const names = await fileNames(ownerDirectoryFor(stateRoot))
        assert.equal(names.filter((name) => name.startsWith(".pending-")).length, 0)
        assert.ok(names.includes("0000000000000002.json"))

        const reopened = await openPrivateStore(optionsFor(stateRoot))
        assert.equal((await reopened.load())?.revision, 2)
        await reopened.close()
      })
    })
  }
})

test("an injected read-back corruption rejects and poisons the instance", async () => {
  await withRoot(async (stateRoot) => {
    const head = await seedRevisions(stateRoot, 1)
    const store = await openPrivateStore(optionsFor(stateRoot, {
      boundary: async (point) => {
        if (point === "directory-synced") {
          await writeFile(revisionPath(stateRoot, 2), "corrupt", { mode: 0o600 })
        }
      },
    }))
    await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial), /json|corrupt/i)
    await assert.rejects(store.append({ revision: head.revision, digest: head.digest }, initial), /failed|closed/i)
    await store.close()

    const reopened = await openPrivateStore(optionsFor(stateRoot))
    await assert.rejects(reopened.load(), /json|corrupt/i)
    await reopened.close()
  })
})

test("compaction publishes a base, then removes superseded revisions", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "opencode-debate-private-store-"))
  try {
    const store = await openPrivateStore({ stateRoot, project, owner })
    let head = await store.append({ revision: 0, digest: null }, initial)
    head = await store.append({ revision: head.revision, digest: head.digest },
      { state: { version: 1, override: true, discussions: [], outbox: [] } })
    const base = await store.compact({ revision: head.revision, digest: head.digest }, head.snapshot)
    assert.equal(base.revision, 3)
    assert.equal(base.compaction?.throughRevision, 2)
    const entries = await readdir(store.directory)
    assert.deepEqual(entries, ["0000000000000003.json"])
    await store.close()
    const reopened = await openPrivateStore({ stateRoot, project, owner })
    assert.equal((await reopened.load())?.revision, 3)
    assert.equal((await reopened.load())?.snapshot.state.override, true)
    await reopened.close()
  } finally {
    await rm(stateRoot, { recursive: true, force: true })
  }
})

test("runtime proof prefixes cannot be removed by a later append", async () => {
  await withRoot(async (stateRoot) => {
    const proof = { version: 1 as const, entries: [] as const }
    const store = await openPrivateStore(optionsFor(stateRoot))
    const head = await store.append({ revision: 0, digest: null }, { state: initial.state, runtimeProof: proof })
    assert.deepEqual(head.snapshot.runtimeProof, proof)
    await store.close()

    const removal = await openPrivateStore(optionsFor(stateRoot))
    await assert.rejects(removal.append({ revision: head.revision, digest: head.digest }, initial), /prefix/i)
    await removal.close()

    const preserved = await openPrivateStore(optionsFor(stateRoot))
    const next = await preserved.append({ revision: head.revision, digest: head.digest },
      { state: initial.state, runtimeProof: proof })
    assert.equal(next.revision, 2)
    await preserved.close()
  })
})

test("compaction crash boundaries leave a selected base", async (t) => {
  for (const boundary of ["base-verified", "superseded-removed"] as const) {
    await t.test(boundary, async () => {
      await withRoot(async (stateRoot) => {
        let armed = false
        const store = await openPrivateStore(optionsFor(stateRoot, {
          boundary: async (point) => {
            if (armed && point === boundary) throw new Error("injected compaction crash")
          },
        }))
        let head = await store.append({ revision: 0, digest: null }, initial)
        head = await store.append({ revision: head.revision, digest: head.digest },
          { state: { version: 1, override: true, discussions: [], outbox: [] } })
        armed = true
        await assert.rejects(store.compact({ revision: head.revision, digest: head.digest }, head.snapshot))
        await store.close()

        const names = await fileNames(ownerDirectoryFor(stateRoot))
        if (boundary === "base-verified") {
          assert.deepEqual(names, [
            "0000000000000001.json",
            "0000000000000002.json",
            "0000000000000003.json",
          ])
        } else {
          assert.deepEqual(names, ["0000000000000003.json"])
        }

        const reopened = await openPrivateStore(optionsFor(stateRoot))
        const loaded = await reopened.load()
        assert.equal(loaded?.revision, 3)
        assert.equal(loaded?.compaction?.throughRevision, 2)
        assert.equal(loaded?.snapshot.state.override, true)
        await reopened.close()
      })
    })
  }
})

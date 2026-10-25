import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openPrivateStore } from "../../src/auto-debate/private-store.ts"

const stateRoot = await mkdtemp(join(tmpdir(), "opencode-debate-smoke-"))
const owner = { sessionID: "smoke-parent", agent: "build", directory: "/smoke-project" }
try {
  const store = await openPrivateStore({ stateRoot, project: "smoke-project", owner })
  const first = await store.append({ revision: 0, digest: null }, { state: { version: 1, discussions: [], outbox: [] } })
  const second = await store.append({ revision: first.revision, digest: first.digest },
    { state: { version: 1, override: true, discussions: [], outbox: [] } })
  assert.equal(second.revision, 2)
  await assert.rejects(store.append({ revision: first.revision, digest: first.digest },
    { state: { version: 1, discussions: [], outbox: [] } }), /revision/i)
  assert.ok((await readdir(store.directory)).includes("0000000000000002.json"))
  await store.close()
  console.log("private-storage-smoke: ok")
} finally {
  await rm(stateRoot, { recursive: true, force: true })
}

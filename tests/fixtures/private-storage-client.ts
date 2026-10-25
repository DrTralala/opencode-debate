import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkpointClient } from "./checkpoint-client.ts"

export async function privateStorageClient() {
  const fixture = checkpointClient()
  const stateRoot = await mkdtemp(join(tmpdir(), "opencode-debate-storage-"))
  const path = {
    get: async () => ({ data: {
      state: stateRoot,
      config: join(stateRoot, "config"),
      worktree: fixture.owner.directory,
      directory: fixture.owner.directory,
    } }),
  }
  ;(fixture.input.client as unknown as { path: typeof path }).path = path
  const originalGet = fixture.session.get
  ;(fixture.session as unknown as { get: typeof originalGet }).get = async (request) => {
    if (!fixture.sessions.has(request.path.id)) {
      return { error: { name: "NotFoundError" }, response: new Response(null, { status: 404 }) } as never
    }
    return originalGet(request)
  }
  return {
    ...fixture,
    projectID: "checkpoint-project",
    stateRoot,
    cleanup: async () => { await rm(stateRoot, { recursive: true, force: true }) },
  }
}

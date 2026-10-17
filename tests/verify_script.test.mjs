import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const sentinel = "OPENCODE_DEBATE_VERIFY_OUTPUT_SENTINEL_7f3a"

test("verification prints captured Node test output when the suite fails", (t) => {
  const shims = mkdtempSync(join(tmpdir(), "opencode-debate-verify-shim-"))
  t.after(() => rmSync(shims, { recursive: true, force: true }))

  const nodeShim = join(shims, "node")
  writeFileSync(
    nodeShim,
    `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "--test" ]; then
    printf '%s\\n' "${sentinel}"
    exit 1
  fi
done
exec "$VERIFY_REAL_NODE" "$@"
`,
  )
  chmodSync(nodeShim, 0o755)

  const pythonShim = join(shims, "python3")
  writeFileSync(pythonShim, "#!/bin/sh\nexit 0\n")
  chmodSync(pythonShim, 0o755)

  const result = spawnSync("sh", ["scripts/verify.sh"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${shims}:${process.env.PATH ?? ""}`,
      VERIFY_REAL_NODE: process.execPath,
    },
  })

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stderr, new RegExp(sentinel))
  assert.match(result.stderr, /test suite failed/)
})

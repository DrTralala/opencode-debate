import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("package checker accepts only the release allowlist", () => {
  const script = fileURLToPath(new URL("../scripts/check_package.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /package contents: ok/)
})

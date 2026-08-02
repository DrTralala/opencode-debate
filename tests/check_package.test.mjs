import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import * as packageChecker from "../scripts/check_package.mjs"

test("package checker reads npm 12 object reports", () => {
  assert.equal(typeof packageChecker.packageFilesFromReport, "function")
  assert.deepEqual(packageChecker.packageFilesFromReport({
    "opencode-debate": {
      files: [{ path: "README.md" }, { path: "package.json" }],
    },
  }), ["README.md", "package.json"])
})

test("package checker accepts only the release allowlist", () => {
  const script = fileURLToPath(new URL("../scripts/check_package.mjs", import.meta.url))
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /package contents: ok/)
})

test("package metadata ships runtime data files and declares the YAML runtime dependency", () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url))
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))

  assert.equal(packageJson.files.includes("config.yaml"), true)
  assert.equal(packageJson.files.includes("scripts/format_response.py"), true)
  assert.equal(packageJson.dependencies.yaml, "2.9.0")
})

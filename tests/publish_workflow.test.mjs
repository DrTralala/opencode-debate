import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

test("publish workflow is release-only and uses OIDC", () => {
  const path = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url))
  assert.ok(existsSync(path), "publish.yml must exist")
  const source = readFileSync(path, "utf8")
  assert.match(source, /release:\n\s+types: \[published\]/)
  assert.doesNotMatch(source, /push:\n\s+tags:/)
  assert.match(source, /id-token: write/)
  assert.match(source, /contents: read/)
  assert.match(source, /github\.event\.release\.tag_name/)
  assert.match(source, /release\.prerelease/)
  assert.match(source, /npm publish/)
  assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN/)
})

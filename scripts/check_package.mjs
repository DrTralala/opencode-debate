#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const expected = [
  "LICENSE",
  "README.md",
  "config.yaml",
  "index.ts",
  "package.json",
  "scripts/format_response.py",
  "scripts/generate_html.py",
  "scripts/publish_transcript.py",
  "scripts/render_markdown.mjs",
  "src/auto-debate/checkpoint.ts",
  "src/auto-debate/manager.ts",
  "src/auto-debate/opencode.ts",
  "src/auto-debate/plugin.ts",
  "src/auto-debate/prompts.ts",
  "src/auto-debate/state.ts",
  "src/auto-debate/transcripts.ts",
  "src/auto-debate/types.ts",
  "src/debate.ts",
  "src/mini-debate/arguments.ts",
  "src/mini-debate/lifecycle.ts",
  "src/mini-debate/plugin.ts",
  "src/mini-debate/prompts.ts",
  "src/mini-debate/protocol.ts",
  "src/participants.ts",
  "src/response-formatter.ts",
  "src/task-dispatch-guard.ts",
  "src/transcript-persistence.ts",
].sort()

export function assertPackageFiles(paths) {
  assert.deepEqual([...paths].sort(), expected)
}

export function packageFilesFromReport(report) {
  const entries = Array.isArray(report) ? report : Object.values(report)
  assert.equal(entries.length, 1)
  assert.ok(Array.isArray(entries[0].files))
  return entries[0].files.map((file) => file.path)
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  })
  const report = JSON.parse(output)
  assertPackageFiles(packageFilesFromReport(report))
  process.stdout.write("package contents: ok\n")
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) main()

#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"

const expected = [
  "LICENSE",
  "README.md",
  "index.ts",
  "package.json",
  "scripts/generate_html.py",
  "scripts/render_markdown.mjs",
  "src/debate.ts",
  "src/participants.ts",
].sort()

export function assertPackageFiles(paths) {
  assert.deepEqual([...paths].sort(), expected)
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
  })
  const report = JSON.parse(output)
  assert.equal(report.length, 1)
  assertPackageFiles(report[0].files.map((file) => file.path))
  process.stdout.write("package contents: ok\n")
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) main()

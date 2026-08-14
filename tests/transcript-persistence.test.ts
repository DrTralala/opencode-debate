import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  PERSIST_DEBATE_TRANSCRIPT_TOOL,
  createTranscriptPersistenceTool,
  persistDebateTranscript,
} from "../src/transcript-persistence.ts"

const VALID_MARKDOWN = `# Debate: Persistence

**Date:** <timestamp>
**Topic:** Compare persistence strategies
**Maximum rounds:** 1
**Rounds completed:** 1
**Participants:** Participant 1 (debate-one), Participant 2 (debate-two), Participant 3 (debate-three)
**Consensus reached:** No

---

## Round 1

### Participant 1 (debate-one)

First turn.

### Participant 2 (debate-two)

Second turn.

### Participant 3 (debate-three)

Third turn.

---

## Final Synthesis

Final synthesis.
`

function temporaryProject(): string {
  return mkdtempSync(join(tmpdir(), "debate-persistence-"))
}

function options(directory: string) {
  return {
    directory,
    now: () => new Date("2026-08-13T23:59:59.999Z"),
  }
}

function markdownFiles(directory: string): string[] {
  const debates = join(directory, "docs", "debates")
  return existsSync(debates)
    ? readdirSync(debates).filter((name) => name.endsWith(".md")).sort()
    : []
}

function runPersistenceWorker(
  moduleUrl: string,
  directory: string,
  barrier: string,
): Promise<{ markdownPath: string; htmlPath?: string }> {
  const source = `
    const { persistDebateTranscript } = await import(${JSON.stringify(moduleUrl)})
    const result = persistDebateTranscript(${JSON.stringify(VALID_MARKDOWN)}, "workers", {
      directory: ${JSON.stringify(directory)},
      publicationBarrier: ${JSON.stringify(barrier)},
      now: () => new Date("2026-08-13T23:59:59.999Z"),
    })
    process.stdout.write(JSON.stringify(result))
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", source],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as ChildProcessWithoutNullStreams
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000)
    child.on("error", (error: Error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout)
      if (code !== 0) {
        reject(new Error(`worker failed (${code ?? signal}): ${stderr || stdout}`))
        return
      }
      resolve(JSON.parse(stdout) as { markdownPath: string; htmlPath?: string })
    })
  })
}

function runDirectorySwapAttacker(
  directory: string,
  outside: string,
  barrier: string,
): Promise<number> {
  const source = `
    const { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const deadline = Date.now() + 5000
    while (!existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() >= deadline) process.exit(2)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    while (!readFileSync(${JSON.stringify(barrier)}, "utf8").startsWith("ready\\n")) {
      if (Date.now() >= deadline) process.exit(3)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    renameSync(join(${JSON.stringify(directory)}, "docs", "debates"), join(${JSON.stringify(directory)}, "docs", "debates-real"))
    symlinkSync(${JSON.stringify(outside)}, join(${JSON.stringify(directory)}, "docs", "debates"), "dir")
    writeFileSync(${JSON.stringify(barrier)}, "release\\n")
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 7000)
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

function runOutsideDirectoryMoveAttacker(
  directory: string,
  outside: string,
  barrier: string,
): Promise<number> {
  const source = `
    const { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const deadline = Date.now() + 5000
    while (!existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() >= deadline) process.exit(2)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    while (!readFileSync(${JSON.stringify(barrier)}, "utf8").startsWith("ready\\n")) {
      if (Date.now() >= deadline) process.exit(3)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    renameSync(join(${JSON.stringify(directory)}, "docs", "debates"), join(${JSON.stringify(outside)}, "moved-debates"))
    symlinkSync(${JSON.stringify(outside)}, join(${JSON.stringify(directory)}, "docs", "debates"), "dir")
    writeFileSync(${JSON.stringify(barrier)}, "release\\n")
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 7000)
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

function runTemporaryFileSwapAttacker(
  directory: string,
  outside: string,
  barrier: string,
): Promise<number> {
  const source = `
    const { existsSync, readdirSync, readFileSync, unlinkSync, symlinkSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const deadline = Date.now() + 5000
    while (!existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() >= deadline) process.exit(2)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    let temporary
    while (temporary === undefined) {
      const candidates = readdirSync(join(${JSON.stringify(directory)}, "docs", "debates"))
        .filter((name) => name.endsWith(".tmp"))
      temporary = candidates[0]
      if (temporary === undefined) {
        if (Date.now() >= deadline) process.exit(3)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    const temporaryPath = join(${JSON.stringify(directory)}, "docs", "debates", temporary)
    unlinkSync(temporaryPath)
    symlinkSync(${JSON.stringify(outside)}, temporaryPath)
    writeFileSync(${JSON.stringify(barrier)}, "release\\n")
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 7000)
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

function runGenerationDirectorySwapAttacker(
  directory: string,
  outside: string,
  barrier: string,
): Promise<number> {
  const source = `
    const { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const deadline = Date.now() + 5000
    while (!existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() >= deadline) process.exit(2)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    while (!readFileSync(${JSON.stringify(barrier)}, "utf8").startsWith("ready\\n")) {
      if (Date.now() >= deadline) process.exit(3)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    renameSync(join(${JSON.stringify(directory)}, "docs", "debates"), join(${JSON.stringify(outside)}, "moved-debates"))
    symlinkSync(${JSON.stringify(outside)}, join(${JSON.stringify(directory)}, "docs", "debates"), "dir")
    writeFileSync(${JSON.stringify(barrier)}, "release\\n")
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 7000)
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

function runPostPublicationDirectorySwapAttacker(
  directory: string,
  outside: string,
  barrier: string,
): Promise<number> {
  const source = `
    const { existsSync, readFileSync, renameSync, symlinkSync, writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const deadline = Date.now() + 5000
    while (!existsSync(${JSON.stringify(barrier)})) {
      if (Date.now() >= deadline) process.exit(2)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    while (!readFileSync(${JSON.stringify(barrier)}, "utf8").startsWith("ready\\n")) {
      if (Date.now() >= deadline) process.exit(3)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    if (!existsSync(join(${JSON.stringify(directory)}, "docs", "debates", "2026-08-13-post-publication-race.html"))) process.exit(4)
    renameSync(join(${JSON.stringify(directory)}, "docs", "debates"), join(${JSON.stringify(outside)}, "moved-debates"))
    symlinkSync(${JSON.stringify(outside)}, join(${JSON.stringify(directory)}, "docs", "debates"), "dir")
    writeFileSync(${JSON.stringify(barrier)}, "release\\n")
  `
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", source],
      { stdio: "ignore" },
    )
    const timeout = setTimeout(() => child.kill("SIGKILL"), 7000)
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve(code ?? 1)
    })
  })
}

test("persistence computes a UTC date and replaces the transcript date placeholder", () => {
  const directory = temporaryProject()
  try {
    const result = persistDebateTranscript(VALID_MARKDOWN, "utc-date", options(directory))

    assert.match(result.markdownPath, /docs\/debates\/2026-08-13-utc-date\.md$/)
    assert.match(readFileSync(result.markdownPath, "utf8"), /^\*\*Date:\*\* 2026-08-13$/m)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("persistence rejects invalid slugs before creating transcript files", () => {
  const directory = temporaryProject()
  try {
    assert.throws(
      () => persistDebateTranscript(VALID_MARKDOWN, "../escape", options(directory)),
      /slug/i,
    )
    assert.deepEqual(markdownFiles(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("persistence rejects a date placeholder embedded in another Markdown line", () => {
  const directory = temporaryProject()
  try {
    assert.throws(
      () => persistDebateTranscript(VALID_MARKDOWN.replace("**Date:** <timestamp>", "Date: <timestamp>"), "invalid-date", options(directory)),
      /date placeholder/i,
    )
    assert.deepEqual(markdownFiles(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("persistence rejects a placeholder in a turn when Date metadata is already populated", () => {
  const directory = temporaryProject()
  try {
    const misplaced = VALID_MARKDOWN
      .replace("**Date:** <timestamp>", "**Date:** 2026-08-12")
      .replace("First turn.", "First turn.\n\n  **Date:** <timestamp>")

    assert.throws(
      () => persistDebateTranscript(misplaced, "misplaced-date", options(directory)),
      /date placeholder|Date/i,
    )
    assert.deepEqual(markdownFiles(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("persistence preserves literal timestamp text in a turn", () => {
  const directory = temporaryProject()
  try {
    const literal = VALID_MARKDOWN.replace(
      "First turn.",
      "First turn mentions the literal token <timestamp>.",
    )
    const result = persistDebateTranscript(literal, "literal-timestamp", options(directory))

    assert.match(readFileSync(result.markdownPath, "utf8"), /literal token <timestamp>/)
    assert.match(readFileSync(result.markdownPath, "utf8"), /^\*\*Date:\*\* 2026-08-13$/m)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("persistence rejects duplicate top-level Date metadata", () => {
  const directory = temporaryProject()
  try {
    const duplicate = VALID_MARKDOWN.replace(
      "**Date:** <timestamp>",
      "**Date:** <timestamp>\n**Date:** 2026-08-12",
    )

    assert.throws(
      () => persistDebateTranscript(duplicate, "duplicate-date", options(directory)),
      /Duplicate metadata: Date|Date/i,
    )
    assert.deepEqual(markdownFiles(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("persistence rejects a symlinked transcript directory", () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-outside-"))
  try {
    mkdirSync(join(directory, "docs"))
    writeFileSync(join(directory, "docs", "debates"), "")
    rmSync(join(directory, "docs", "debates"))
    symlinkSync(outside, join(directory, "docs", "debates"), "dir")

    assert.throws(
      () => persistDebateTranscript(VALID_MARKDOWN, "symlinked", options(directory)),
      /symlink|trusted|transcript directory/i,
    )
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("persistence rejects a symlinked docs directory", () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-docs-outside-"))
  try {
    symlinkSync(outside, join(directory, "docs"), "dir")

    assert.throws(
      () => persistDebateTranscript(VALID_MARKDOWN, "symlinked-docs", options(directory)),
      /symlink|trusted|transcript directory/i,
    )
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("publication rejects a moved transcript directory before returning a stale path", async () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-race-outside-"))
  const barrier = join(directory, "publication-barrier")
  const attacker = runDirectorySwapAttacker(directory, outside, barrier)
  const generationMarker = join(directory, "generation-called")
  const pythonWrapper = join(directory, "recording-python3")
  writeFileSync(
    pythonWrapper,
    `#!/bin/sh
if [ "$2" = "--validate-stdin" ]; then exec python3 "$@"; fi
touch "${generationMarker}"
exec python3 "$@"
`,
  )
  chmodSync(pythonWrapper, 0o755)
  try {
    assert.throws(
      () => persistDebateTranscript(VALID_MARKDOWN, "race", {
        ...options(directory),
        pythonExecutable: pythonWrapper,
        publicationBarrier: barrier,
      }),
      /canonical|directory|moved|symlink/i,
    )

    assert.equal(await attacker, 0)
    assert.deepEqual(readdirSync(outside), [])
    assert.deepEqual(
      readdirSync(join(directory, "docs", "debates-real")),
      [],
    )
    assert.equal(existsSync(generationMarker), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("publication rejects a transcript directory moved outside the project", async () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-outside-move-"))
  const movedOutside = join(outside, "moved-debates")
  const barrier = join(directory, "outside-publication-barrier")
  const attacker = runOutsideDirectoryMoveAttacker(directory, outside, barrier)
  const generationMarker = join(directory, "outside-generation-called")
  const pythonWrapper = join(directory, "outside-recording-python3")
  writeFileSync(
    pythonWrapper,
    `#!/bin/sh
if [ "$2" = "--validate-stdin" ]; then exec python3 "$@"; fi
touch "${generationMarker}"
exec python3 "$@"
`,
  )
  chmodSync(pythonWrapper, 0o755)
  let returnedPath: string | undefined
  try {
    assert.throws(
      () => {
        returnedPath = persistDebateTranscript(VALID_MARKDOWN, "outside-race", {
          ...options(directory),
          pythonExecutable: pythonWrapper,
          publicationBarrier: barrier,
        }).markdownPath
      },
      /canonical|directory|moved|symlink/i,
    )

    assert.equal(await attacker, 0)
    assert.equal(returnedPath, undefined)
    assert.equal(existsSync(generationMarker), false)
    assert.deepEqual(
      readdirSync(outside).filter((name) => name.endsWith(".md")),
      [],
    )
    assert.deepEqual(
      readdirSync(movedOutside).filter((name) => name.endsWith(".md")),
      [],
    )
    assert.deepEqual(
      readdirSync(movedOutside).filter((name) => name.endsWith(".tmp")),
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("publication links the original open inode when its temporary name is replaced", async () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-temp-outside-"))
  const attackerPayload = join(outside, "attacker.txt")
  const barrier = join(directory, "temporary-barrier")
  writeFileSync(attackerPayload, "attacker inode")
  const attacker = runTemporaryFileSwapAttacker(directory, attackerPayload, barrier)
  try {
    let result: ReturnType<typeof persistDebateTranscript> | undefined
    let failure: unknown
    try {
      result = persistDebateTranscript(VALID_MARKDOWN, "temporary-race", {
        ...options(directory),
        publicationBarrier: barrier,
      })
    } catch (error) {
      failure = error
    }

    assert.equal(await attacker, 0)
    if (result) {
      assert.equal(lstatSync(result.markdownPath).isSymbolicLink(), false)
      assert.equal(
        readFileSync(result.markdownPath, "utf8"),
        VALID_MARKDOWN.replace("<timestamp>", "2026-08-13"),
      )
    } else {
      assert.ok(failure instanceof Error)
      assert.deepEqual(markdownFiles(directory), [])
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("HTML generation fails closed when the published debates directory moves before generation", async () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-generation-outside-"))
  const barrier = join(directory, "generation-barrier")
  const attacker = runGenerationDirectorySwapAttacker(directory, outside, barrier)
  try {
    const result = persistDebateTranscript(VALID_MARKDOWN, "generation-race", {
      ...options(directory),
      generationBarrier: barrier,
    })

    assert.equal(await attacker, 0)
    assert.equal(result.htmlPath, undefined)
    assert.match(result.generationError ?? "", /symlink|directory|published|trusted/i)
    assert.deepEqual(
      readdirSync(join(outside, "moved-debates")).filter((name) => name.endsWith(".html")),
      [],
    )
    assert.deepEqual(
      readdirSync(outside).filter((name) => name.endsWith(".html")),
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("HTML generation removes owned output when debates moves after publication", async () => {
  const directory = temporaryProject()
  const outside = mkdtempSync(join(tmpdir(), "debate-persistence-post-publication-outside-"))
  const barrier = join(directory, "post-publication-generation-barrier")
  const attacker = runPostPublicationDirectorySwapAttacker(directory, outside, barrier)
  try {
    const result = persistDebateTranscript(VALID_MARKDOWN, "post-publication-race", {
      ...options(directory),
      postPublicationBarrier: barrier,
    })

    assert.equal(await attacker, 0)
    assert.equal(result.htmlPath, undefined)
    assert.match(result.generationError ?? "", /symlink|directory|published|trusted/i)
    assert.deepEqual(
      readdirSync(join(outside, "moved-debates")).filter((name) => name.endsWith(".html")),
      [],
    )
    assert.deepEqual(
      readdirSync(outside).filter((name) => name.endsWith(".html")),
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("persistence claims the base name and then -2 and -3 collision suffixes", () => {
  const directory = temporaryProject()
  try {
    const first = persistDebateTranscript(VALID_MARKDOWN, "collision", options(directory))
    const second = persistDebateTranscript(VALID_MARKDOWN, "collision", options(directory))
    const third = persistDebateTranscript(VALID_MARKDOWN, "collision", options(directory))

    assert.match(first.markdownPath, /2026-08-13-collision\.md$/)
    assert.match(second.markdownPath, /2026-08-13-collision-2\.md$/)
    assert.match(third.markdownPath, /2026-08-13-collision-3\.md$/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("concurrent persistence calls claim exclusive names", async () => {
  const directory = temporaryProject()
  try {
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        Promise.resolve().then(() =>
          persistDebateTranscript(VALID_MARKDOWN, "parallel", options(directory)),
        ),
      ),
    )

    assert.deepEqual(
      results.map(({ markdownPath }) => markdownPath).sort(),
      [
        join(directory, "docs", "debates", "2026-08-13-parallel-2.md"),
        join(directory, "docs", "debates", "2026-08-13-parallel-3.md"),
        join(directory, "docs", "debates", "2026-08-13-parallel.md"),
      ].sort(),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("separate persistence processes publish complete transcripts without clobbering", async () => {
  const directory = temporaryProject()
  const barrier = join(directory, "publish-barrier.txt")
  try {
    const moduleUrl = new URL("../src/transcript-persistence.ts", import.meta.url).href
    const results = await Promise.all([
      runPersistenceWorker(moduleUrl, directory, barrier),
      runPersistenceWorker(moduleUrl, directory, barrier),
    ])

    assert.equal(
      new Set(results.map(({ markdownPath }) => markdownPath)).size,
      2,
    )
    for (const result of results) {
      assert.equal(
        readFileSync(result.markdownPath, "utf8"),
        VALID_MARKDOWN.replace("<timestamp>", "2026-08-13"),
      )
    }
    assert.ok(
      readFileSync(barrier, "utf8").trim().split("\n").filter(Boolean).length >= 2,
    )
    assert.deepEqual(
      readdirSync(join(directory, "docs", "debates")).filter((name) => name.endsWith(".tmp")),
      [],
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("HTML generation receives the exact claimed Markdown path", () => {
  const directory = temporaryProject()
  try {
    const result = persistDebateTranscript(VALID_MARKDOWN, "exact-path", options(directory))

    assert.equal(result.htmlPath, result.markdownPath.replace(/\.md$/, ".html"))
    assert.equal(existsSync(result.htmlPath), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("HTML generation is invoked with the exact claimed path rather than --latest", () => {
  const directory = temporaryProject()
  const bin = join(directory, "recording-python3")
  const argumentsPath = join(directory, "arguments.txt")
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\n' "$@" > "${argumentsPath}"
if [ "$2" = "--validate-stdin" ]; then exit 0; fi
exit 0
`,
  )
  chmodSync(bin, 0o755)
  try {
    const result = persistDebateTranscript(VALID_MARKDOWN, "claimed-path", {
      ...options(directory),
      pythonExecutable: bin,
    })

     const args = readFileSync(argumentsPath, "utf8")
     assert.match(args, new RegExp(`^.*\\n${result.markdownPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n--publication-token\\n`))
    assert.doesNotMatch(args, /--latest/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("invalid canonical Markdown is rejected before any files are created", () => {
  const directory = temporaryProject()
  try {
    assert.throws(
      () => persistDebateTranscript(VALID_MARKDOWN.replace("Final synthesis.\n", ""), "invalid", options(directory)),
      /Final Synthesis|synthesis/i,
    )
    assert.deepEqual(markdownFiles(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("HTML generation failure preserves Markdown and reports a concise failure", () => {
  const directory = temporaryProject()
  const bin = join(directory, "fake-python3")
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    bin,
    "#!/bin/sh\nif [ \"$2\" = \"--validate-stdin\" ]; then exit 0; fi\nprintf '%s\\n' 'renderer unavailable' >&2\nexit 7\n",
  )
  chmodSync(bin, 0o755)
  try {
    const result = persistDebateTranscript(VALID_MARKDOWN, "html-failure", {
      ...options(directory),
      pythonExecutable: bin,
    })

    assert.equal(result.htmlPath, undefined)
    assert.match(result.generationError ?? "", /renderer unavailable/)
    assert.equal(existsSync(result.markdownPath), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("the coordinator persistence tool is registered with the required arguments", async () => {
  const persistenceTool = createTranscriptPersistenceTool()

  assert.equal(PERSIST_DEBATE_TRANSCRIPT_TOOL, "persist_debate_transcript")
  assert.ok(persistenceTool.args.markdown)
  assert.ok(persistenceTool.args.slug)
})

test("the persistence tool returns the claimed Markdown and generated HTML paths", async () => {
  const directory = temporaryProject()
  try {
    const output = await createTranscriptPersistenceTool({
      now: () => new Date("2026-08-13T00:00:00Z"),
    }).execute(
      { markdown: VALID_MARKDOWN, slug: "tool-result" },
      { directory } as never,
    )

    assert.match(output as string, /Markdown: docs\/debates\/2026-08-13-tool-result\.md/)
    assert.match(output as string, /HTML: docs\/debates\/2026-08-13-tool-result\.html/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { parse } from "yaml"
import {
  DEBATE_PARTICIPANTS,
  DEBATE_PARTICIPANT_SETS,
  DebateConfigError,
  loadEffectiveRegistry,
  loadPackagedRegistry,
  parseParticipantConfig,
  resolveUserConfigPath,
} from "../src/participants.ts"

function completeConfig(sets = `
  alpha:
    participants: [one, two, three]
`): string {
  return `version: 2
participants:
  one:
    model: provider/one
  two:
    model: provider/two
  three:
    model: provider/three
  unused:
    model: provider/unused
sets:
${sets}`
}

function withTempConfig(source: string, run: (configPath: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-config-"))
  const configPath = join(directory, "config.yaml")
  try {
    writeFileSync(configPath, source)
    run(configPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function assertInvalidConfig(source: string, fieldPath: string, reason: RegExp): void {
  assert.throws(
    () => parseParticipantConfig(source, "/tmp/config.yaml"),
    (error: unknown) => error instanceof DebateConfigError
      && error.fieldPath === fieldPath
      && reason.test(error.message),
  )
}

test("packaged config.yaml preserves the shipped version 2 participant registry", () => {
  const source = readFileSync(new URL("../config.yaml", import.meta.url), "utf8")
  const config = parse(source)

  assert.deepEqual(config, {
    version: 2,
    participants: {
      "debate-openai": {
        description: "Neutral debate participant using OpenAI GPT-5.6 Sol (xhigh)",
        model: "openai/gpt-5.6-sol",
        variant: "xhigh",
      },
      "debate-glm": {
        description: "Neutral debate participant using GLM-5.2 from OpenCode Go (max)",
        model: "opencode-go/glm-5.2",
        variant: "max",
      },
      "debate-kimi": {
        description: "Neutral debate participant using Kimi K3 from OpenCode Go (max)",
        model: "opencode-go/kimi-k3",
        variant: "max",
      },
      "debate-anthropic": {
        description: "Neutral debate participant using Claude Opus 5 through OpenRouter (high)",
        model: "openrouter/anthropic/claude-opus-5",
        variant: "high",
      },
      "debate-qwen": {
        description: "Neutral debate participant using Qwen 3.7 Max from OpenCode Go (max)",
        model: "opencode-go/qwen3.7-max",
        variant: "max",
      },
    },
    sets: {
      default: {
        default: "yes",
        continuation: "ask",
        participants: ["debate-kimi", "debate-anthropic", "debate-openai"],
      },
      cheap: {
        continuation: "ask",
        participants: ["debate-glm", "debate-qwen", "debate-kimi"],
      },
    },
  })
})

test("packaged compatibility exports are loaded from config.yaml", () => {
  assert.deepEqual(Object.keys(DEBATE_PARTICIPANT_SETS), ["default", "cheap"])
  assert.deepEqual(DEBATE_PARTICIPANT_SETS.default, ["debate-kimi", "debate-anthropic", "debate-openai"])
  assert.deepEqual(DEBATE_PARTICIPANT_SETS.cheap, ["debate-glm", "debate-qwen", "debate-kimi"])
  assert.equal(DEBATE_PARTICIPANTS.length, 5)
})

test("description and variant are optional source fields", () => {
  const parsed = parseParticipantConfig(completeConfig(), "/tmp/config.yaml")
  assert.deepEqual(parsed.participants.one, { model: "provider/one" })
})

test("an omitted continuation mode normalises to ask", () => {
  const parsed = parseParticipantConfig(completeConfig(), "/tmp/config.yaml")

  assert.equal(parsed.sets.alpha.continuation, "ask")
})

test("ask and discretion are accepted continuation modes", () => {
  const parsed = parseParticipantConfig(completeConfig(`
  alpha:
    participants: [one, two, three]
    continuation: ask
  beta:
    participants: [one, three, unused]
    continuation: discretion
`), "/tmp/config.yaml")

  assert.equal(parsed.sets.alpha.continuation, "ask")
  assert.equal(parsed.sets.beta.continuation, "discretion")
})

test("continuation modes reject invalid types and values", () => {
  for (const value of ["true", "1", "[ask]", "manual", "ASK", "\"\""]) {
    assertInvalidConfig(
      completeConfig(`
  alpha:
    participants: [one, two, three]
    continuation: ${value}
`),
      "sets.alpha.continuation",
      /expected ask or discretion/,
    )
  }
})

test("duplicate YAML mapping keys are rejected", () => {
  assertInvalidConfig(
    "version: 2\nversion: 2\nparticipants: {}\nsets: {}\n",
    "$",
    /unique|duplicate/i,
  )
})

test("malformed YAML is rejected", () => {
  assertInvalidConfig("version: [\n", "$", /YAML|flow sequence|unexpected/i)
})

test("version 1 is rejected with the required migration diagnostic", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets: {}\n",
    "version",
    /unsupported version; expected 2/,
  )
})

test("unknown top-level and participant fields are rejected", () => {
  assertInvalidConfig(
    `${completeConfig()}extra: true\n`,
    "extra",
    /unknown field/i,
  )
  assertInvalidConfig(
    completeConfig().replace("    model: provider/one", "    model: provider/one\n    temperature: 1"),
    "participants.one.temperature",
    /unknown field/i,
  )
})

test("participants and sets must be mappings", () => {
  assertInvalidConfig("version: 2\nparticipants: []\nsets: {}\n", "participants", /mapping/i)
  assertInvalidConfig("version: 2\nparticipants: {}\nsets: null\n", "sets", /mapping/i)
})

for (const [field, value] of [["model", "''"], ["description", "'  '"], ["variant", "''"]] as const) {
  test(`${field} must be a non-empty string when supplied`, () => {
    const source = field === "model"
      ? completeConfig().replace("model: provider/one", `model: ${value}`)
      : completeConfig().replace("model: provider/one", `model: provider/one\n    ${field}: ${value}`)
    assertInvalidConfig(source, `participants.one.${field}`, /non-empty string/i)
  })
}

test("a complete config requires every participant model", () => {
  assertInvalidConfig(
    completeConfig().replace("  one:\n    model: provider/one", "  one: {}"),
    "participants.one.model",
    /non-empty string/i,
  )
})

test("a set requires exactly three distinct known participants", () => {
  for (const [participants, field, reason] of [
    ["[one, two]", "sets.alpha.participants", /exactly three/i],
    ["[one, two, three, unused]", "sets.alpha.participants", /exactly three/i],
    ["[one, one, two]", "sets.alpha.participants", /distinct/i],
    ["[one, two, missing]", "sets.alpha.participants[2]", /unknown participant/i],
  ] as const) {
    assertInvalidConfig(
      completeConfig(`\n  alpha:\n    participants: ${participants}\n`),
      field,
      reason,
    )
  }
})

test("set participant IDs must be non-empty strings", () => {
  assertInvalidConfig(
    completeConfig("\n  alpha:\n    participants: [one, two, 3]\n"),
    "sets.alpha.participants[2]",
    /non-empty string/i,
  )
})

test("set mappings recognise continuation but reject other unknown fields and an empty set mapping", () => {
  assertInvalidConfig(
    completeConfig("\n  alpha:\n    participants: [one, two, three]\n    continuation: ask\n    rounds: 4\n"),
    "sets.alpha.rounds",
    /unknown field/i,
  )
  assertInvalidConfig(completeConfig("  {}\n"), "sets", /at least one set/i)
})

test("only the string yes is accepted as a default marker", () => {
  for (const value of ["no", "true", "false", "1", "\"\"", "later"]) {
    assertInvalidConfig(
      completeConfig(`\n  alpha:\n    participants: [one, two, three]\n    default: ${value}\n`),
      "sets.alpha.default",
      /expected the string yes/,
    )
  }
})

test("quoted and unquoted yes select the same default", () => {
  for (const value of ["yes", "\"yes\""]) {
    const parsed = parseParticipantConfig(completeConfig(`
  alpha:
    participants: [one, two, three]
  chosen:
    participants: [one, three, unused]
    default: ${value}
`), "/tmp/config.yaml")
    assert.equal(parsed.defaultSet, "chosen")
  }
})

test("a second default marker is rejected at its own field", () => {
  assertInvalidConfig(completeConfig(`
  alpha:
    participants: [one, two, three]
    default: yes
  beta:
    participants: [one, three, unused]
    default: yes
`), "sets.beta.default", /only one set may specify default/)
})

test("an explicit marker overrides source order", () => {
  const parsed = parseParticipantConfig(completeConfig(`
  first:
    participants: [one, two, three]
  chosen:
    participants: [one, three, unused]
    default: yes
`), "/tmp/config.yaml")
  assert.equal(parsed.defaultSet, "chosen")
})

test("the first YAML-defined set is the fallback, including integer-like names", () => {
  const parsed = parseParticipantConfig(completeConfig(`
  "10":
    participants: [one, two, three]
  "2":
    participants: [one, three, unused]
`), "/tmp/config.yaml")
  assert.equal(parsed.defaultSet, "10")
})

test("unused participants remain in a deeply frozen runtime registry", () => {
  withTempConfig(completeConfig(), (configPath) => {
    const registry = loadPackagedRegistry(configPath)
    assert.ok(registry.participants.some(({ agent }) => agent === "unused"))
    assert.equal(registry.defaultSet, "alpha")
    assert.equal(Object.isFrozen(registry), true)
    assert.equal(Object.isFrozen(registry.participants), true)
    assert.equal(Object.isFrozen(registry.participants[0]), true)
    assert.equal(Object.isFrozen(registry.sets), true)
    assert.equal(Object.isFrozen(registry.sets.alpha), true)
    assert.deepEqual(registry.continuationBySet, { alpha: "ask" })
    assert.equal(Object.isFrozen(registry.continuationBySet), true)
  })
})

test("missing user config is created as an exact packaged copy", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-create-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const userPath = join(directory, "nested", "config.yaml")
    const source = completeConfig()
    writeFileSync(packagedPath, source)

    const registry = loadEffectiveRegistry({ packagedPath, userPath })

    assert.equal(readFileSync(userPath, "utf8"), source)
    assert.equal(registry.defaultSet, "alpha")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an existing complete user config is authoritative and never rewritten", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-authority-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const userPath = join(directory, "config.yaml")
    const packaged = completeConfig()
    const user = completeConfig(`
  user-choice:
    participants: [one, two, three]
`).replace("  unused:\n    model: provider/unused\n", "")
    writeFileSync(packagedPath, packaged)
    writeFileSync(userPath, user)

    const registry = loadEffectiveRegistry({ packagedPath, userPath })

    assert.equal(readFileSync(userPath, "utf8"), user)
    assert.deepEqual(Object.keys(registry.sets), ["user-choice"])
    assert.equal(registry.defaultSet, "user-choice")
    assert.equal(registry.participants.some(({ agent }) => agent === "unused"), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an existing partial overlay is rejected without modification", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-partial-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const userPath = join(directory, "config.yaml")
    const partial = "version: 2\nparticipants:\n  one:\n    model: provider/changed\n"
    writeFileSync(packagedPath, completeConfig())
    writeFileSync(userPath, partial)

    assert.throws(() => loadEffectiveRegistry({ packagedPath, userPath }), DebateConfigError)
    assert.equal(readFileSync(userPath, "utf8"), partial)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("deleting the user file causes recreation on the next load", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-recreate-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const userPath = join(directory, "config.yaml")
    const source = completeConfig()
    writeFileSync(packagedPath, source)
    loadEffectiveRegistry({ packagedPath, userPath })
    rmSync(userPath)

    loadEffectiveRegistry({ packagedPath, userPath })

    assert.equal(readFileSync(userPath, "utf8"), source)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("concurrent creators do not clobber the winning complete file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-race-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const userPath = join(directory, "config.yaml")
    const source = completeConfig()
    writeFileSync(packagedPath, source)
    const moduleUrl = new URL("../src/participants.ts", import.meta.url).href
    const script = `import { ensureUserConfig } from ${JSON.stringify(moduleUrl)}; ensureUserConfig(process.argv[1], process.argv[2])`
    const execute = promisify(execFile)

    await Promise.all([
      execute(process.execPath, ["--input-type=module", "--eval", script, packagedPath, userPath]),
      execute(process.execPath, ["--input-type=module", "--eval", script, packagedPath, userPath]),
    ])

    assert.equal(readFileSync(userPath, "utf8"), source)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("packaged read failures include operation, absolute path, and cause", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-read-error-"))
  try {
    const missingPath = join(directory, "missing.yaml")
    assert.throws(
      () => loadEffectiveRegistry({ packagedPath: missingPath, userPath: join(directory, "unused.yaml") }),
      (error: unknown) => error instanceof Error
        && "operation" in error
        && error.operation === "read"
        && "configPath" in error
        && error.configPath === missingPath
        && error.message.includes("ENOENT"),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("creation failures include operation, absolute user path, and cause", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-create-error-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const blockedParent = join(directory, "not-a-directory")
    const userPath = join(blockedParent, "config.yaml")
    writeFileSync(packagedPath, completeConfig())
    writeFileSync(blockedParent, "file")

    assert.throws(
      () => loadEffectiveRegistry({ packagedPath, userPath }),
      (error: unknown) => error instanceof Error
        && "operation" in error
        && error.operation === "create"
        && "configPath" in error
        && error.configPath === userPath
        && /EEXIST|ENOTDIR/.test(error.message),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("user read failures abort instead of falling back to packaged config", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-user-read-error-"))
  try {
    const packagedPath = join(directory, "packaged.yaml")
    const userPath = join(directory, "config.yaml")
    writeFileSync(packagedPath, completeConfig())
    mkdirSync(userPath)

    assert.throws(
      () => loadEffectiveRegistry({ packagedPath, userPath }),
      (error: unknown) => error instanceof Error
        && "operation" in error
        && error.operation === "read"
        && "configPath" in error
        && error.configPath === userPath,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("XDG_CONFIG_HOME selects the user config base directory", () => {
  assert.equal(
    resolveUserConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/tester"),
    "/tmp/xdg/opencode/opencode-debate/config.yaml",
  )
})

test("the home .config directory is used when XDG_CONFIG_HOME is absent", () => {
  assert.equal(
    resolveUserConfigPath({}, "/home/tester"),
    "/home/tester/.config/opencode/opencode-debate/config.yaml",
  )
})

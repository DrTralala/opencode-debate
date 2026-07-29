import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { parse } from "yaml"
import {
  DEBATE_PARTICIPANTS,
  DEBATE_PARTICIPANT_SETS,
  DebateConfigError,
  loadEffectiveRegistry,
  parseParticipantConfig,
  resolveUserConfigPath,
} from "../src/participants.ts"

test("packaged config.yaml preserves the shipped participant registry", () => {
  const source = readFileSync(new URL("../config.yaml", import.meta.url), "utf8")
  const config = parse(source)

  assert.deepEqual(config, {
    version: 1,
    participants: {
      "debate-openai": {
        description: "Neutral debate participant using OpenAI GPT-5.6 Sol (xhigh)",
        model: "openai/gpt-5.6-sol",
        variant: "xhigh",
      },
      "debate-glm": {
        description: "Neutral debate participant using GLM-5.2 from OpenCode Go",
        model: "opencode-go/glm-5.2",
        variant: "max",
      },
      "debate-kimi": {
        description: "Neutral debate participant using Kimi K3 from OpenCode Go",
        model: "opencode-go/kimi-k3",
        variant: "max",
      },
      "debate-anthropic": {
        description: "Neutral debate participant using Claude Opus 5 through OpenRouter",
        model: "openrouter/anthropic/claude-opus-5",
        variant: "high",
      },
      "debate-qwen": {
        description: "Neutral debate participant using Qwen 3.7 Max from OpenCode Go",
        model: "opencode-go/qwen3.7-max",
        variant: "max",
      },
    },
    sets: {
      default: ["debate-kimi", "debate-anthropic", "debate-openai"],
      cheap: ["debate-glm", "debate-qwen", "debate-kimi"],
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
  const parsed = parseParticipantConfig(
    [
      "version: 1",
      "participants:",
      "  debate-new:",
      "    model: provider/model",
      "sets:",
      "  default: [debate-new, debate-two, debate-three]",
      "  other: [debate-new, debate-two, debate-three]",
      "",
    ].join("\n"),
    "/tmp/config.yaml",
    "overlay",
  )

  assert.deepEqual(parsed.participants["debate-new"], { model: "provider/model" })
})

function assertInvalidConfig(source: string, field: RegExp, reason: RegExp): void {
  assert.throws(
    () => parseParticipantConfig(source, "/tmp/config.yaml", "defaults"),
    (error: unknown) => {
      assert.ok(error instanceof DebateConfigError)
      assert.match(error.message, /Invalid opencode-debate config at \/tmp\/config\.yaml/)
      assert.match(error.message, field)
      assert.match(error.message, reason)
      return true
    },
  )
}

test("duplicate YAML mapping keys are rejected", () => {
  assertInvalidConfig(
    "version: 1\nversion: 1\nparticipants: {}\nsets: {}\n",
    /\(\$\)/,
    /unique|duplicate/i,
  )
})

test("malformed YAML is rejected", () => {
  assertInvalidConfig("version: [\n", /\(\$\)/, /YAML|flow sequence|unexpected/i)
})

test("unsupported versions are rejected", () => {
  assertInvalidConfig(
    "version: 2\nparticipants: {}\nsets: {}\n",
    /\(version\)/,
    /expected 1/i,
  )
})

test("unknown top-level fields are rejected", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets: {}\nextra: true\n",
    /\(extra\)/,
    /unknown field/i,
  )
})

test("unknown participant fields are rejected", () => {
  assertInvalidConfig(
    [
      "version: 1",
      "participants:",
      "  debate-new:",
      "    model: provider/model",
      "    temperature: 1",
      "sets:",
      "  default: [debate-new, debate-two, debate-three]",
      "",
    ].join("\n"),
    /\(participants\.debate-new\.temperature\)/,
    /unknown field/i,
  )
})

test("participants must be a mapping", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: []\nsets: {}\n",
    /\(participants\)/,
    /mapping/i,
  )
})

test("an explicit null overlay participant mapping is rejected", () => {
  assert.throws(
    () => parseParticipantConfig("version: 1\nparticipants: null\n", "/tmp/config.yaml", "overlay"),
    (error: unknown) => error instanceof DebateConfigError
      && error.fieldPath === "participants"
      && /mapping/i.test(error.message),
  )
})

test("an explicit null overlay set mapping is rejected", () => {
  assert.throws(
    () => parseParticipantConfig("version: 1\nsets: null\n", "/tmp/config.yaml", "overlay"),
    (error: unknown) => error instanceof DebateConfigError
      && error.fieldPath === "sets"
      && /mapping/i.test(error.message),
  )
})

for (const [field, value] of [["model", "''"], ["description", "'  '"], ["variant", "''"]] as const) {
  test(`${field} must be a non-empty string when supplied`, () => {
    assertInvalidConfig(
      [
        "version: 1",
        "participants:",
        "  debate-new:",
        ...(field === "model" ? [] : ["    model: provider/model"]),
        `    ${field}: ${value}`,
        "sets:",
        "  default: [debate-new, debate-two, debate-three]",
        "",
      ].join("\n"),
      new RegExp(`\\(participants\\.debate-new\\.${field}\\)`),
      /non-empty string/i,
    )
  })
}

test("every set must contain exactly three participants", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets:\n  default: [one, two]\n",
    /\(sets\.default\)/,
    /exactly three/i,
  )
})

test("set members must be distinct", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets:\n  default: [one, one, two]\n",
    /\(sets\.default\)/,
    /distinct/i,
  )
})

test("set members must be non-empty strings", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets:\n  default: [one, two, 3]\n",
    /\(sets\.default\[2\]\)/,
    /non-empty string/i,
  )
})

test("packaged defaults require a default set", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets:\n  other: [one, two, three]\n",
    /\(sets\.default\)/,
    /required/i,
  )
})

test("packaged set references must resolve", () => {
  assertInvalidConfig(
    "version: 1\nparticipants: {}\nsets:\n  default: [one, two, three]\n",
    /\(sets\.default\[0\]\)/,
    /unknown participant/i,
  )
})

test("inherited object properties are not treated as participant IDs", () => {
  assertInvalidConfig(
    [
      "version: 1",
      "participants:",
      "  one: { model: provider/one }",
      "  two: { model: provider/two }",
      "sets:",
      "  default: [toString, one, two]",
      "",
    ].join("\n"),
    /\(sets\.default\[0\]\)/,
    /unknown participant/i,
  )
})

function writeUserConfig(source: string): string {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-config-"))
  const configPath = join(directory, "config.yaml")
  writeFileSync(configPath, source)
  return configPath
}

test("a missing user overlay returns packaged defaults", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-debate-config-"))
  const registry = loadEffectiveRegistry({ userPath: join(directory, "missing.yaml") })

  assert.deepEqual(registry.participants, DEBATE_PARTICIPANTS)
  assert.deepEqual(registry.sets, DEBATE_PARTICIPANT_SETS)
})

test("an overlay merges supplied participant fields", () => {
  const userPath = writeUserConfig([
    "version: 1",
    "participants:",
    "  debate-openai:",
    "    model: openai/new-model",
    "    variant: max",
    "",
  ].join("\n"))

  const registry = loadEffectiveRegistry({ userPath })

  assert.deepEqual(registry.participants.find(({ agent }) => agent === "debate-openai"), {
    agent: "debate-openai",
    description: "Neutral debate participant using OpenAI GPT-5.6 Sol (xhigh)",
    model: "openai/new-model",
    variant: "max",
  })
  assert.deepEqual(registry.sets, DEBATE_PARTICIPANT_SETS)
})

test("an overlay can add a participant and set with description fallback", () => {
  const userPath = writeUserConfig([
    "version: 1",
    "participants:",
    "  debate-new:",
    "    model: provider/new-model",
    "sets:",
    "  custom: [debate-new, debate-kimi, debate-openai]",
    "",
  ].join("\n"))

  const registry = loadEffectiveRegistry({ userPath })

  assert.deepEqual(registry.participants.at(-1), {
    agent: "debate-new",
    description: "Neutral debate participant using provider/new-model",
    model: "provider/new-model",
  })
  assert.deepEqual(registry.sets.custom, ["debate-new", "debate-kimi", "debate-openai"])
})

test("an overlay replaces an entire supplied set", () => {
  const userPath = writeUserConfig([
    "version: 1",
    "sets:",
    "  default: [debate-openai, debate-glm, debate-qwen]",
    "",
  ].join("\n"))

  const registry = loadEffectiveRegistry({ userPath })

  assert.deepEqual(registry.sets.default, ["debate-openai", "debate-glm", "debate-qwen"])
  assert.deepEqual(registry.sets.cheap, DEBATE_PARTICIPANT_SETS.cheap)
})

test("an incomplete added participant fails with the user path", () => {
  const userPath = writeUserConfig([
    "version: 1",
    "participants:",
    "  debate-new:",
    "    description: New participant",
    "",
  ].join("\n"))

  assert.throws(
    () => loadEffectiveRegistry({ userPath }),
    (error: unknown) => {
      assert.ok(error instanceof DebateConfigError)
      assert.match(error.message, new RegExp(userPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
      assert.match(error.message, /\(participants\.debate-new\.model\)/)
      return true
    },
  )
})

test("an overlay set with an unknown participant fails with the user path", () => {
  const userPath = writeUserConfig([
    "version: 1",
    "sets:",
    "  custom: [debate-missing, debate-kimi, debate-openai]",
    "",
  ].join("\n"))

  assert.throws(
    () => loadEffectiveRegistry({ userPath }),
    (error: unknown) => {
      assert.ok(error instanceof DebateConfigError)
      assert.equal(error.configPath, userPath)
      assert.equal(error.fieldPath, "sets.custom[0]")
      return true
    },
  )
})

test("effective registries are deeply frozen", () => {
  const registry = loadEffectiveRegistry({ userPath: join(tmpdir(), "definitely-missing-opencode-debate.yaml") })

  assert.equal(Object.isFrozen(registry), true)
  assert.equal(Object.isFrozen(registry.participants), true)
  assert.equal(Object.isFrozen(registry.participants[0]), true)
  assert.equal(Object.isFrozen(registry.sets), true)
  assert.equal(Object.isFrozen(registry.sets.default), true)
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

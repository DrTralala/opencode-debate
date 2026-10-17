import assert from "node:assert/strict"
import { test } from "node:test"
import { parseMiniDebateArguments } from "../src/mini-debate/arguments.ts"
import type { DebateRegistry } from "../src/participants.ts"

const REGISTRY: DebateRegistry = {
  participants: [
    { agent: "one", description: "One", model: "provider/one" },
    { agent: "two", description: "Two", model: "provider/two" },
    { agent: "three", description: "Three", model: "provider/three" },
  ],
  sets: {
    default: ["one", "two", "three"],
    alternate: ["three", "two", "one"],
  },
  continuationBySet: {
    default: "ask",
    alternate: "ask",
  },
  autoDebate: {
    enabled: false,
    set: "alternate",
    maxRounds: 3,
    persistTranscripts: true,
  },
  defaultSet: "default",
}

test("a topic-only command uses the first configured default-set participant and three rounds", () => {
  const parsed = parseMiniDebateArguments("A topic", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.participant.agent, "one")
    assert.equal(parsed.participant.model, "provider/one")
    assert.equal(parsed.rounds, 3)
    assert.equal(parsed.topic, "A topic")
  }
})

test("the default participant is independent of auto_debate.set", () => {
  const parsed = parseMiniDebateArguments("A topic", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.participant.agent, "one")
})

test("the first member of a custom configured default set is the default participant", () => {
  const custom: DebateRegistry = { ...REGISTRY, defaultSet: "alternate" }
  const parsed = parseMiniDebateArguments("A topic", custom)

  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.participant.agent, "three")
})

test("mini-debate configuration supplies participant and rounds defaults", () => {
  const configured: DebateRegistry = {
    ...REGISTRY,
    miniDebate: { participant: "three", maxRounds: 7 },
  }
  const parsed = parseMiniDebateArguments("A topic", configured)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.participant.agent, "three")
    assert.equal(parsed.rounds, 7)
    assert.equal(parsed.topic, "A topic")
  }
})

test("partial mini-debate configuration keeps the default-set participant and configured rounds", () => {
  const configured: DebateRegistry = { ...REGISTRY, miniDebate: { maxRounds: 4 } }
  const parsed = parseMiniDebateArguments("A topic", configured)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.participant.agent, "one")
    assert.equal(parsed.rounds, 4)
  }
})

test("command flags override the configured participant and rounds", () => {
  const configured: DebateRegistry = {
    ...REGISTRY,
    miniDebate: { participant: "three", maxRounds: 7 },
  }
  const parsed = parseMiniDebateArguments("--participant:one --rounds 2 A topic", configured)

  assert.deepEqual(parsed, {
    ok: true,
    topic: "A topic",
    rounds: 2,
    participant: REGISTRY.participants[0],
  })
})

test("the published example resolves participant, rounds and topic", () => {
  const parsed = parseMiniDebateArguments("--participant:two --rounds 5 A topic", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.participant.agent, "two")
    assert.equal(parsed.rounds, 5)
    assert.equal(parsed.topic, "A topic")
  }
})

test("--rounds 5 and --rounds=5 resolve identically", () => {
  for (const args of ["--rounds 5 A topic", "--rounds=5 A topic"]) {
    const parsed = parseMiniDebateArguments(args, REGISTRY)

    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(parsed.rounds, 5)
      assert.equal(parsed.topic, "A topic")
    }
  }
})

test("an absent, blank, separator-only or flag-only topic fails", () => {
  for (const args of [
    "",
    "   ",
    "--",
    "--   ",
    "--rounds 3",
    "--participant:two",
    "--participant:two --rounds 5",
  ]) {
    const parsed = parseMiniDebateArguments(args, REGISTRY)

    assert.equal(parsed.ok, false, `expected ${JSON.stringify(args)} to fail`)
  }
})

test("duplicate options fail", () => {
  for (const [args, expected] of [
    ["--rounds 2 --rounds 5 A topic", /only be specified once/],
    ["--rounds=2 --rounds=5 A topic", /only be specified once/],
    ["--participant:one --participant:two A topic", /only be specified once/],
  ] as const) {
    const parsed = parseMiniDebateArguments(args, REGISTRY)

    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.match(parsed.error, expected)
  }
})

test("unknown, inherited, empty and bare participant options fail", () => {
  for (const [args, expected] of [
    ["--participant:missing A topic", /Unsupported --participant value/],
    ["--participant:toString A topic", /Unsupported --participant value/],
    ["--participant: A topic", /requires a value/],
    ["--participant two A topic", /Unsupported option/],
  ] as const) {
    const parsed = parseMiniDebateArguments(args, REGISTRY)

    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.match(parsed.error, expected)
  }
})

test("malformed rounds fail", () => {
  for (const [args, expected] of [
    ["--rounds", /positive integer/],
    ["--rounds 0 A topic", /positive integer/],
    ["--rounds -3 A topic", /positive integer/],
    ["--rounds=abc A topic", /positive integer/],
    ["--rounds 11 A topic", /between 1 and 10/],
    ["--rounds=9999999999999999999999 A topic", /between 1 and 10/],
  ] as const) {
    const parsed = parseMiniDebateArguments(args, REGISTRY)

    assert.equal(parsed.ok, false)
    if (!parsed.ok) assert.match(parsed.error, expected)
  }
})

test("unknown options fail with actionable errors", () => {
  const parsed = parseMiniDebateArguments("--set:default A topic", REGISTRY)

  assert.equal(parsed.ok, false)
  if (!parsed.ok) {
    assert.match(parsed.error, /Unsupported option/)
    assert.match(parsed.error, /--participant:one/)
  }
})

test("-- protects a topic beginning with flags", () => {
  const parsed = parseMiniDebateArguments("-- --rounds 5 not an option", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.topic, "--rounds 5 not an option")
    assert.equal(parsed.rounds, 3)
    assert.equal(parsed.participant.agent, "one")
  }
})

test("-- follows options and protects the remaining topic", () => {
  const parsed = parseMiniDebateArguments("--rounds 5 -- --flag topic", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.rounds, 5)
    assert.equal(parsed.topic, "--flag topic")
  }
})

test("the literal topic is preserved once options finish", () => {
  const parsed = parseMiniDebateArguments("review --rounds 5 in the topic", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.rounds, 3)
    assert.equal(parsed.topic, "review --rounds 5 in the topic")
  }
})

test("internal topic whitespace is preserved while surrounding whitespace is trimmed", () => {
  const parsed = parseMiniDebateArguments("  --rounds 5   A   topic  ", REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.topic, "A   topic")
})

test("surrounding quotes around the whole argument are trimmed before parsing", () => {
  const parsed = parseMiniDebateArguments('"--participant:two A topic"', REGISTRY)

  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.participant.agent, "two")
    assert.equal(parsed.topic, "A topic")
  }
})

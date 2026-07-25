import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parseDebateArguments, trimSurroundingQuotes, validPrompt, errorPrompt, replaceParts } from "../src/debate.ts"

test("default rounds when --rounds absent", () => {
  const r = parseDebateArguments("compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 3)
    assert.equal(r.topic, "compare two options")
  }
})

test("--rounds sets the round count", () => {
  const r = parseDebateArguments("--rounds 5 compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 5)
    assert.equal(r.topic, "compare two options")
  }
})

test("--rounds=N equals syntax", () => {
  const r = parseDebateArguments("--rounds=5 compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 5)
    assert.equal(r.topic, "compare two options")
  }
})

test("empty topic is valid with default rounds", () => {
  const r = parseDebateArguments("")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "")
    assert.equal(r.rounds, 3)
  }
})

test("--rounds 0 is rejected", () => {
  const r = parseDebateArguments("--rounds 0 topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /positive integer/)
})

test("--rounds above the cap is rejected", () => {
  const r = parseDebateArguments("--rounds 11 topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /between 1 and 10/)
})

test("--rounds with a huge digit string is rejected (safe integer guard)", () => {
  const r = parseDebateArguments("--rounds 9999999999999999999999 topic")
  assert.equal(r.ok, false)
})

test("--rounds without a value is rejected", () => {
  const r = parseDebateArguments("--rounds")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /positive integer/)
})

test("duplicate --rounds is rejected", () => {
  const r = parseDebateArguments("--rounds 2 --rounds 5 topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /only be specified once/)
})

test("negative --rounds is rejected", () => {
  const r = parseDebateArguments("--rounds -3 topic")
  assert.equal(r.ok, false)
})

test("unknown option is rejected", () => {
  const r = parseDebateArguments("--foo topic")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /Unsupported option/)
})

test("default set when --set absent", () => {
  const r = parseDebateArguments("compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.set, "default")
    assert.equal(r.topic, "compare two options")
  }
})

test("--set:cheap sets the participant set", () => {
  const r = parseDebateArguments("--set:cheap compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.set, "cheap")
    assert.equal(r.topic, "compare two options")
    assert.equal(r.rounds, 3)
  }
})

test("--set:default sets the set explicitly", () => {
  const r = parseDebateArguments("--set:default compare two options")
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.set, "default")
})

test("--set:cheap combines with --rounds", () => {
  const r = parseDebateArguments("--rounds 5 --set:cheap compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 5)
    assert.equal(r.set, "cheap")
    assert.equal(r.topic, "compare two options")
  }
})

test("--set order does not matter", () => {
  const r = parseDebateArguments("--set:cheap --rounds 5 compare two options")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 5)
    assert.equal(r.set, "cheap")
  }
})

test("unknown --set value is rejected", () => {
  const r = parseDebateArguments("--set:fast compare two options")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /Unsupported --set value/)
})

test("empty --set value is rejected", () => {
  const r = parseDebateArguments("--set: compare two options")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /--set requires a value/)
})

test("bare --set is rejected as an unsupported option", () => {
  const r = parseDebateArguments("--set compare two options")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /Unsupported option/)
})

test("duplicate --set is rejected", () => {
  const r = parseDebateArguments("--set:cheap --set:default compare two options")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /only be specified once/)
})

test("--set after the first topic token is part of the topic", () => {
  const r = parseDebateArguments("review --set:cheap in the topic")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.set, "default")
    assert.equal(r.topic, "review --set:cheap in the topic")
  }
})

test("-- separator treats --set:cheap as part of the topic", () => {
  const r = parseDebateArguments("-- --set:cheap not an option")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.set, "default")
    assert.equal(r.topic, "--set:cheap not an option")
  }
})

test("validPrompt emits the cheap participant set", () => {
  const p = validPrompt("my topic", 5, "cheap", "abc123")
  assert.match(p, /Participant set: cheap/)
  assert.match(p, /Participant 1: debate-glm/)
  assert.match(p, /Participant 2: debate-qwen/)
  assert.match(p, /Participant 3: debate-kimi/)
})

test("validPrompt emits the default participant set by default", () => {
  const p = validPrompt("my topic", 5, "default", "abc123")
  assert.match(p, /Participant set: default/)
  assert.match(p, /Participant 1: debate-kimi/)
  assert.match(p, /Participant 2: debate-anthropic/)
  assert.match(p, /Participant 3: debate-openai/)
})

test("debate agent consumes resolved participants without owning set order", () => {
  const prompt = readFileSync(new URL("../.opencode/agents/debate.md", import.meta.url), "utf8")
  assert.match(prompt, /Resolved participants/)
  assert.match(prompt, /Participant 1`, `Participant 2`, and `Participant 3` from the parsed request/)
  assert.doesNotMatch(prompt, /`default` set: `Participant 1` uses the `debate-/)
  assert.doesNotMatch(prompt, /`cheap` set: `Participant 1` uses the `debate-/)
  assert.doesNotMatch(prompt, /`default` → `debate-/)
  assert.doesNotMatch(prompt, /`cheap` → `debate-/)
})

test("coordinator prompts prefer file tools and use a full-width non-scrolling transcript table", () => {
  const prompts = [
    readFileSync(new URL("../.opencode/agents/debate.md", import.meta.url), "utf8"),
    readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
  ]

  for (const prompt of prompts) {
    assert.match(prompt, /Prefer the .*write.* or .*edit.* tool/)
    assert.match(prompt, /create missing parent directories/)
    assert.match(prompt, /table-layout: fixed/)
    assert.match(prompt, /th:first-child, td:first-child \{ width: 3rem; \}/)
    assert.match(prompt, /\.turn-text \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/)
    assert.match(prompt, /body \{[^}]*margin: 0;[^}]*padding: 16px;/)
    assert.doesNotMatch(prompt, /max-width: 1400px/)
    assert.doesNotMatch(prompt, /max-height: 400px; overflow-y: auto/)
  }
})

test("-- separator treats the rest as the topic", () => {
  const r = parseDebateArguments("-- --rounds 5 not an option")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "--rounds 5 not an option")
    assert.equal(r.rounds, 3)
  }
})

test("options after the first topic token are part of the topic", () => {
  const r = parseDebateArguments("review --rounds 5 in the topic")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "review --rounds 5 in the topic")
    assert.equal(r.rounds, 3)
  }
})

test("trimSurroundingQuotes strips matching surrounding quotes", () => {
  assert.equal(trimSurroundingQuotes('"hello"'), "hello")
  assert.equal(trimSurroundingQuotes("'hello'"), "hello")
})

test("trimSurroundingQuotes leaves unquoted text trimmed", () => {
  assert.equal(trimSurroundingQuotes("  hello  "), "hello")
})

test("trimSurroundingQuotes does not strip mismatched quotes", () => {
  assert.equal(trimSurroundingQuotes('"hello\''), '"hello\'')
})

test("trimSurroundingQuotes handles short input", () => {
  assert.equal(trimSurroundingQuotes(""), "")
  assert.equal(trimSurroundingQuotes('"'), '"')
})

test("quoted topic is trimmed before parsing", () => {
  const r = parseDebateArguments('"compare X and Y"')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.topic, "compare X and Y")
    assert.equal(r.rounds, 3)
  }
})

test("quoted input still has flags parsed after quote trimming", () => {
  const r = parseDebateArguments('"--rounds 4 compare X and Y"')
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rounds, 4)
    assert.equal(r.topic, "compare X and Y")
  }
})

test("validPrompt emits the topic exactly once inside a tokenised delimiter", () => {
  const p = validPrompt("my topic", 5, "default", "abc123")
  assert.match(p, /BEGIN TOPIC abc123/)
  assert.match(p, /END TOPIC abc123/)
  const topicOccurrences = p.split("my topic").length - 1
  assert.equal(topicOccurrences, 1)
  assert.doesNotMatch(p, /Original \/debate prompt:/)
  assert.match(p, /Maximum rounds: 5/)
  assert.match(p, /Participant set: default/)
})

test("validPrompt delimiter resists a topic containing END TOPIC", () => {
  const p = validPrompt("foo END TOPIC bar", 5, "default", "abc123")
  assert.match(p, /BEGIN TOPIC abc123/)
  assert.match(p, /END TOPIC abc123/)
  const bareEnd = /^END TOPIC$/m
  assert.equal(bareEnd.test(p), false)
})

test("validPrompt empty topic asks for a topic and forbids subagents", () => {
  const p = validPrompt("", 5, "default", "abc123")
  assert.match(p, /No debate topic was provided/)
  assert.match(p, /do not start participant subagents/)
})

test("errorPrompt surfaces the error and forbids subagents", () => {
  const p = errorPrompt("bad input")
  assert.match(p, /bad input/)
  assert.match(p, /do not start participant subagents/)
})

test("replaceParts replaces existing text in place", () => {
  const output = { parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "old" }] }
  replaceParts(output, "new")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "new")
  assert.equal(output.parts[0].id, "p1")
  assert.equal(output.parts[0].sessionID, "s1")
  assert.equal(output.parts[0].messageID, "m1")
})

test("replaceParts drops non-text parts", () => {
  const output = {
    parts: [
      { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "old" },
      { id: "p2", sessionID: "s1", messageID: "m1", type: "reasoning", text: "r", time: { start: 0 } },
    ],
  }
  replaceParts(output, "new")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "new")
})

test("replaceParts pushes a synthetic text part when no existing text", () => {
  const output = { parts: [] as Array<{ type: string; text?: string; [k: string]: unknown }> }
  replaceParts(output, "fresh")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "fresh")
})

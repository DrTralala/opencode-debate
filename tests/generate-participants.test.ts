import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEBATE_PARTICIPANT_SETS, DEBATE_PARTICIPANTS } from "../src/participants.ts"
import {
  checkParticipantAgents,
  renderCoordinatorAgent,
  renderParticipantAgent,
} from "../scripts/gen-participants.ts"

test("participant registry defines the supported sets", () => {
  assert.deepEqual(Object.keys(DEBATE_PARTICIPANT_SETS), ["default", "cheap"])
  assert.deepEqual(DEBATE_PARTICIPANT_SETS.default, ["debate-kimi", "debate-anthropic", "debate-openai"])
  assert.deepEqual(DEBATE_PARTICIPANT_SETS.cheap, ["debate-glm", "debate-qwen", "debate-kimi"])
})

test("participant registry contains metadata for every referenced agent", () => {
  const agents = new Set(DEBATE_PARTICIPANTS.map((participant) => participant.agent))
  for (const set of Object.values(DEBATE_PARTICIPANT_SETS)) {
    for (const agent of set) assert.equal(agents.has(agent), true, `${agent} missing from registry`)
  }
})

test("anthropic participant uses Claude Opus 5 through OpenRouter", () => {
  const participant = DEBATE_PARTICIPANTS.find((entry) => entry.agent === "debate-anthropic")

  assert.deepEqual(participant, {
    agent: "debate-anthropic",
    description: "Neutral debate participant using Claude Opus 5 through OpenRouter",
    model: "openrouter/anthropic/claude-opus-5",
    variant: "high",
  })
})

test("renderParticipantAgent combines participant metadata with the shared body", () => {
  const participant = DEBATE_PARTICIPANTS.find((entry) => entry.agent === "debate-openai")
  assert.ok(participant)

  const rendered = renderParticipantAgent(participant, "Shared participant instructions.\n")

  assert.match(rendered, /description: Neutral debate participant using OpenAI GPT-5.6 Sol \(xhigh\)/)
  assert.match(rendered, /model: openai\/gpt-5\.6-sol/)
  assert.match(rendered, /variant: xhigh/)
  assert.match(rendered, /permission:\n  "\*": "deny"/)
  assert.match(rendered, /  read:\n    "\*": "allow"/)
  assert.match(rendered, /    "\*\.env": "deny"/)
  assert.match(rendered, /    "\*\.env\.\*": "deny"/)
  assert.match(rendered, /    "\*\.env\.example": "allow"/)
  for (const tool of ["grep", "glob", "lsp", "webfetch", "websearch"]) {
    assert.match(rendered, new RegExp(`  ${tool}: allow`))
  }
  for (const tool of ["external_directory", "bash", "edit", "question", "task", "skill"]) {
    assert.match(rendered, new RegExp(`  ${tool}: deny`))
  }
  assert.doesNotMatch(rendered, /"find \*"|"echo \*"|"cat \*"|git (show|diff|log)/)
  assert.match(rendered, /Shared participant instructions\./)
  assert.equal(rendered.endsWith("\n"), true)
})

test("renderParticipantAgent omits variant when it is not configured", () => {
  const rendered = renderParticipantAgent({
    agent: "debate-new",
    description: "Neutral debate participant using provider/model",
    model: "provider/model",
  }, "Shared participant instructions.\n")

  assert.match(rendered, /model: provider\/model/)
  assert.doesNotMatch(rendered, /^variant:/m)
})

test("renderCoordinatorAgent replaces only coordinator task permissions", () => {
  const source = [
    "---",
    "description: Coordinator",
    "permission:",
    '  "*": "deny"',
    "  task:",
    '    "*": "deny"',
    '    "stale": "allow"',
    "  question: allow",
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n")

  const rendered = renderCoordinatorAgent(source, [
    { agent: "debate-one", description: "One", model: "provider/one" },
    { agent: "debate-two", description: "Two", model: "provider/two" },
  ])

  assert.equal(rendered, [
    "---",
    "description: Coordinator",
    "permission:",
    '  "*": "deny"',
    "  task:",
    '    "*": "deny"',
    '    "debate-one": "allow"',
    '    "debate-two": "allow"',
    "  question: allow",
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n"))
})

test("checkParticipantAgents reports generated-file drift without writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "debate-agents-"))
  const agentDir = join(dir, ".opencode", "agents")
  const body = "Shared participant instructions.\n"
  const participant = DEBATE_PARTICIPANTS[0]
  const stalePath = join(agentDir, `${participant.agent}.md`)
  const coordinatorPath = join(agentDir, "debate.md")

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(stalePath, "stale\n", { flush: true })
  writeFileSync(coordinatorPath, renderCoordinatorAgent([
    "---",
    "permission:",
    "  task:",
    '    "*": "deny"',
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n"), [participant]))
  const result = checkParticipantAgents({ root: dir, body, participants: [participant] })

  assert.deepEqual(result.changed, [`.opencode/agents/${participant.agent}.md`])
  assert.equal(readFileSync(stalePath, "utf8"), "stale\n")
})

test("checkParticipantAgents reports coordinator permission drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "debate-agents-"))
  const agentDir = join(dir, ".opencode", "agents")
  const body = "Shared participant instructions.\n"
  const participant = DEBATE_PARTICIPANTS[0]

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, `${participant.agent}.md`), renderParticipantAgent(participant, body))
  writeFileSync(join(agentDir, "debate.md"), [
    "---",
    "permission:",
    "  task:",
    '    "*": "deny"',
    '    "stale": "allow"',
    "---",
    "",
    "Coordinator body.",
    "",
  ].join("\n"))

  const result = checkParticipantAgents({ root: dir, body, participants: [participant] })

  assert.deepEqual(result.changed, [".opencode/agents/debate.md"])
})

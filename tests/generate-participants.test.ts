import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEBATE_PARTICIPANT_SETS, DEBATE_PARTICIPANTS } from "../src/participants.ts"
import { checkParticipantAgents, renderParticipantAgent } from "../scripts/gen-participants.ts"

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

test("renderParticipantAgent combines participant metadata with the shared body", () => {
  const participant = DEBATE_PARTICIPANTS.find((entry) => entry.agent === "debate-openai")
  assert.ok(participant)

  const rendered = renderParticipantAgent(participant, "Shared participant instructions.\n")

  assert.match(rendered, /description: Neutral debate participant using OpenAI GPT-5.6 Sol Pro/)
  assert.match(rendered, /model: openai\/gpt-5\.6-sol/)
  assert.match(rendered, /variant: xhigh/)
  assert.match(rendered, /edit: deny/)
  assert.match(rendered, /task: deny/)
  assert.match(rendered, /question: deny/)
  assert.match(rendered, /Shared participant instructions\./)
  assert.equal(rendered.endsWith("\n"), true)
})

test("checkParticipantAgents reports generated-file drift without writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "debate-agents-"))
  const agentDir = join(dir, ".opencode", "agents")
  const body = "Shared participant instructions.\n"
  const participant = DEBATE_PARTICIPANTS[0]
  const stalePath = join(agentDir, `${participant.agent}.md`)

  mkdirSync(agentDir, { recursive: true })
  writeFileSync(stalePath, "stale\n", { flush: true })
  const result = checkParticipantAgents({ root: dir, body, participants: [participant] })

  assert.deepEqual(result.changed, [`.opencode/agents/${participant.agent}.md`])
  assert.equal(readFileSync(stalePath, "utf8"), "stale\n")
})

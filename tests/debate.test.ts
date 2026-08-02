import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type { Part } from "@opencode-ai/sdk"
import {
  createDebatePlugin,
  errorPrompt,
  parseDebateArguments,
  replaceParts,
  trimSurroundingQuotes,
  validPrompt,
} from "../src/debate.ts"
import { DEBATE_PARTICIPANTS, DebateConfigError, type DebateRegistry } from "../src/participants.ts"
import {
  COORDINATOR_PROMPT,
  PARTICIPANT_PERMISSION,
  PARTICIPANT_PROMPT,
  buildCoordinatorPrompt,
  coordinatorPermission,
  createServer,
  htmlGeneratorCommand,
  participantTaskPermission,
} from "../index.ts"

function markdownBody(source: string): string {
  const match = /^---\n[\s\S]*?\n---\n\n([\s\S]*)$/.exec(source)
  assert.ok(match, "expected YAML frontmatter")
  return match[1].trimEnd()
}

const DYNAMIC_REGISTRY: DebateRegistry = {
  participants: [
    { agent: "one", description: "One", model: "provider/one" },
    { agent: "two", description: "Two", model: "provider/two" },
    { agent: "three", description: "Three", model: "provider/three" },
    { agent: "four", description: "Four", model: "provider/four" },
    { agent: "five", description: "Five", model: "provider/five" },
    { agent: "six", description: "Six", model: "provider/six" },
  ],
  sets: {
    default: ["one", "two", "three"],
    custom: ["four", "five", "six"],
  },
  continuationBySet: {
    default: "ask",
    custom: "discretion",
  },
  defaultSet: "custom",
}

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

test("configured set names are accepted dynamically", () => {
  const result = parseDebateArguments("--set:custom compare two options", DYNAMIC_REGISTRY)

  assert.deepEqual(result, {
    ok: true,
    topic: "compare two options",
    rounds: 3,
    set: "custom",
  })
})

test("set errors list the dynamically configured choices", () => {
  const result = parseDebateArguments("--set:missing compare two options", DYNAMIC_REGISTRY)

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /--set:default/)
    assert.match(result.error, /--set:custom/)
    assert.doesNotMatch(result.error, /--set:cheap/)
  }
})

test("inherited object properties are not accepted as configured sets", () => {
  const result = parseDebateArguments("--set:toString compare two options", DYNAMIC_REGISTRY)

  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /Unsupported --set value/)
})

test("configured default set is used when --set is absent", () => {
  assert.deepEqual(parseDebateArguments("compare two options", DYNAMIC_REGISTRY), {
    ok: true,
    topic: "compare two options",
    rounds: 3,
    set: "custom",
  })
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

test("validPrompt resolves participants from supplied sets", () => {
  const prompt = validPrompt("my topic", 2, "custom", "abc123", DYNAMIC_REGISTRY.sets)

  assert.match(prompt, /Participant set: custom/)
  assert.match(prompt, /Participant 1: four/)
  assert.match(prompt, /Participant 2: five/)
  assert.match(prompt, /Participant 3: six/)
})

test("validPrompt defaults an omitted continuation mode to ask", () => {
  const prompt = validPrompt("my topic", 2, "custom", "abc123", DYNAMIC_REGISTRY.sets)

  assert.match(prompt, /^Continuation mode: ask$/m)
})

test("validPrompt emits an explicit discretion continuation mode", () => {
  const prompt = validPrompt(
    "my topic",
    2,
    "custom",
    "abc123",
    DYNAMIC_REGISTRY.sets,
    "discretion",
  )

  assert.match(prompt, /^Continuation mode: discretion$/m)
})

test("createDebatePlugin propagates each selected set's continuation mode", async () => {
  const hooks = await createDebatePlugin(DYNAMIC_REGISTRY)({} as never)
  const before = hooks["command.execute.before"]
  assert.ok(before)

  for (const [set, continuation] of [["default", "ask"], ["custom", "discretion"]] as const) {
    const output: { parts: Part[] } = { parts: [] }
    await before({ command: "debate", arguments: `--set:${set} my topic` } as never, output)

    assert.equal(output.parts[0]?.type, "text")
    assert.match(output.parts[0]?.text ?? "", new RegExp(`^Continuation mode: ${continuation}$`, "m"))
  }
})

test("createDebatePlugin uses one registry for parsing and prompt resolution", async () => {
  const plugin = createDebatePlugin(DYNAMIC_REGISTRY)
  const hooks = await plugin({} as never)
  const before = hooks["command.execute.before"]
  assert.ok(before)
  const output: { parts: Part[] } = { parts: [] }

  await before({ command: "debate", arguments: "--set:custom my topic" } as never, output)

  assert.equal(output.parts[0]?.type, "text")
  assert.match(output.parts[0]?.text ?? "", /Participant 1: four/)
})

test("configured default set reaches prompt participant resolution", async () => {
  const hooks = await createDebatePlugin(DYNAMIC_REGISTRY)({} as never)
  const before = hooks["command.execute.before"]
  assert.ok(before)
  const output: { parts: Part[] } = { parts: [] }

  await before({ command: "debate", arguments: "my topic" } as never, output)

  const firstPart = output.parts[0]
  assert.equal(firstPart?.type, "text")
  if (firstPart?.type === "text") {
    assert.match(firstPart.text, /Participant set: custom/)
    assert.match(firstPart.text, /Participant 1: four/)
  }
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

test("static and plugin participant prompts are identical", () => {
  const body = readFileSync(new URL("../scripts/debate-participant-body.md", import.meta.url), "utf8")
  assert.equal(PARTICIPANT_PROMPT, body.trimEnd())
})

test("static and project-local coordinator prompts are identical", () => {
  const source = readFileSync(new URL("../.opencode/agents/debate.md", import.meta.url), "utf8")
  assert.equal(COORDINATOR_PROMPT, markdownBody(source))
})

test("coordinator formats every participant response before storing or forwarding it", () => {
  assert.match(COORDINATOR_PROMPT, /after every participant response/i)
  assert.match(COORDINATOR_PROMPT, /`format_debate_response`/)
  assert.match(COORDINATOR_PROMPT, /schema `round1` for round 1 and `round2` for later rounds/)
  assert.match(COORDINATOR_PROMPT, /before storing or forwarding/)
  assert.match(COORDINATOR_PROMPT, /Use only the canonical JSON returned by the formatter/)
})

test("coordinator uses syntax-only repairs and exact diagnostics until formatting succeeds", () => {
  assert.match(COORDINATOR_PROMPT, /syntax-preserving repair/i)
  assert.match(COORDINATOR_PROMPT, /semantic\/schema errors.*exact diagnostic.*resumed participant/i)
  assert.match(COORDINATOR_PROMPT, /exact diagnostic/i)
  assert.match(COORDINATOR_PROMPT, /repeat until .*successful/i)
  assert.match(COORDINATOR_PROMPT, /record .*failed .* under `## JSON Parsing Problems`/i)
  assert.match(COORDINATOR_PROMPT, /Never infer .*status/i)
  assert.doesNotMatch(COORDINATOR_PROMPT, /strip any markdown code fence, then extract the substring/)
  assert.doesNotMatch(COORDINATOR_PROMPT, /treat both statuses for that participant as `false`/)
})

test("syntax repairs are resubmitted and repeated until canonical formatter output", () => {
  const syntaxRepairClause = /^- If the formatter reports a syntax error,[^\n]+$/m.exec(COORDINATOR_PROMPT)?.[0]
  assert.ok(syntaxRepairClause)
  assert.match(syntaxRepairClause, /resubmit the repaired response to `format_debate_response`/)
  assert.match(syntaxRepairClause, /repeat syntax-preserving repair attempts until the formatter returns canonical output/)
})

test("coordinator preserves task failure retry and abort handling separately from formatting", () => {
  assert.match(COORDINATOR_PROMPT, /If a participant task fails, times out, or returns empty output, retry that participant once/)
  assert.match(COORDINATOR_PROMPT, /If it fails again, stop the debate and produce a final synthesis/)
  assert.match(COORDINATOR_PROMPT, /Formatting failures are not participant task failures/)
})

test("coordinator applies ask and discretion continuation modes without a hard cap", () => {
  assert.match(COORDINATOR_PROMPT, /`ask` mode.*Question tool/s)
  assert.match(COORDINATOR_PROMPT, /`discretion` mode/s)
  assert.match(COORDINATOR_PROMPT, /Question, one autonomous extra round, or synthesis/s)
  assert.match(COORDINATOR_PROMPT, /three false `consensus_reached` values.*guidance, not a hard trigger/s)
  assert.match(COORDINATOR_PROMPT, /re-evaluate after each extension/is)
  assert.match(COORDINATOR_PROMPT, /no hard extension cap/s)
})

test("coordinator continuation status matrix scopes all-recommend-stopping to ask mode", () => {
  const statusMatrix = [
    {
      state: "consensus is not unanimous and all recommend stopping in discretion mode",
      expected: /In `discretion` mode[^\n]+always make the three-way choice[^\n]+including when all participants recommend stopping but ordinary early stop did not trigger/,
    },
    {
      state: "consensus is not unanimous and all recommend stopping in ask mode",
      expected: /In `ask` mode[^\n]+if all participants recommend stopping, proceed to final synthesis/,
    },
    {
      state: "all consensus and stopping statuses are true in either mode",
      expected: /stop early only if all participants' latest `consensus_reached` and `recommend_stopping` values are both `true`/,
    },
    {
      state: "at least one participant recommends continuing in ask mode",
      expected: /In `ask` mode[^\n]+at least one participant's latest `recommend_stopping` is `false`, use the Question tool/,
    },
  ]

  for (const { state, expected } of statusMatrix) {
    assert.match(COORDINATOR_PROMPT, expected, state)
  }
  assert.doesNotMatch(
    COORDINATOR_PROMPT,
    /after all participants recommend stopping at `effective_max_rounds`/,
  )
})

test("coordinator retains the request topic token in the multiline transcript topic block", () => {
  assert.match(COORDINATOR_PROMPT, /retain the request topic token/is)
  assert.match(COORDINATOR_PROMPT, /\*\*Topic:\*\* <!-- BEGIN TOPIC <token> -->/)
  assert.match(COORDINATOR_PROMPT, /<topic copied verbatim>/)
  assert.match(COORDINATOR_PROMPT, /<!-- END TOPIC <token> -->/)
})

test("installed generator command is safely quoted and substituted exactly", () => {
  const command = htmlGeneratorCommand("file:///tmp/plugin%20dir/index.ts")
  assert.equal(command, "python3 '/tmp/plugin dir/scripts/generate_html.py' --latest")
  const prompt = buildCoordinatorPrompt(command)
  assert.equal(prompt.split(command).length - 1, 1)
  assert.doesNotMatch(prompt, /__HTML_GENERATOR_COMMAND__/)
})

test("installed generator command escapes apostrophes for the shell", () => {
  const command = htmlGeneratorCommand("file:///tmp/plugin%27dir/index.ts")
  assert.equal(command, "python3 '/tmp/plugin'\"'\"'dir/scripts/generate_html.py' --latest")
})

test("task permissions are derived from the participant registry", () => {
  assert.deepEqual(participantTaskPermission(), {
    "*": "deny",
    ...Object.fromEntries(DEBATE_PARTICIPANTS.map(({ agent }) => [agent, "allow"])),
  })
})

test("runtime registration uses every effective participant and omits absent variants", async () => {
  let loads = 0
  const server = createServer(() => {
    loads++
    return DYNAMIC_REGISTRY
  })
  const hooks = await server({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const configHook = hooks.config
  assert.ok(configHook)
  const config: any = {
    permission: {
      bash: "allow",
      task: {
        one: "allow",
        "*": "allow",
        general: "ask",
      },
    },
    agent: {
      build: {
        permission: {
          edit: "allow",
          task: {
            one: "allow",
            "*": "allow",
          },
        },
      },
      reviewer: { permission: "allow" },
    },
  }

  await configHook(config)

  assert.equal(loads, 1)
  assert.deepEqual(Object.keys(config.agent).sort(), [
    "build",
    "debate",
    "five",
    "four",
    "one",
    "reviewer",
    "six",
    "three",
    "two",
  ])
  assert.equal(config.agent.one.model, "provider/one")
  assert.equal(Object.hasOwn(config.agent.one, "variant"), false)
  assert.deepEqual(config.permission, {
    bash: "allow",
    format_debate_response: "deny",
    task: {
      "*": "allow",
      general: "ask",
      one: "deny",
      two: "deny",
      three: "deny",
      four: "deny",
      five: "deny",
      six: "deny",
    },
  })
  assert.deepEqual(config.agent.build.permission, {
    edit: "allow",
    format_debate_response: "deny",
    task: {
      "*": "allow",
      one: "deny",
      two: "deny",
      three: "deny",
      four: "deny",
      five: "deny",
      six: "deny",
    },
  })
  assert.deepEqual(config.agent.reviewer.permission, {
    "*": "allow",
    format_debate_response: "deny",
    task: {
      one: "deny",
      two: "deny",
      three: "deny",
      four: "deny",
      five: "deny",
      six: "deny",
    },
  })
  for (const name of ["one", "two", "three", "four", "five", "six"]) {
    assert.equal(config.agent[name].hidden, true)
    assert.equal(config.agent[name].permission.bash, "ask")
    assert.equal(config.agent[name].permission.task, "deny")
  }
  assert.deepEqual(config.agent.debate.permission.task, {
    "*": "deny",
    one: "allow",
    two: "allow",
    three: "allow",
    four: "allow",
    five: "allow",
    six: "allow",
  })
})

test("configuration failures are logged once and abort plugin initialisation", async () => {
  const error = new DebateConfigError("/tmp/bad.yaml", "participants.bad.model", "expected a non-empty string")
  const logs: unknown[] = []
  const server = createServer(() => {
    throw error
  })

  await assert.rejects(
    server({
      client: {
        app: {
          log: async (entry: unknown) => {
            logs.push(entry)
            return { data: true }
          },
        },
      },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as never),
    (thrown: unknown) => thrown === error,
  )
  assert.deepEqual(logs, [{
    body: {
      service: "opencode-debate",
      level: "error",
      message: error.message,
    },
  }])
})

test("a logging failure does not mask the configuration failure", async () => {
  const error = new DebateConfigError("/tmp/bad.yaml", "$", "bad YAML")
  const server = createServer(() => {
    throw error
  })

  await assert.rejects(
    server({
      client: { app: { log: async () => { throw new Error("logging unavailable") } } },
      directory: "/tmp/project",
      worktree: "/tmp/project",
    } as never),
    (thrown: unknown) => thrown === error,
  )
})

test("participant permissions require shell approval and deny external access", () => {
  assert.equal(PARTICIPANT_PERMISSION["*"], "deny")
  assert.equal(PARTICIPANT_PERMISSION.bash, "ask")
  assert.equal(PARTICIPANT_PERMISSION.external_directory, "deny")
  assert.deepEqual(PARTICIPANT_PERMISSION.read, {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
  })
})

test("coordinator permits only date and the exact generator command in Bash", () => {
  const command = "python3 '/tmp/plugin/scripts/generate_html.py' --latest"
  const permission = coordinatorPermission(command)
  assert.deepEqual(permission.bash, {
    "*": "deny",
    "date -u +%Y-%m-%dT%H-%M-%SZ": "allow",
    [command]: "allow",
  })
  assert.equal(permission["*"], "deny")
  assert.equal(permission.external_directory, "deny")
})

test("coordinator permits transcript paths relative to the OpenCode worktree", () => {
  const permission = coordinatorPermission(
    "python3 generator.py",
    "/tmp/worktree/consumer",
    "/tmp/worktree",
  )

  assert.deepEqual(permission.edit, {
    "*": "deny",
    "docs/debates/**": "allow",
    "consumer/docs/debates/**": "allow",
  })
})

test("static coordinator task permissions contain every registry agent", () => {
  const source = readFileSync(new URL("../.opencode/agents/debate.md", import.meta.url), "utf8")
  for (const { agent } of DEBATE_PARTICIPANTS) {
    assert.match(source, new RegExp(`^    "${agent}": "allow"$`, "m"))
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
  const output: { parts: Part[] } = {
    parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "old" }],
  }
  replaceParts(output, "new")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "new")
  assert.equal(output.parts[0].id, "p1")
  assert.equal(output.parts[0].sessionID, "s1")
  assert.equal(output.parts[0].messageID, "m1")
})

test("replaceParts drops non-text parts", () => {
  const output: { parts: Part[] } = {
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
  const output: { parts: Part[] } = { parts: [] }
  replaceParts(output, "fresh")
  assert.equal(output.parts.length, 1)
  assert.equal(output.parts[0].type, "text")
  assert.equal(output.parts[0].text, "fresh")
})

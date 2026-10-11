import assert from "node:assert/strict"
import { test } from "node:test"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "../index.ts"
import { createAutomaticDebatePlugin, automaticParticipantAgentName } from "../src/auto-debate/plugin.ts"
import type { DebateRegistry } from "../src/participants.ts"
import type { Owner, Rule } from "../src/auto-debate/types.ts"

type RecordValue = Record<string, unknown>

const ownerA: Owner = { sessionID: "main-a", agent: "build", directory: "/automatic-debate-project" }
const ownerB: Owner = { sessionID: "main-b", agent: "build", directory: "/automatic-debate-project" }
const panel = ["one", "two", "three"] as const
const registry: DebateRegistry = {
  participants: panel.map((agent) => ({ agent, description: `Participant ${agent}`, model: `fake/${agent}`,
    ...(agent === "one" ? { variant: "careful" } : {}) })),
  sets: { default: panel },
  defaultSet: "default",
}
const brief = {
  question: "Which option is safer?",
  objective: "Choose a safe option",
  facts: ["The system is shared."],
  assumptions: [],
  constraints: ["Do not lose existing data."],
  alternatives: ["A", "B"],
  uncertainty: "Failure behaviour is not known.",
  neededOutcome: "A recommendation",
}

function response(data: unknown) { return { data } }
function clone<T>(value: T): T { return structuredClone(value) }

function fakeInput() {
  const projectID = "automatic-debate-project"
  const sessions = new Map<string, RecordValue>()
  const histories = new Map<string, RecordValue[]>()
  const calls: { method: string; id?: string; agent?: string; title?: string }[] = []
  let nextSession = 0
  let participantCalls = 0
  const addOwner = (owner: Owner) => sessions.set(owner.sessionID, {
    id: owner.sessionID,
    projectID,
    directory: owner.directory,
    agent: owner.agent,
    model: { providerID: "fake", id: "main-model" },
    permission: [],
    metadata: {},
  })
  addOwner(ownerA)
  addOwner(ownerB)
  addOwner({ sessionID: "main-research", agent: "research-primary", directory: ownerA.directory })
  addOwner({ sessionID: "manual-coordinator", agent: "debate", directory: ownerA.directory })
  addOwner({ sessionID: "specialist-session", agent: "reviewer", directory: ownerA.directory })
  addOwner({ sessionID: "hidden-main-session", agent: "hidden_system", directory: ownerA.directory })
  const status: Record<string, { type: string }> = {}
  const session = {
    get: async (request: { path: { id: string } }) => {
      const value = sessions.get(request.path.id)
      calls.push({ method: "session.get", id: request.path.id })
      return value ? response(clone(value)) : { error: { name: "NotFoundError" }, response: new Response(null, { status: 404 }) }
    },
    children: async (request: { path: { id: string } }) => response([...sessions.values()]
      .filter((value) => value.parentID === request.path.id).map(clone)),
    create: async (request: { query?: RecordValue; body: RecordValue }) => {
      const body = request.body
      const id = `child-${++nextSession}`
      const value = { ...clone(body), id, projectID, directory: ownerA.directory }
      sessions.set(id, value)
      histories.set(id, [])
      calls.push({ method: "session.create", id, agent: String(body.agent), title: String(body.title ?? "") })
      if (String(body.title ?? "").startsWith("Automatic debate participant:")) participantCalls++
      return response(clone(value))
    },
    status: async () => response({
      ...Object.fromEntries([...sessions.keys()].map((id) => [id, status[id] ?? { type: "idle" }])),
    }),
    messages: async (request: { path: { id: string } }) => response(clone(histories.get(request.path.id) ?? [])),
    message: async (request: { path: { id: string; messageID: string } }) => {
      const found = histories.get(request.path.id)?.find((value) => (value.info as RecordValue).id === request.path.messageID)
      return found ? response(clone(found)) : {
        error: { name: "NotFoundError" },
        response: new Response(null, { status: 404 }),
      }
    },
    prompt: async (request: { path: { id: string }; body: RecordValue }) => {
      const body = request.body
      const messageID = String(body.messageID)
      const parts = body.parts as RecordValue[]
      const user = {
        info: {
          id: messageID,
          sessionID: request.path.id,
          role: "user",
          agent: body.agent,
          model: { ...(body.model as RecordValue), ...(body.variant === undefined ? {} : { variant: body.variant }) },
          ...(body.variant === undefined ? {} : { variant: body.variant }),
          time: { created: 1 },
        },
        parts: parts.map((part, index) => ({ ...clone(part), id: `${messageID}-part-${index}`,
          sessionID: request.path.id, messageID })),
      }
      const history = histories.get(request.path.id) ?? []
      histories.set(request.path.id, history)
      history.push(user)
      if (body.noReply === true) return response(clone(user))

      participantCalls++
      const text = String(parts[0]?.text ?? "")
      const roundOne = text.includes("Response schema: round1")
      const answer = roundOne
        ? JSON.stringify({ turn: "Independent finding" })
        : JSON.stringify({ turn: "Converged finding", consensus_reached: true, recommend_stopping: true })
      const assistantID = `assistant-${messageID}`
      const assistant = {
        info: {
          id: assistantID,
          sessionID: request.path.id,
          role: "assistant",
          parentID: messageID,
          time: { created: 2, completed: 3 },
          finish: "stop",
        },
        parts: [{ id: `${assistantID}-part`, sessionID: request.path.id, messageID: assistantID,
          type: "text", text: answer }],
      }
      history.push(assistant)
      return response(clone(assistant))
    },
    promptAsync: async (request: { path: { id: string }; body: RecordValue }) => {
      const body = request.body
      const messageID = String(body.messageID)
      const parts = body.parts as RecordValue[]
      const history = histories.get(request.path.id) ?? []
      histories.set(request.path.id, history)
      history.push({
        info: { id: messageID, sessionID: request.path.id, role: "user", agent: body.agent,
          model: body.model, time: { created: 4 } },
        parts: parts.map((part, index) => ({ ...clone(part), id: `${messageID}-part-${index}`,
          sessionID: request.path.id, messageID })),
      })
      calls.push({ method: "session.promptAsync", id: request.path.id, agent: String(body.agent) })
      return response(undefined)
    },
    abort: async (request: { path: { id: string } }) => {
      calls.push({ method: "session.abort", id: request.path.id })
      return response(true)
    },
  }
  const agents = [
    { name: "build", mode: "primary", permission: [] },
    { name: "plan", mode: "primary", permission: [] },
    { name: "research-primary", mode: "all", permission: [] },
    { name: "debate", mode: "primary", permission: [] },
    { name: "reviewer", mode: "subagent", permission: [] },
    { name: "hidden_system", mode: "primary", permission: [] },
    ...panel.map((agent) => ({ name: automaticParticipantAgentName(agent), mode: "subagent", permission: [] })),
  ]
  const input = {
    client: {
      session,
      app: { agents: async () => response(agents) },
    },
    project: { id: projectID },
    directory: ownerA.directory,
    worktree: ownerA.directory,
  } as unknown as PluginInput
  return { input, sessions, histories, calls, agents, participantCalls: () => participantCalls }
}

function enabledRegistry(): DebateRegistry {
  return { ...registry, autoDebate: { enabled: true, maxRounds: 3, persistTranscripts: false } }
}

function configFixture() {
  return {
    permission: {},
    agent: {
      build: { mode: "primary", permission: {} },
      plan: { mode: "primary", permission: {} },
      "research-primary": { mode: "all", permission: {} },
      debate: { mode: "primary", hidden: true, permission: {} },
      reviewer: { mode: "subagent", permission: {} },
      hidden_system: { mode: "primary", hidden: true, permission: {} },
    },
    command: {},
  }
}

async function makePlugin(value: DebateRegistry = registry) {
  const fake = fakeInput()
  const hooks = await createAutomaticDebatePlugin(value)(fake.input)
  const config = configFixture()
  await hooks.config?.(config as never)
  return { ...fake, hooks, config }
}

function toolContext(owner: Owner) {
  return {
    sessionID: owner.sessionID,
    agent: owner.agent,
    directory: owner.directory,
    worktree: owner.directory,
    messageID: "message-1",
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  }
}

function currentNativeInvocation(fake: ReturnType<typeof fakeInput>, args: RecordValue, suffix = "first") {
  const messageID = `native-assistant-${suffix}`
  const callID = `native-call-${suffix}`
  const part = { id: `native-part-${suffix}`, sessionID: ownerA.sessionID, messageID,
    type: "tool", tool: "auto_debate", callID, state: { status: "running", input: args, time: { start: 2 } } }
  const history = fake.histories.get(ownerA.sessionID) ?? []
  history.push({ info: { id: messageID, sessionID: ownerA.sessionID, role: "assistant", agent: ownerA.agent,
    parentID: "native-user", time: { created: 1 } }, parts: [part] })
  fake.histories.set(ownerA.sessionID, history)
  return { ...toolContext(ownerA), messageID, callID }
}

function finishNativeRefusal(fake: ReturnType<typeof fakeInput>, context: ReturnType<typeof currentNativeInvocation>) {
  const message = fake.histories.get(ownerA.sessionID)!.find((message) => (message.info as RecordValue).id === context.messageID)!
  const info = message.info as RecordValue
  info.time = { ...(info.time as RecordValue), completed: 4 }
  const part = (message.parts as RecordValue[]).find((part) => part.callID === context.callID)!
  part.state = { ...(part.state as RecordValue), status: "error", error: "The user rejected permission to use this specific tool call.",
    time: { start: 2, end: 3 } }
  return { message, part }
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output
  assert.ok(output && typeof output === "object" && "output" in output)
  return String((output as { output: unknown }).output)
}

async function execute(hooks: Hooks, args: RecordValue, owner: Owner = ownerA): Promise<unknown> {
  const definition = hooks.tool?.auto_debate
  assert.ok(definition, "auto_debate tool is registered")
  return definition.execute(args, toolContext(owner))
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error("Timed out waiting for automatic-debate state")
}

test("automatic debate is disabled by default and a start makes no participant or transcript work", async () => {
  const { hooks, participantCalls, calls } = await makePlugin()
  await assert.rejects(execute(hooks, { action: "start", brief }), /disabled/i)

  assert.equal(participantCalls(), 0)
  assert.equal(calls.some((call) => call.method === "session.create" && call.title?.startsWith("Automatic debate participant:")), false)
  assert.equal(calls.some((call) => call.method === "session.promptAsync"), false)
})

test("eligible main agents receive uncertainty-trigger guidance through the permission-scoped tool description", async () => {
  const { hooks, config } = await makePlugin()
  const definition = hooks.tool?.auto_debate
  assert.ok(definition)
  assert.match(definition.description, /material uncertainty/i)
  assert.match(definition.description, /independent specialist/i)
  assert.match(definition.description, /do not enable/i)
  assert.match(definition.description, /evaluat/i)
  assert.equal((config.permission as RecordValue).auto_debate, "deny")
  assert.equal(((config.agent as Record<string, RecordValue>).build.permission as RecordValue).auto_debate, "allow")
  assert.equal((((config.agent as Record<string, RecordValue>).reviewer.permission as RecordValue).auto_debate), "deny")
  assert.equal((((config.agent as Record<string, RecordValue>).hidden_system.permission as RecordValue).auto_debate), "deny")

  const freshMainSystem = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: ownerA.sessionID, model: {} as never }, freshMainSystem)
  assert.deepEqual(freshMainSystem.system, [], "guidance must not be globally injected before a verified owner exists")
})

test("plugin config uses its supplied agent modes without a re-entrant native agent lookup", async () => {
  const fake = fakeInput()
  const app = (fake.input as unknown as { client: { app: { agents: (...args: never[]) => Promise<unknown> } } }).client.app
  const nativeAgents = app.agents.bind(app)
  let lookups = 0
  app.agents = (async (...args: never[]) => { lookups++; return nativeAgents(...args) }) as typeof app.agents
  const hooks = await createAutomaticDebatePlugin(registry)(fake.input)
  const config = configFixture()

  await hooks.config?.(config as never)

  assert.equal(lookups, 0, "the config hook must not call back into app.agents while OpenCode is resolving config")
  assert.equal(((config.agent as Record<string, RecordValue>).build.permission as RecordValue).auto_debate, "allow")
})

test("config enables native visible primary agents omitted from user agent settings", async () => {
  const fake = fakeInput()
  const hooks = await createAutomaticDebatePlugin(registry)(fake.input)
  const config = { permission: {}, agent: {}, command: {} }

  await hooks.config?.(config as never)

  const agents = config.agent as Record<string, RecordValue>
  assert.equal(agents.build.mode, "primary")
  assert.equal(agents.plan.mode, "primary")
  assert.equal((agents.build.permission as RecordValue).auto_debate, "allow")
  assert.equal((agents.plan.permission as RecordValue).auto_debate, "allow")
  assert.equal(agents.general, undefined, "the default subagent must not receive automatic-debate access")
})

test("debate-auto controls are exact, session-scoped, persisted, and do not dispatch", async () => {
  const { hooks, participantCalls, input, sessions, config } = await makePlugin()
  const commandConfig = (config.command as Record<string, RecordValue>)["debate-auto"]
  assert.ok(commandConfig)
  assert.equal(Object.hasOwn(commandConfig, "agent"), false, "the command must not switch the active agent")
  assert.equal((sessions.get(ownerA.sessionID) as RecordValue).agent, ownerA.agent)
  const before = hooks["command.execute.before"]
  assert.ok(before)
  const command = async (owner: Owner, arguments_: string, name = "debate-auto") => {
    const output: { parts: never[] } = { parts: [] }
    await before({ command: name, sessionID: owner.sessionID, arguments: arguments_ }, output as never)
    return output
  }

  const untouched = await command(ownerA, "on", "debate-auto-extra")
  assert.equal(untouched.parts.length, 0)

  const enabled = await command(ownerA, "on")
  const enabledText = JSON.stringify(enabled.parts)
  assert.match(enabledText, /enabled/i)
  assert.match(enabledText, /Do not start a debate just to answer this command\./)
  assert.equal((sessions.get(ownerA.sessionID) as RecordValue).agent, ownerA.agent)
  assert.match(JSON.stringify((await command(ownerA, "status")).parts), /enabled/i)
  assert.match(JSON.stringify((await command(ownerB, "status")).parts), /disabled/i)

  const restarted = await createAutomaticDebatePlugin(registry)(input)
  const restartedConfig = configFixture()
  await restarted.config?.(restartedConfig as never)
  const restartedOutput: { parts: never[] } = { parts: [] }
  await restarted["command.execute.before"]!({ command: "debate-auto", sessionID: ownerA.sessionID, arguments: "status" }, restartedOutput as never)
  assert.match(JSON.stringify(restartedOutput.parts), /enabled/i, "the command mutation is durable before returning")

  assert.match(JSON.stringify((await command(ownerA, "off")).parts), /disabled/i)
  assert.match(JSON.stringify((await command(ownerA, "reset")).parts), /configured default/i)
  assert.equal((sessions.get(ownerA.sessionID) as RecordValue).agent, ownerA.agent)
  assert.equal(participantCalls(), 0)

  const malformed = await command(ownerA, "on extra")
  assert.match(JSON.stringify(malformed.parts), /Invalid automatic debate control command/)
  assert.match(JSON.stringify(malformed.parts), /Do not start a debate just to answer this command\./)
})

test("off and reset controls persist across plugin recreation without participant work", async () => {
  const fake = await makePlugin(enabledRegistry())
  const command = async (hooks: Hooks, action: string) => {
    const before = hooks["command.execute.before"]
    assert.ok(before)
    const output: { parts: never[] } = { parts: [] }
    await before({ command: "debate-auto", sessionID: ownerA.sessionID, arguments: action }, output as never)
    return JSON.stringify(output.parts)
  }
  const newPlugin = async () => {
    const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
    const config = configFixture()
    await hooks.config?.(config as never)
    return hooks
  }

  assert.match(await command(fake.hooks, "off"), /disabled/i)
  const afterOff = await newPlugin()
  assert.match(await command(afterOff, "status"), /disabled/i, "off remains persisted in the same native checkpoint store")

  assert.match(await command(afterOff, "reset"), /configured default/i)
  const afterReset = await newPlugin()
  assert.match(await command(afterReset, "status"), /enabled/i, "reset removes the persisted override and restores the configured default")
  assert.equal(fake.participantCalls(), 0)
  assert.equal(fake.calls.some((call) => call.title?.startsWith("Automatic debate participant:")), false)
})

test("tool arguments are strict, native owner checks reject non-main sessions, and control actions do not dispatch", async () => {
  const { hooks, participantCalls } = await makePlugin()
  const definition = hooks.tool?.auto_debate
  assert.ok(definition)
  const briefSchema = definition.args.brief as unknown as { safeParse(value: unknown): { success: boolean } }
  assert.equal(briefSchema.safeParse({ ...brief, uncertainty: "" }).success, false)
  await assert.rejects(execute(hooks, { action: "start", brief: { ...brief, uncertainty: "" } }), /valid decision brief/i)
  await assert.rejects(execute(hooks, { action: "start" }), /missing|required|brief/i)
  await assert.rejects(execute(hooks, { action: "status", brief }), /irrelevant|unexpected|forbidden/i)
  await assert.rejects(execute(hooks, { action: "evaluate", discussion_id: "x", evaluation: {
    cycle: 1, conclusion: "x", caveats: [], rationale: "x", next: "act",
  }, feedback: "irrelevant" }), /unexpected|forbidden/i)
  await assert.rejects(execute(hooks, { action: "resume", discussion_id: "x", feedback: "x", reason: "obsolete" }), /unexpected|forbidden/i)
  await assert.rejects(execute(hooks, { action: "cancel", discussion_id: "x", reason: "explicit-stop", brief }), /unexpected|forbidden/i)
  await assert.rejects(execute(hooks, { action: "start", brief, surprise: true }), /unknown|unexpected|forbidden/i)
  await assert.rejects(execute(hooks, { action: "start", brief: { ...brief, surprise: true } }), /unknown|unexpected|forbidden/i)
  await assert.rejects(execute(hooks, { action: "status" }, { ...ownerA, sessionID: "manual-coordinator", agent: "debate" }), /owner|coordinator|main/i)
  await assert.rejects(execute(hooks, { action: "status" }, { ...ownerA, sessionID: "specialist-session", agent: "reviewer" }), /owner|primary|main/i)
  assert.equal(participantCalls(), 0)
})

test("direct tool calls reject a native child session and a hidden root agent", async () => {
  const { hooks, sessions, calls, participantCalls } = await makePlugin()
  const childID = "native-child-build"
  sessions.set(childID, {
    id: childID,
    projectID: "automatic-debate-project",
    directory: ownerA.directory,
    parentID: ownerA.sessionID,
    agent: "build",
    model: { providerID: "fake", id: "main-model" },
    permission: [],
    metadata: {},
  })

  await assert.rejects(execute(hooks, { action: "status" }, {
    sessionID: childID, agent: "build", directory: ownerA.directory,
  }), /root session|owner/i)
  await assert.rejects(execute(hooks, { action: "status" }, {
    sessionID: "hidden-main-session", agent: "hidden_system", directory: ownerA.directory,
  }), /permission-denied|visible main agent/i)

  assert.equal(participantCalls(), 0)
  assert.equal(calls.some((call) => call.method === "session.create"), false)
})

test("manager-backed start, findings, evaluated resume after off, and owned cancellation work through the tool", async () => {
  const { hooks, participantCalls, sessions } = await makePlugin(enabledRegistry())
  const start = JSON.parse(outputText(await execute(hooks, { action: "start", brief }))) as RecordValue
  const started = start.discussion as RecordValue
  assert.equal(started.status, "running")
  assert.equal(started.cycle, 1)
  assert.equal(started.maxRounds, 3)
  assert.deepEqual(started.participants, panel)

  const completed = await waitFor(async () => JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: started.id }))) as RecordValue,
    (value) => (value.discussion as RecordValue | undefined)?.status === "awaiting-evaluation")
  const result = completed.discussion as RecordValue
  const findings = result.canonicalFindings as RecordValue[]
  assert.equal(findings.length, 6)
  assert.equal((result.result as RecordValue).rounds, 2)
  assert.ok(findings.every((turn) => typeof turn.text === "string"))

  const systemOutput = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: ownerA.sessionID, model: {} as never }, systemOutput)
  assert.match(systemOutput.system.join("\n"), /bounded evidence-gathering aid/)
  assert.match(systemOutput.system.join("\n"), new RegExp(String(started.id)))
  const privateSession = [...sessions.values()].find((session) =>
    typeof session.agent === "string" && session.agent.startsWith("opencode-debate-auto-"))!
  const privateSystem = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!({ sessionID: String(privateSession.id), model: {} as never }, privateSystem)
  assert.deepEqual(privateSystem.system, [], "private participant sessions receive no main-agent instructions")

  const compacted = { context: [] as string[] }
  await hooks["experimental.session.compacting"]!({ sessionID: ownerA.sessionID }, compacted)
  assert.match(compacted.context.join("\n"), new RegExp(String(started.id)))
  assert.doesNotMatch(compacted.context.join("\n"), /Independent finding|Converged finding/)

  await execute(hooks, { action: "evaluate", discussion_id: started.id, evaluation: {
    cycle: 1,
    conclusion: "The findings support continuing.",
    caveats: ["One assumption remains."],
    rationale: "More focused evidence is useful.",
    next: "continue",
  } })
  const beforeOff = participantCalls()
  const control = hooks["command.execute.before"]
  assert.ok(control)
  const offOutput: { parts: unknown[] } = { parts: [] }
  await control({ command: "debate-auto", sessionID: ownerA.sessionID, arguments: "off" }, offOutput as never)
  const resumed = JSON.parse(outputText(await execute(hooks, {
    action: "resume", discussion_id: started.id, feedback: "Check the changed assumption.",
  }))) as RecordValue
  assert.equal((resumed.discussion as RecordValue).cycle, 2)

  const secondCycle = await waitFor(async () => JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: started.id }))) as RecordValue,
    (value) => (value.discussion as RecordValue | undefined)?.status === "awaiting-evaluation")
  assert.equal((secondCycle.discussion as RecordValue).cycle, 2)
  assert.equal(((secondCycle.discussion as RecordValue).result as RecordValue).rounds, 1)
  assert.ok(participantCalls() > beforeOff, "off does not prevent an evaluated continuation")

  const stopOutput: { parts: unknown[] } = { parts: [] }
  await control({ command: "debate-auto", sessionID: ownerB.sessionID, arguments: `stop ${started.id}` }, stopOutput as never)
  assert.match(JSON.stringify(stopOutput.parts), /Unknown discussion/)
  assert.equal(JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: started.id }))).discussion.status,
    "awaiting-evaluation", "another root session cannot stop this discussion")
  await assert.rejects(execute(hooks, { action: "cancel", discussion_id: started.id, reason: "explicit-stop" }, ownerB), /unknown|owner/i)
  const cancelled = JSON.parse(outputText(await execute(hooks, {
    action: "cancel", discussion_id: started.id, reason: "explicit-stop",
  }))) as RecordValue
  assert.equal((cancelled.discussion as RecordValue).status, "cancelled")
  assert.equal((cancelled.discussion as RecordValue).unconfirmedCancellation, undefined)
  assert.ok(participantCalls() <= 18, "manager retry attempts remain bounded by three rounds and one retry")
})

test("same-owner /debate-auto stop cancels its saved discussion", async () => {
  const { hooks } = await makePlugin(enabledRegistry())
  const started = JSON.parse(outputText(await execute(hooks, { action: "start", brief }))).discussion as RecordValue
  await waitFor(async () => JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: started.id }))) as RecordValue,
    (value) => (value.discussion as RecordValue | undefined)?.status === "awaiting-evaluation")

  const output: { parts: unknown[] } = { parts: [] }
  await hooks["command.execute.before"]!({
    command: "debate-auto", sessionID: ownerA.sessionID, arguments: `stop ${started.id}`,
  }, output as never)
  assert.match(JSON.stringify(output.parts), /cancelled/)
  assert.match(JSON.stringify(output.parts), /cessations confirmed/)
  const saved = JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: started.id }))) as RecordValue
  assert.equal((saved.discussion as RecordValue).status, "cancelled")
})

test("the user command hook stop all cancels two owned discussions and preserves another root's panel", async () => {
  const { hooks, calls } = await makePlugin(enabledRegistry())
  try {
    const first = JSON.parse(outputText(await execute(hooks, { action: "start", brief }))).discussion
    const second = JSON.parse(outputText(await execute(hooks, { action: "start", brief: { ...brief, question: "Second owned question" } }))).discussion
    const foreign = JSON.parse(outputText(await execute(hooks, { action: "start", brief }, ownerB))).discussion
    for (const [currentOwner, id] of [[ownerA, first.id], [ownerA, second.id], [ownerB, foreign.id]] as const) {
      await waitFor(async () => JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: id }, currentOwner))),
        (value) => value.discussion.status === "awaiting-evaluation")
    }
    const output = { parts: [] }
    await hooks["command.execute.before"]!({ command: "debate-auto", sessionID: ownerA.sessionID, arguments: "stop all" }, output)
    assert.match(JSON.stringify(output.parts), /cancelled/)
    assert.doesNotMatch(JSON.stringify(output.parts), /Unknown discussion|unavailable/)
    const owned = JSON.parse(outputText(await execute(hooks, { action: "status" }))).discussions
    assert.equal(owned.length, 2)
    assert.ok(owned.every((value: RecordValue) => value.status === "cancelled" && value.unconfirmedCancellation === undefined))
    assert.equal(JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: foreign.id }, ownerB))).discussion.status,
      "awaiting-evaluation")
    assert.equal(calls.filter((call) => call.method === "session.abort").length, 6)
  } finally { await hooks.dispose?.() }
})

test("only visible main agents receive the tool; private aliases are hidden, shell-denied, and Task-denied", async () => {
  const { hooks, config } = await makePlugin()
  const agents = config.agent as Record<string, RecordValue>
  assert.equal(agents.build.permission && (agents.build.permission as RecordValue).auto_debate, "allow")
  assert.equal((agents.debate.permission as RecordValue).auto_debate, "deny")
  assert.equal((agents.reviewer.permission as RecordValue).auto_debate, "deny")
  assert.equal((agents.hidden_system.permission as RecordValue).auto_debate, "deny")
  assert.equal((agents["research-primary"].permission as RecordValue).auto_debate, "allow")
  const researchStatus = JSON.parse(outputText(await execute(hooks, { action: "status" }, {
    sessionID: "main-research", agent: "research-primary", directory: ownerA.directory,
  }))) as RecordValue
  assert.equal(researchStatus.action, "status", "root identity is established from native session/agent evidence, not a hard-coded build agent")
  for (const participant of panel) {
    const alias = agents[automaticParticipantAgentName(participant)]
    assert.ok(alias)
    assert.equal(alias.hidden, true)
    assert.equal(alias.mode, "subagent")
    assert.equal(alias.model, `fake/${participant}`)
    assert.equal(alias.variant, participant === "one" ? "careful" : undefined)
    assert.equal((alias.permission as RecordValue).bash, "deny")
    assert.equal((alias.permission as RecordValue).task, "deny")
    assert.equal((alias.permission as RecordValue).auto_debate, "deny")
    assert.equal(((alias.permission as RecordValue).read as RecordValue)["*"], "allow")
    assert.equal(((alias.permission as RecordValue).read as RecordValue)["*.env"], "deny")
  }
  assert.equal((config.permission as RecordValue).auto_debate, "deny")
})

test("explicit root denial is not rewritten into an allow", async () => {
  const deniedRegistry = registry
  const fake = fakeInput()
  const hooks = await createAutomaticDebatePlugin(deniedRegistry)(fake.input)
  const config = configFixture()
  ;(config.agent.build.permission as RecordValue).auto_debate = "deny"
  await hooks.config?.(config as never)
  assert.equal((config.agent.build.permission as RecordValue).auto_debate, "deny")
  await assert.rejects(execute(hooks, { action: "status" }), /permission.*denied|denied.*permission/i)
})

test("an explicit owner-session tool denial remains effective after the agent-level allow", async () => {
  const fake = fakeInput()
  const root = fake.sessions.get(ownerA.sessionID)!
  root.permission = [{ permission: "auto_debate", pattern: "*", action: "deny" }]
  const app = (fake.input as unknown as { client: { app: { agents: (...args: never[]) => Promise<unknown> } } }).client.app
  const nativeAgents = app.agents.bind(app)
  app.agents = (async (...args: never[]) => {
    const result = await nativeAgents(...args) as { data: RecordValue[] }
    return { data: result.data.map((agent) => agent.name === "build"
      ? { ...agent, permission: [{ permission: "auto_debate", pattern: "*", action: "allow" }] }
      : agent) }
  }) as typeof app.agents
  const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
  await hooks.config?.(configFixture() as never)

  await assert.rejects(execute(hooks, { action: "status" }), /permission.*denied|denied.*permission/i)
})

test("native approval rejection precedes every automatic tool action and creates no child or dispatch", async () => {
  const fake = fakeInput()
  fake.agents.find((agent) => agent.name === "build")!.permission = [
    { permission: "auto_debate", pattern: "*", action: "deny" },
    { permission: "auto_debate", pattern: "*", action: "ask" },
  ] as never
  const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
  const config = configFixture()
  ;(config.agent.build.permission as RecordValue).auto_debate = "ask"
  await hooks.config?.(config as never)
  const requested: RecordValue[] = []
  const context = { ...toolContext(ownerA), ask: async (request: RecordValue) => {
    requested.push(request)
    throw new Error("Native approval rejected")
  } }
  const actions = [
    { action: "start", brief }, { action: "status" },
    { action: "evaluate", discussion_id: "existing", evaluation: {
      cycle: 1, conclusion: "Continue", caveats: [], rationale: "More evidence", next: "continue",
    } },
    { action: "resume", discussion_id: "existing", feedback: "Check the new fact" },
    { action: "cancel", discussion_id: "all", reason: "explicit-stop" },
  ]
  try {
    for (const args of actions) {
      await assert.rejects(hooks.tool!.auto_debate.execute(args, context), /Native approval rejected/)
    }
    assert.deepEqual(requested.map(({ permission, patterns, always }) => ({ permission, patterns, always })),
      ["start", "status", "evaluate", "resume", "cancel"].map((action) => ({
        permission: "auto_debate", patterns: [action], always: [action],
      })))
    assert.equal(fake.calls.some((call) => call.method === "session.create"), false)
    assert.equal(fake.participantCalls(), 0)
    assert.equal(fake.calls.some((call) => call.method === "session.promptAsync"), false)
  } finally { await hooks.dispose?.() }
})

test("full-plugin config preserves global and agent patterned restrictions and ordered wildcard permission names", async () => {
  const cases = [
    { global: { auto_debate: { "*": "deny" } }, agent: {}, want: "deny" },
    { global: {}, agent: { auto_debate: { "*": "deny" } }, want: "deny" },
    { global: { "auto_*": "deny" }, agent: {}, want: "deny" },
    { global: {}, agent: { "auto_?ebate": "deny" }, want: "deny" },
    { global: { auto_debate: "allow", "auto_*": "deny" }, agent: {}, want: "deny" },
    { global: { "auto_*": "deny", auto_debate: "ask" }, agent: {}, want: "ask" },
    { global: {}, agent: { auto_debate: "allow", "auto_*": "ask" }, want: "ask" },
    { global: { auto_debate: { "*": "ask" } }, agent: {}, want: "ask" },
    { global: {}, agent: { auto_debate: { "*": "ask" } }, want: "ask" },
    { global: { "auto_*": "deny" }, agent: { auto_debate: "allow" }, want: "deny" },
  ]
  for (const item of cases) {
    const fake = fakeInput()
    const hooks = await createServer(() => enabledRegistry())(fake.input)
    const config = configFixture()
    config.permission = item.global
    config.agent.build.permission = item.agent
    await hooks.config?.(config as never)
    const configured = (config.agent.build.permission as RecordValue).auto_debate
    const values = typeof configured === "string" ? [configured] : Object.values(configured as RecordValue)
    assert.ok(values.length > 0 && values.every((value) => value === item.want), JSON.stringify(item))
    assert.equal(fake.calls.length, 0)
  }
})

test("patterned permission denials match the action at each ordered native agent and session layer", async () => {
  for (const layer of ["agent", "session"] as const) {
    const fake = fakeInput()
    const rules: Rule[] = [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "auto_*", pattern: "st*", action: "deny" },
      { permission: "auto_?ebate", pattern: "status", action: "allow" },
    ]
    if (layer === "agent") fake.agents.find((agent) => agent.name === "build")!.permission = rules as never
    else fake.sessions.get(ownerA.sessionID)!.permission = rules
    const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
    await hooks.config?.(configFixture() as never)
    await assert.rejects(execute(hooks, { action: "start", brief }), /permission.*denied|denied.*permission/i, layer)
    const status = JSON.parse(outputText(await execute(hooks, { action: "status" })))
    assert.deepEqual(status.discussions, [], "later action-specific allows remain effective")
    assert.equal(fake.calls.some((call) => call.method === "session.create"), false)
    assert.equal(fake.participantCalls(), 0)
  }
})

test("config pattern order retains native action exceptions without a generated broad allow", async () => {
  const fake = fakeInput()
  const hooks = await createServer(() => enabledRegistry())(fake.input)
  const config = configFixture()
  config.permission = { "auto_*": { "*": "ask", "start *": "deny", status: "allow" } }
  config.agent.build.permission = { auto_debate: { resume: "deny" } }
  await hooks.config?.(config as never)
  const permission = (config.agent.build.permission as RecordValue).auto_debate as RecordValue
  assert.equal(typeof permission, "object")
  assert.equal(permission["*"], "ask")
  assert.equal(permission["start *"], "deny")
  assert.equal(permission.status, "allow")
  assert.equal(permission.resume, "deny")
})

test("config-enabled first native start and status initialise without a prior on command", async () => {
  for (const args of [{ action: "start", brief }, { action: "status" }]) {
    const fake = fakeInput()
    const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
    await hooks.config?.(configFixture() as never)
    const context = currentNativeInvocation(fake, args)
    await hooks["tool.execute.before"]?.({ tool: "auto_debate", sessionID: ownerA.sessionID, callID: context.callID }, { args })
    try {
      const result = JSON.parse(outputText(await hooks.tool!.auto_debate.execute(args, context)))
      assert.equal(result.action, args.action)
      const store = [...fake.sessions.values()].find((session) => session.title === "Automatic debate recovery checkpoints v1")!
      assert.ok(store, "first status also seals initial native state before its invocation becomes history")
      const first = fake.histories.get(String(store.id))![0]
      const wrapper = JSON.parse(String((first.parts as RecordValue[])[0].text).split("\n").slice(1).join("\n"))
      const payload = JSON.parse(wrapper.payload)
      assert.deepEqual(payload.runtimeProof.entries[0], { kind: "owner-invocation-admitted", messageID: context.messageID,
        callID: context.callID, partID: "native-part-first" })
      if (args.action === "start") {
        const id = result.discussion.id
        await waitFor(async () => JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: id }))),
          (value) => value.discussion.status === "awaiting-evaluation")
        assert.equal(fake.participantCalls(), 9, "three creates and six model prompts complete the first cycle")
      } else assert.equal(fake.participantCalls(), 0)
    } finally { await hooks.dispose?.() }
  }
})

test("first-use admission never exempts historical running parts or caller-only invocation strings", async () => {
  for (const evidence of ["historical-running", "unwitnessed", "different-call", "completed-message", "foreign-part"] as const) {
    const fake = fakeInput()
    const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
    await hooks.config?.(configFixture() as never)
    const args = { action: "start", brief }
    if (evidence === "historical-running") currentNativeInvocation(fake, args, "historical")
    const context = currentNativeInvocation(fake, args)
    if (evidence === "completed-message") (fake.histories.get(ownerA.sessionID)!.at(-1)!.info as RecordValue).time = { created: 1, completed: 3 }
    if (evidence === "foreign-part") (fake.histories.get(ownerA.sessionID)!.at(-1)!.parts as RecordValue[])[0].sessionID = ownerB.sessionID
    if (evidence !== "unwitnessed") await hooks["tool.execute.before"]?.({ tool: "auto_debate", sessionID: ownerA.sessionID,
      callID: evidence === "different-call" ? "unrelated-call" : context.callID }, { args })
    await assert.rejects(hooks.tool!.auto_debate.execute(args, context), /history|evidence|invocation|binding/i, evidence)
    const output = { parts: [] }
    await hooks["command.execute.before"]!({ command: "debate-auto", sessionID: ownerA.sessionID, arguments: "on" }, output)
    assert.match(JSON.stringify(output.parts), /unconfirmed|evidence|history/i, "failed recovery must remain fail-closed")
    assert.equal(fake.calls.some((call) => call.method === "session.create"), false)
    assert.equal(fake.participantCalls(), 0)
  }
})

test("a host-witnessed first refusal allows a later approved start in the same retained runtime without pre-approval children", async () => {
  const fake = fakeInput()
  const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
  const config = configFixture()
  ;(config.agent.build.permission as RecordValue).auto_debate = "ask"
  await hooks.config?.(config as never)
  const args = { action: "start", brief }
  const first = currentNativeInvocation(fake, args, "refused")
  await hooks["tool.execute.before"]!({ tool: "auto_debate", sessionID: ownerA.sessionID, callID: first.callID }, { args })
  let approvals = 0
  try {
    await assert.rejects(hooks.tool!.auto_debate.execute(args, { ...first, ask: async () => { throw new Error("Approval refused") } }), /refused/)
    assert.equal(fake.calls.some((call) => call.method === "session.create"), false)
    assert.equal(fake.participantCalls(), 0)
    const refused = finishNativeRefusal(fake, first)
    // Exact host non-dispatch provenance, not recognition of an approval error string.
    ;(refused.part.state as RecordValue).error = "An arbitrary host-rendered refusal diagnostic"
    const second = currentNativeInvocation(fake, args, "approved")
    await hooks["tool.execute.before"]!({ tool: "auto_debate", sessionID: ownerA.sessionID, callID: second.callID }, { args })
    const result = JSON.parse(outputText(await hooks.tool!.auto_debate.execute(args, { ...second, ask: async () => { approvals++ } })))
    assert.equal(approvals, 1)
    assert.equal(result.discussion.status, "running")
    await waitFor(async () => JSON.parse(outputText(await execute(hooks, { action: "status", discussion_id: result.discussion.id }))),
      (value) => value.discussion.status === "awaiting-evaluation")
    assert.equal(fake.participantCalls(), 9)
  } finally { await hooks.dispose?.() }
})

test("refusal provenance does not initialise state or become a restart/history-string exemption", async () => {
  for (const damage of ["restart", "unwitnessed-error", "mismatched-hook", "completed-before-refusal", "foreign-before-refusal", "changed-call", "changed-input", "changed-start", "removed-part", "completed-instead-of-error", "true-prior-work"] as const) {
    const fake = fakeInput()
    const hooks = await createAutomaticDebatePlugin(enabledRegistry())(fake.input)
    await hooks.config?.(configFixture() as never)
    const args = { action: "start", brief }
    const first = currentNativeInvocation(fake, args, "refused-negative")
    const message = fake.histories.get(ownerA.sessionID)!.at(-1)!
    if (damage === "completed-before-refusal") (message.info as RecordValue).time = { created: 1, completed: 4 }
    if (damage === "foreign-before-refusal") (message.parts as RecordValue[])[0].sessionID = ownerB.sessionID
    if (damage !== "unwitnessed-error") await hooks["tool.execute.before"]!({ tool: "auto_debate", sessionID: ownerA.sessionID,
      callID: damage === "mismatched-hook" ? "other-native-hook-call" : first.callID }, { args })
    await assert.rejects(hooks.tool!.auto_debate.execute(args, { ...first, ask: async () => { throw new Error("Approval refused") } }))
    assert.equal(fake.calls.some((call) => call.method === "session.create"), false, damage)
    assert.equal(fake.participantCalls(), 0, damage)
    const refused = finishNativeRefusal(fake, first)
    if (damage === "changed-call") refused.part.callID = "borrowed-call"
    if (damage === "changed-input") (refused.part.state as RecordValue).input = { action: "resume", discussion_id: "untracked", feedback: "different work" }
    if (damage === "changed-start") (refused.part.state as RecordValue).time = { start: 99, end: 100 }
    if (damage === "removed-part") refused.message.parts = []
    if (damage === "completed-instead-of-error") (refused.part.state as RecordValue).status = "completed"
    if (damage === "true-prior-work") currentNativeInvocation(fake, args, "older-running-work")
    const active = damage === "restart" ? await createAutomaticDebatePlugin(enabledRegistry())(fake.input) : hooks
    if (active !== hooks) await active.config?.(configFixture() as never)
    const second = currentNativeInvocation(fake, args, "approved-negative")
    await active["tool.execute.before"]!({ tool: "auto_debate", sessionID: ownerA.sessionID, callID: second.callID }, { args })
    await assert.rejects(active.tool!.auto_debate.execute(args, second), /history|evidence|invocation|unconfirmed/i, damage)
    const output = { parts: [] }
    await active["command.execute.before"]!({ command: "debate-auto", sessionID: ownerA.sessionID, arguments: "on" }, output)
    assert.match(JSON.stringify(output.parts), /unconfirmed|evidence|history/i, "a failed recovery is never reset")
    assert.equal(fake.calls.some((call) => call.method === "session.create"), false, damage)
    assert.equal(fake.participantCalls(), 0, damage)
    await hooks.dispose?.()
    if (active !== hooks) await active.dispose?.()
  }
})

test("reserved private-agent names reject registry and configuration collisions", async () => {
  const reserved = "opencode-debate-auto-private"
  const badRegistry: DebateRegistry = {
    ...registry,
    participants: [...registry.participants, { agent: reserved, description: "Reserved", model: "fake/reserved" }],
  }
  assert.throws(() => createAutomaticDebatePlugin(badRegistry), /reserved prefix/i)

  const fake = fakeInput()
  const hooks = await createAutomaticDebatePlugin(registry)(fake.input)
  const config = configFixture()
  ;(config.agent as Record<string, unknown>)[reserved] = { mode: "subagent", permission: {} }
  assert.ok(hooks.config)
  await assert.rejects(hooks.config(config as never), /reserved prefix/i)
})

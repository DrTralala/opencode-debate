import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createMiniDebateController,
  MINI_DEBATE_ALIAS_PREFIX,
  MINI_DEBATE_COMMAND,
  MINI_DEBATE_TOOL,
  type MiniDebateController,
} from "../src/mini-debate/plugin.ts"
import type { DebateRegistry } from "../src/participants.ts"

const ALIAS_ONE = `${MINI_DEBATE_ALIAS_PREFIX}one`
const ALIAS_TWO = `${MINI_DEBATE_ALIAS_PREFIX}two`

const REGISTRY: DebateRegistry = {
  participants: [
    { agent: "one", description: "One", model: "provider/one", variant: "xhigh" },
    { agent: "two", description: "Two", model: "provider/two" },
    { agent: "three", description: "Three", model: "provider/three" },
  ],
  sets: {
    default: ["one", "two", "three"],
    alternate: ["three", "two", "one"],
  },
  continuationBySet: { default: "ask", alternate: "ask" },
  miniDebate: { maxRounds: 3 },
  defaultSet: "default",
}

type SessionRecord = {
  id: string
  agent: string
  directory: string
  parentID?: string | null
}

type Hooks = MiniDebateController["hooks"]

type Host = ReturnType<typeof makeHost>

function makeHost(options: { beforeStart?: (sessionID: string) => void; root?: Partial<SessionRecord> } = {}) {
  const sessions = new Map<string, SessionRecord>()
  const root: SessionRecord = { id: "main", agent: "build", directory: "/work", ...options.root }
  sessions.set(root.id, root)
  let hold: { promise: Promise<void>; release: () => void } | undefined
  const client = {
    session: {
      get: async (request: { path: { id: string }; query: { directory: string } }) => {
        if (hold) await hold.promise
        const record = sessions.get(request.path.id)
        return record ? { data: { ...record } } : { data: null }
      },
    },
  }
  const controller = createMiniDebateController(
    REGISTRY,
    { client: client as never, directory: "/work" },
    options.beforeStart ? { beforeStart: options.beforeStart } : {},
  )
  return {
    controller,
    hooks: controller.hooks,
    sessions,
    root,
    addSession(record: SessionRecord) {
      sessions.set(record.id, record)
    },
    removeSession(id: string) {
      sessions.delete(id)
    },
    holdNextGet() {
      let release!: () => void
      const promise = new Promise<void>((resolvePromise) => {
        release = () => {
          hold = undefined
          resolvePromise()
        }
      })
      hold = { promise, release }
      return release
    },
  }
}

function childSession(id: string, agent = ALIAS_ONE, parentID = "main"): SessionRecord {
  return { id, agent, directory: "/work", parentID }
}

function taskRequest(round: number, turn: string, miniDebateId: string): string {
  return JSON.stringify({ mini_debate_id: miniDebateId, round, turn })
}

function taskCall(prompt: string, alias: string, taskId?: string) {
  return {
    description: "Participant",
    prompt,
    subagent_type: alias,
    ...(taskId === undefined ? {} : { task_id: taskId }),
  }
}

function participantReply(turn = "participant turn", consensusReached = false, recommendStopping = false): string {
  return JSON.stringify({
    turn,
    consensus_reached: consensusReached,
    recommend_stopping: recommendStopping,
  })
}

async function runCommand(hooks: Hooks, args: string, sessionID = "main"): Promise<string> {
  const output = { parts: [{ type: "text" as const, text: "" }] }
  await hooks["command.execute.before"]!({ command: MINI_DEBATE_COMMAND, sessionID, arguments: args }, output as never)
  return output.parts.map((part) => part.text).join("")
}

async function start(host: Host, args = "--rounds 3 A topic", sessionID = "main") {
  const text = await runCommand(host.hooks, args, sessionID)
  const match = /BEGIN MINI_DEBATE_INVOCATION [^\n]+\n([^\n]+)\nEND MINI_DEBATE_INVOCATION/u.exec(text)
  assert.ok(match, `main prompt missing invocation payload: ${text}`)
  return {
    text,
    payload: JSON.parse(match[1]) as {
      mini_debate_id: string
      round_limit: number
      participant: string
      topic: string
    },
  }
}

async function dispatch(
  hooks: Hooks,
  args: Record<string, unknown>,
  sessionID = "main",
  callID = "call-1",
): Promise<Record<string, unknown>> {
  const output = { args: { ...args } }
  await hooks["tool.execute.before"]!({ tool: "task", sessionID, callID }, output as never)
  return output.args
}

async function complete(
  hooks: Hooks,
  callID: string,
  reply: string,
  child = "child-1",
  parent = "main",
  sessionID = "main",
) {
  const metadata = { parentSessionId: parent, sessionId: child }
  const output = {
    title: "task",
    output: `<task id="${child}" state="completed">\n<task_result>\n${reply}\n</task_result>\n</task>`,
    metadata,
  }
  await hooks["tool.execute.after"]!({ tool: "task", sessionID, callID, args: {} }, output as never)
  return output
}

async function runTool(hooks: Hooks, args: Record<string, unknown>, sessionID = "main") {
  const result = await hooks.tool![MINI_DEBATE_TOOL]!.execute(
    args as never,
    { sessionID, agent: "build", directory: "/work" } as never,
  )
  const output = typeof result === "string" ? result : result.output
  return JSON.parse(output) as Record<string, unknown>
}

async function continueFromRoundOne(hooks: Hooks, miniDebateId: string, callID = "call-1") {
  await dispatch(hooks, taskCall(taskRequest(1, "opening", miniDebateId), ALIAS_ONE), "main", callID)
  await complete(hooks, callID, participantReply("first answer"))
  const evaluation = await runTool(hooks, {
    action: "evaluate",
    round: 1,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "not converged",
  })
  assert.equal(evaluation.decision, "continue")
}

async function askAtRoundTwo(hooks: Hooks, miniDebateId: string) {
  await continueFromRoundOne(hooks, miniDebateId)
  await dispatch(hooks, taskCall(taskRequest(2, "closing", miniDebateId), ALIAS_ONE, "child-1"), "main", "call-2")
  await complete(hooks, "call-2", participantReply("second answer"))
  const evaluation = await runTool(hooks, {
    action: "evaluate",
    round: 2,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "still unresolved",
  })
  assert.equal(evaluation.decision, "ask")
}

async function askQuestion(hooks: Hooks, question: Record<string, unknown>, requestID = "question-1", callID = "question-call") {
  await hooks["tool.execute.before"]!(
    { tool: "question", sessionID: "main", callID },
    { args: { questions: [question] } } as never,
  )
  await hooks.event!({
    event: {
      type: "question.asked",
      properties: { id: requestID, sessionID: "main", questions: [question], tool: { messageID: "message-1", callID } },
    },
  } as never)
}

function askedEvent(question: unknown, requestID = "question-1", callID = "question-call", sessionID = "main") {
  return {
    event: {
      type: "question.asked",
      properties: { id: requestID, sessionID, questions: [question], tool: { messageID: "message-1", callID } },
    },
  } as never
}

function repliedEvent(requestID = "question-1", answers: unknown = [["Yes"]], sessionID = "main") {
  return {
    event: { type: "question.replied", properties: { sessionID, requestID, answers } },
  } as never
}

function rejectedEvent(requestID = "question-1", sessionID = "main") {
  return {
    event: { type: "question.rejected", properties: { sessionID, requestID } },
  } as never
}

function deletedEvent(sessionID: string) {
  return { event: { type: "session.deleted", properties: { info: { id: sessionID } } } } as never
}

function taskErrorEvent(callID: string, sessionID = "main", error = "<task_error>\nparticipant failed\n</task_error>") {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${callID}`,
          sessionID,
          messageID: `message-${callID}`,
          type: "tool",
          callID,
          tool: "task",
          state: { status: "error", input: {}, error, metadata: { parentSessionId: sessionID }, time: { start: 1, end: 2 } },
        },
      },
    },
  } as never
}

function taskCompletedEvent(callID: string, child = "child-1", reply = participantReply(), sessionID = "main") {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${callID}`,
          sessionID,
          messageID: `message-${callID}`,
          type: "tool",
          callID,
          tool: "task",
          state: {
            status: "completed",
            input: {},
            output: `<task id="${child}" state="completed">\n<task_result>\n${reply}\n</task_result>\n</task>`,
            title: "task",
            metadata: { parentSessionId: sessionID, sessionId: child },
            time: { start: 1, end: 2 },
          },
        },
      },
    },
  } as never
}

function taskRunningEvent(callID: string, child: string, sessionID = "main") {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${callID}-running`,
          sessionID,
          messageID: `message-${callID}`,
          type: "tool",
          callID,
          tool: "task",
          state: {
            status: "running",
            input: {},
            output: `<task id="${child}" state="running">\n<task_result>\nstarted\n</task_result>\n</task>`,
            title: "task",
            metadata: { parentSessionId: sessionID, sessionId: child },
            time: { start: 1 },
          },
        },
      },
    },
  } as never
}

test("config registers a no-agent/no-subtask mini-debate command", async () => {
  const host = makeHost()
  const config: { command?: Record<string, any>; agent?: Record<string, any> } = {}
  await host.hooks.config!(config as never)

  const command = config.command?.[MINI_DEBATE_COMMAND]
  assert.ok(command, "mini-debate command is registered")
  assert.equal(command.template, "$ARGUMENTS")
  assert.equal(Object.hasOwn(command, "agent"), false)
  assert.equal(Object.hasOwn(command, "subtask"), false)
})

test("config registers read-only aliases for every selectable participant with model and variant", async () => {
  const host = makeHost()
  const config: { command?: Record<string, any>; agent?: Record<string, any> } = {}
  await host.hooks.config!(config as never)

  for (const [alias, agent] of [
    [ALIAS_ONE, "one"],
    [ALIAS_TWO, "two"],
    [`${MINI_DEBATE_ALIAS_PREFIX}three`, "three"],
  ] as const) {
    const registered = config.agent?.[alias]
    assert.ok(registered, `alias ${alias} is registered`)
    assert.equal(registered.mode, "subagent")
    assert.equal(registered.hidden, true)
    assert.equal(registered.model, `provider/${agent}`)
    assert.equal(registered.variant, agent === "one" ? "xhigh" : undefined)
  }

  const permission = config.agent?.[ALIAS_ONE]?.permission
  assert.equal(permission["*"], "deny")
  assert.equal(permission.read["*"], "allow")
  assert.equal(permission.read["*.env"], "deny")
  assert.equal(permission.grep, "allow")
  assert.equal(permission.glob, "allow")
  assert.equal(permission.bash, "deny")
  assert.equal(permission.edit, "deny")
  assert.equal(permission.task, "deny")
  assert.equal(permission.skill, "deny")
  assert.equal(permission.question, "deny")
  assert.equal(permission[MINI_DEBATE_TOOL], "deny")
})

test("config registration rejects reserved-prefix and alias collisions", async () => {
  const reserved: DebateRegistry = {
    ...REGISTRY,
    participants: [...REGISTRY.participants, { agent: `${MINI_DEBATE_ALIAS_PREFIX}evil`, description: "x", model: "p/x" }],
  }
  assert.throws(
    () => createMiniDebateController(reserved, { client: {} as never, directory: "/work" }),
    /reserved prefix/i,
  )

  const host = makeHost()
  await assert.rejects(
    host.hooks.config!({ command: {}, agent: { [`${MINI_DEBATE_ALIAS_PREFIX}other`]: {} } } as never),
    /reserved prefix/i,
  )
  await assert.rejects(
    host.hooks.config!({ command: {}, agent: { [ALIAS_ONE]: { mode: "primary" } } } as never),
    /collision/i,
  )
  await assert.rejects(
    host.hooks.config!({ command: { [MINI_DEBATE_COMMAND]: { template: "x" } }, agent: {} } as never),
    /reserved/i,
  )
})

test("config registration remains idempotent for its own aliases and command", async () => {
  const host = makeHost()
  const config: { command?: Record<string, any>; agent?: Record<string, any> } = {}
  await host.hooks.config!(config as never)
  await host.hooks.config!(config as never)
  assert.ok(config.command?.[MINI_DEBATE_COMMAND])
  assert.ok(config.agent?.[ALIAS_ONE])
})

test("config registration rejects unrelated registrations on a different config object", async () => {
  const host = makeHost()
  await host.hooks.config!({} as never)

  const foreignAgent = { mode: "primary" }
  const foreignCommand = { template: "other" }
  const conflicting: { command?: Record<string, any>; agent?: Record<string, any> } = {
    command: { [MINI_DEBATE_COMMAND]: foreignCommand },
    agent: { [ALIAS_ONE]: foreignAgent },
  }
  await assert.rejects(host.hooks.config!(conflicting as never), /reserved|collision/i)
  assert.equal(conflicting.agent?.[ALIAS_ONE], foreignAgent)
  assert.equal(conflicting.command?.[MINI_DEBATE_COMMAND], foreignCommand)

  await assert.rejects(
    host.hooks.config!({ command: {}, agent: { [ALIAS_ONE]: { mode: "primary" } } } as never),
    /collision/i,
  )
  await assert.rejects(
    host.hooks.config!({ command: { [MINI_DEBATE_COMMAND]: { template: "other" } }, agent: {} } as never),
    /reserved/i,
  )
})

test("config registration detects replacement of its own registration on the same config object", async () => {
  const host = makeHost()
  const config: { command?: Record<string, any>; agent?: Record<string, any> } = {}
  await host.hooks.config!(config as never)

  const foreignAgent = { mode: "primary" }
  config.agent![ALIAS_ONE] = foreignAgent
  await assert.rejects(host.hooks.config!(config as never), /collision/i)
  assert.equal(config.agent?.[ALIAS_ONE], foreignAgent)

  const foreignCommand = { template: "other" }
  delete config.command![MINI_DEBATE_COMMAND]
  config.command![MINI_DEBATE_COMMAND] = foreignCommand
  await assert.rejects(host.hooks.config!(config as never), /reserved/i)
  assert.equal(config.command?.[MINI_DEBATE_COMMAND], foreignCommand)

  delete config.command![MINI_DEBATE_COMMAND]
  delete config.agent![ALIAS_ONE]
  await host.hooks.config!(config as never)
  assert.ok(config.command?.[MINI_DEBATE_COMMAND])
  assert.ok(config.agent?.[ALIAS_ONE])
})

test("registers a strict mini_debate evaluation and extension tool", async () => {
  const host = makeHost()
  const definition = host.hooks.tool?.[MINI_DEBATE_TOOL]
  assert.ok(definition)
  await start(host)

  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x", extra: true }),
    /unexpected field/i,
  )
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false }),
    /rationale/i,
  )
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: "no", recommend_stopping: false, rationale: "x" }),
    /boolean/i,
  )
  await assert.rejects(runTool(host.hooks, { action: "other" }), /evaluate or request_extension/i)
  await assert.rejects(
    runTool(host.hooks, { action: "request_extension", rounds: 0 }),
    /rounds/i,
  )
  await assert.rejects(
    runTool(host.hooks, { action: "request_extension", rounds: 11 }),
    /rounds/i,
  )
})

test("a successful two-round invocation uses one sessionId and unchanged task metadata", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  const id = payload.mini_debate_id
  assert.match(payload.participant, /^opencode-debate-mini-/u)

  const rewritten = await dispatch(host.hooks, taskCall(taskRequest(1, "opening turn", id), ALIAS_ONE), "main", "call-1")
  assert.equal(typeof rewritten.prompt, "string")
  assert.match(rewritten.prompt as string, /A topic/u)
  assert.match(rewritten.prompt as string, /opening turn/u)
  assert.match(rewritten.prompt as string, /BEGIN MINI_DEBATE_EXCHANGE/u)
  assert.equal(Object.hasOwn(rewritten, "task_id"), false)

  host.addSession(childSession("child-1"))
  const metadata = { parentSessionId: "main", sessionId: "child-1" }
  const firstOutput = {
    title: "task",
    output: `<task id="child-1" state="completed">\n<task_result>\n${participantReply("first answer")}\n</task_result>\n</task>`,
    metadata,
  }
  await host.hooks["tool.execute.after"]!({ tool: "task", sessionID: "main", callID: "call-1", args: {} }, firstOutput as never)
  assert.deepEqual(firstOutput.metadata, { parentSessionId: "main", sessionId: "child-1" })
  assert.deepEqual(metadata, { parentSessionId: "main", sessionId: "child-1" })

  const firstEvaluation = await runTool(host.hooks, {
    action: "evaluate",
    round: 1,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "continue",
  })
  assert.equal(firstEvaluation.decision, "continue")

  const second = await dispatch(
    host.hooks,
    taskCall(taskRequest(2, "follow-up", id), ALIAS_ONE, "child-1"),
    "main",
    "call-2",
  )
  assert.equal(second.task_id, "child-1")
  assert.match(second.prompt as string, /follow-up/u)

  const secondOutput = {
    title: "task",
    output: `<task id="child-1" state="completed">\n<task_result>\n${participantReply("agreed", true, true)}\n</task_result>\n</task>`,
    metadata: { parentSessionId: "main", sessionId: "child-1" },
  }
  await host.hooks["tool.execute.after"]!({ tool: "task", sessionID: "main", callID: "call-2", args: {} }, secondOutput as never)

  const secondEvaluation = await runTool(host.hooks, {
    action: "evaluate",
    round: 2,
    consensus_reached: true,
    recommend_stopping: true,
    rationale: "both parties converged",
  })
  assert.equal(secondEvaluation.decision, "consensus")
})

test("an invalid or denied command registers no state and preserves ordinary tasks", async () => {
  const host = makeHost()
  const text = await runCommand(host.hooks, "--bad")
  assert.match(text, /unavailable/i)
  assert.equal(host.controller.state.sessions.has("main"), false)

  await dispatch(host.hooks, { description: "ordinary", prompt: "ordinary task", subagent_type: "general" })
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", "unknown"), ALIAS_ONE)),
    /no active mini-debate invocation/i,
  )
})

test("a beforeStart failure registers no state", async () => {
  const host = makeHost({
    beforeStart: () => {
      throw new Error("denied by policy")
    },
  })
  const text = await runCommand(host.hooks, "A topic")
  assert.match(text, /denied by policy/u)
  assert.equal(host.controller.state.sessions.has("main"), false)
})

test("a second command cannot replace an active invocation but can replace a closed one", async () => {
  const host = makeHost()
  await start(host, "--rounds 1 A topic")
  const blocked = await runCommand(host.hooks, "--rounds 1 Another topic")
  assert.match(blocked, /already active/i)
  assert.equal(host.controller.state.sessions.get("main")!.topic, "A topic")

  await dispatch(host.hooks, taskCall(taskRequest(1, "first", host.controller.state.sessions.get("main")!.invocationId), ALIAS_ONE))
  await complete(host.hooks, "call-1", participantReply("answer", true, true))
  const stop = await runTool(host.hooks, {
    action: "evaluate",
    round: 1,
    consensus_reached: true,
    recommend_stopping: true,
    rationale: "nothing left",
  })
  assert.equal(stop.decision, "stop")

  const closedInvocation = host.controller.state.sessions.get("main")!.invocationId
  const replaced = await start(host, "--rounds 1 Another topic")
  assert.notEqual(replaced.payload.mini_debate_id, closedInvocation)
  assert.equal(host.controller.state.sessions.get("main")!.topic, "Another topic")
})

test("rejects mini aliases outside enrolment and wrong selected aliases", async () => {
  const bare = makeHost()
  await assert.rejects(
    dispatch(bare.hooks, taskCall(taskRequest(1, "x", "any"), ALIAS_ONE)),
    /no active mini-debate invocation/i,
  )

  const host = makeHost()
  const { payload } = await start(host)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_TWO)),
    /selected participant/i,
  )
})

test("rejects stale invocation IDs, skipped rounds and dispatch before evaluation", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", "other-invocation"), ALIAS_ONE)),
    /stale/i,
  )
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "x", payload.mini_debate_id), ALIAS_ONE)),
    /next eligible/i,
  )

  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await complete(host.hooks, "call-1", participantReply())
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2"),
    /not been evaluated/i,
  )
})

test("enforces first-dispatch task_id omission, later binding and mismatch rejection", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE, "child-0")),
    /omit task_id/i,
  )

  await continueFromRoundOne(host.hooks, payload.mini_debate_id)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE), "main", "call-2"),
    /resume the bound task_id/i,
  )
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-2"), "main", "call-3"),
    /task_id mismatch/i,
  )
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, 42 as never), "main", "call-4"),
    /task_id/i,
  )
})

test("rejects background dispatches and non-canonical task requests", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  await assert.rejects(
    dispatch(host.hooks, { ...taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), background: true }),
    /background/i,
  )
  await assert.rejects(
    dispatch(host.hooks, taskCall("not json", ALIAS_ONE)),
    /task request/i,
  )
})

test("reserves a dispatch before the live session preflight rejects parallel calls", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  const release = host.holdNextGet()
  const first = dispatch(host.hooks, taskCall(taskRequest(1, "first", payload.mini_debate_id), ALIAS_ONE), "main", "call-1")
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "second", payload.mini_debate_id), ALIAS_ONE), "main", "call-2"),
    /in flight/i,
  )
  release()
  await first
  await complete(host.hooks, "call-1", participantReply())
  const evaluation = await runTool(host.hooks, {
    action: "evaluate",
    round: 1,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "ok",
  })
  assert.equal(evaluation.decision, "continue")
})

test("an invalid racing attempt does not erase an already reserved call", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  const release = host.holdNextGet()
  const first = dispatch(host.hooks, taskCall(taskRequest(1, "first", payload.mini_debate_id), ALIAS_ONE), "main", "call-1")
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "wrong alias", payload.mini_debate_id), ALIAS_TWO), "main", "call-2"),
    /selected participant/i,
  )
  release()
  await first
  await complete(host.hooks, "call-1", participantReply())
})

test("preflight failure clears the attempt so the dispatch can be retried", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.removeSession("main")
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE)),
    /owner session/i,
  )
  host.addSession(host.root)
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
})

test("preflight fails closed on owner identity changes", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession({ ...host.root, agent: "plan" })
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE)),
    /identity/i,
  )
})

test("rejects a bound child with a missing or wrong parent session", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await continueFromRoundOne(host.hooks, payload.mini_debate_id)

  host.addSession(childSession("child-1", ALIAS_ONE, "other-parent"))
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2"),
    /parent/i,
  )

  host.removeSession("child-1")
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-3"),
    /missing|unavailable/i,
  )
})

test("tracks a completed result delivered only through the terminal event", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await host.hooks.event!(taskCompletedEvent("call-1", "child-1", participantReply("event answer")))
  const evaluation = await runTool(host.hooks, {
    action: "evaluate",
    round: 1,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "event delivery",
  })
  assert.equal(evaluation.decision, "continue")
})

test("counts each round once across duplicate after-hook and terminal deliveries", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await complete(host.hooks, "call-1", participantReply())
  await host.hooks.event!(taskCompletedEvent("call-1"))
  await host.hooks.event!(taskCompletedEvent("call-1"))
  await complete(host.hooks, "call-1", participantReply("late duplicate"))

  const first = await runTool(host.hooks, {
    action: "evaluate",
    round: 1,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "once",
  })
  assert.equal(first.decision, "continue")
  await assert.rejects(
    runTool(host.hooks, {
      action: "evaluate",
      round: 1,
      consensus_reached: false,
      recommend_stopping: false,
      rationale: "again",
    }),
    /already been evaluated/i,
  )
})

test("an authoritative terminal error invalidates an unevaluated optimistic completion", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), "main", "call-1")
  await complete(host.hooks, "call-1", participantReply(), "child-1")
  await host.hooks.event!(taskErrorEvent("call-1"))
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /completed participant result/i,
  )
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2")
  await complete(host.hooks, "call-2", participantReply(), "child-1")
})

test("a late terminal error cannot erase an already evaluated round", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await continueFromRoundOne(host.hooks, payload.mini_debate_id)
  await host.hooks.event!(taskErrorEvent("call-1"))
  await dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2")
})

test("fails closed on malformed participant output and allows recovery with the bound child", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await assert.rejects(
    complete(host.hooks, "call-1", "not a reply"),
    /invalid|not canonical JSON/i,
  )
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /completed participant result/i,
  )
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2")
  await complete(host.hooks, "call-2", participantReply(), "child-1")
})

test("fails closed on conflicting child session metadata", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-a"))
  host.addSession(childSession("child-b"))
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await host.hooks.event!(taskRunningEvent("call-1", "child-a"))
  await assert.rejects(
    complete(host.hooks, "call-1", participantReply(), "child-b"),
    /child session.*(conflict|mismatch)/i,
  )
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /completed participant result/i,
  )
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE, "child-a"), "main", "call-2")
  await complete(host.hooks, "call-2", participantReply(), "child-a")
})

test("fails closed on conflicting parent session metadata between event sources", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  const event = taskRunningEvent("call-1", "child-1", "main") as { event: { properties: { part: Record<string, unknown> } } }
  event.event.properties.part.metadata = { parentSessionId: "other-parent", sessionId: "child-1" }
  await assert.rejects(host.hooks.event!(event as never), /parent session conflict/i)
})

test("rejects a background running envelope, binds its child and requires its resumption", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await assert.rejects(
    host.hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "main", callID: "call-1", args: {} },
      {
        title: "task",
        output: `<task id="child-1" state="running">\n<task_result>\nstarted\n</task_result>\n</task>`,
        metadata: { parentSessionId: "main", sessionId: "child-1" },
      } as never,
    ),
    /background/i,
  )
  assert.equal(host.controller.state.sessions.get("main")!.childSessionID, "child-1")
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /completed participant result/i,
  )
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), "main", "call-2"),
    /resume the bound task_id/i,
  )
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-3")
  await complete(host.hooks, "call-3", participantReply(), "child-1")
})

test("closes the invocation when a background running envelope has conflicting child identity", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  await assert.rejects(
    host.hooks["tool.execute.after"]!(
      { tool: "task", sessionID: "main", callID: "call-1", args: {} },
      {
        title: "task",
        output: `<task id="child-a" state="running">\n<task_result>\nstarted\n</task_result>\n</task>`,
        metadata: { parentSessionId: "main", sessionId: "child-b" },
      } as never,
    ),
    /child session.*(conflict|mismatch)/i,
  )
  const state = host.controller.state.sessions.get("main")!
  assert.equal(state.closed, true)
  assert.equal(state.childSessionID, undefined)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), "main", "call-2"),
    /closed/i,
  )
  await start(host, "--rounds 1 A fresh topic")
})

test("terminal error and permission-rejection events end the attempt without opening a participant", async () => {
  const host = makeHost()
  const { payload } = await start(host)

  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), "main", "call-1")
  await host.hooks.event!(taskErrorEvent("call-1"))
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /completed participant result/i,
  )
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), "main", "call-2")
  await host.hooks.event!({
    event: {
      type: "permission.asked",
      properties: {
        id: "permission-1",
        sessionID: "main",
        permission: "task",
        patterns: [ALIAS_ONE],
        metadata: {},
        always: [],
        tool: { messageID: "message-1", callID: "call-2" },
      },
    },
  } as never)
  await host.hooks.event!({
    event: { type: "permission.replied", properties: { sessionID: "main", requestID: "permission-1", reply: "reject" } },
  } as never)
  await dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE), "main", "call-3")
})

test("evaluation is rejected before a completed result and on wrong or malformed rounds", async () => {
  const host = makeHost()
  await start(host)
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 1, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /completed participant result/i,
  )
  await continueFromRoundOne(host.hooks, host.controller.state.sessions.get("main")!.invocationId)
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 2, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /no completed participant result/i,
  )
  await assert.rejects(
    runTool(host.hooks, { action: "evaluate", round: 0, consensus_reached: false, recommend_stopping: false, rationale: "x" }),
    /round|positive/i,
  )
})

test("a round limit decision rejects another round until an extension is granted", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await askAtRoundTwo(host.hooks, payload.mini_debate_id)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(3, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-3"),
    /decision|budget/i,
  )
})

test("request_extension is rejected before an ask decision and while a task is in flight", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  await assert.rejects(
    runTool(host.hooks, { action: "request_extension", rounds: 1 }),
    /ask decision/i,
  )

  host.addSession(childSession("child-1"))
  await continueFromRoundOne(host.hooks, payload.mini_debate_id)
  const state = host.controller.state.sessions.get("main")!
  const release = host.holdNextGet()
  const active = dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2")
  state.decision = "ask"
  await assert.rejects(
    runTool(host.hooks, { action: "request_extension", rounds: 1 }),
    /in flight/i,
  )
  release()
  await active
  await complete(host.hooks, "call-2", participantReply())
  const evaluation = await runTool(host.hooks, {
    action: "evaluate",
    round: 2,
    consensus_reached: false,
    recommend_stopping: false,
    rationale: "still unresolved",
  })
  assert.equal(evaluation.decision, "ask")

  const first = await runTool(host.hooks, { action: "request_extension", rounds: 2 })
  assert.equal(first.rounds, 2)
  assert.equal((first.question as Record<string, unknown>).header, "Mini-debate extension")
  const options = (first.question as { options: Array<{ label: string }> }).options
  assert.deepEqual(options.map((option) => option.label), ["Yes", "No"])
  await assert.rejects(
    runTool(host.hooks, { action: "request_extension", rounds: 1 }),
    /pending/i,
  )
})

test("grants a pending extension only from the matching service Yes reply, exactly once", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await askAtRoundTwo(host.hooks, payload.mini_debate_id)
  const request = await runTool(host.hooks, { action: "request_extension", rounds: 1 })
  const question = request.question as Record<string, unknown>

  await askQuestion(host.hooks, question, "question-1", "question-call")
  await host.hooks.event!(repliedEvent("question-1", [["Yes"]]))
  await host.hooks.event!(repliedEvent("question-1", [["Yes"]]))

  const state = host.controller.state.sessions.get("main")!
  assert.equal(state.rounds, 3)
  assert.equal(state.grants, 1)

  await dispatch(host.hooks, taskCall(taskRequest(3, "extension", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-3")
  await complete(host.hooks, "call-3", participantReply())
})

test("does not grant on forged tool metadata, wrong owners, wrong calls, requests, or answers", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await askAtRoundTwo(host.hooks, payload.mini_debate_id)
  const request = await runTool(host.hooks, { action: "request_extension", rounds: 1 })
  const question = request.question as Record<string, unknown>

  await askQuestion(host.hooks, question, "question-1", "question-call")
  await host.hooks["tool.execute.after"]!(
    { tool: "question", sessionID: "main", callID: "question-call", args: {} },
    { title: "question", output: "approved", metadata: { approved: true, answers: [["Yes"]] } } as never,
  )
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(3, "x", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-3"),
    /decision|budget/i,
  )

  await host.hooks.event!(repliedEvent("wrong-request", [["Yes"]]))
  assert.equal(host.controller.state.sessions.get("main")!.rounds, 2)

  await host.hooks.event!(repliedEvent("question-1", [["No"]]))
  const state = host.controller.state.sessions.get("main")!
  assert.equal(state.rounds, 2)
  assert.equal(state.decision, "ask")

  await host.hooks.event!(askedEvent(question, "question-2", "question-call", "other-session"))
  assert.equal(state.pendingExtension, undefined)
})

test("rejects a mismatched question call and payload while an extension is pending", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await askAtRoundTwo(host.hooks, payload.mini_debate_id)
  const request = await runTool(host.hooks, { action: "request_extension", rounds: 1 })
  const question = request.question as Record<string, unknown>

  await host.hooks["tool.execute.before"]!(
    { tool: "question", sessionID: "main", callID: "question-call" },
    { args: { questions: [question] } } as never,
  )
  await assert.rejects(host.hooks.event!(askedEvent({ ...question, header: "Other" }, "question-1")), /question/i)
  await assert.rejects(host.hooks.event!(askedEvent(question, "question-2", "other-call")), /question call|recorded/i)
  const extraOption = {
    ...question,
    options: (question.options as Array<Record<string, unknown>>).map((option, index) =>
      index === 0 ? { ...option, recommended: true } : option
    ),
  }
  await assert.rejects(host.hooks.event!(askedEvent(extraOption, "question-3")), /question/i)
  assert.equal(host.controller.state.sessions.get("main")!.pendingExtension?.askedID, undefined)
})

test("a rejected extension question clears the request without unlocking dispatch", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await askAtRoundTwo(host.hooks, payload.mini_debate_id)
  const request = await runTool(host.hooks, { action: "request_extension", rounds: 1 })
  const question = request.question as Record<string, unknown>
  await askQuestion(host.hooks, question, "question-1", "question-call")
  await host.hooks.event!(rejectedEvent("question-1"))

  const state = host.controller.state.sessions.get("main")!
  assert.equal(state.pendingExtension, undefined)
  assert.equal(state.rounds, 2)
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(3, "x", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-3"),
    /decision|budget/i,
  )
  const again = await runTool(host.hooks, { action: "request_extension", rounds: 1 })
  assert.ok(again.question)
})

test("stale approvals cannot unlock a replacement invocation", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await askAtRoundTwo(host.hooks, payload.mini_debate_id)
  const request = await runTool(host.hooks, { action: "request_extension", rounds: 1 })
  const question = request.question as Record<string, unknown>
  await askQuestion(host.hooks, question, "question-1", "question-call")

  await host.hooks.event!(deletedEvent("main"))
  assert.equal(host.controller.state.sessions.has("main"), false)
  const replacement = await start(host, "--rounds 2 A fresh topic")
  assert.notEqual(replacement.payload.mini_debate_id, payload.mini_debate_id)

  await host.hooks.event!(repliedEvent("question-1", [["Yes"]]))
  const state = host.controller.state.sessions.get("main")!
  assert.equal(state.pendingExtension, undefined)
  assert.equal(state.rounds, 2)
})

test("child session deletion closes the invocation, blocks resumption and allows a new command", async () => {
  const host = makeHost()
  const { payload } = await start(host, "--rounds 2 A topic")
  host.addSession(childSession("child-1"))
  await continueFromRoundOne(host.hooks, payload.mini_debate_id)

  await host.hooks.event!(deletedEvent("child-1"))
  const state = host.controller.state.sessions.get("main")!
  assert.equal(state.closed, true)
  assert.equal(state.childDeleted, true)
  assert.equal(host.controller.state.tombstones.get("child-1")?.deleted, true)

  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2"),
    /deleted|closed/i,
  )
  await start(host, "--rounds 2 A fresh topic")
})

test("release rejects in-flight work and preserves stale-child tombstones", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  const release = host.holdNextGet()
  const active = dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE))
  assert.throws(() => host.controller.release("main"), /in flight/i)
  release()
  await active
  await complete(host.hooks, "call-1", participantReply())

  host.controller.release("main")
  assert.equal(host.controller.state.sessions.has("main"), false)
  assert.ok(host.controller.state.tombstones.has("child-1"))
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(1, "x", payload.mini_debate_id), ALIAS_ONE)),
    /no active mini-debate invocation/i,
  )
  await assert.rejects(
    dispatch(host.hooks, { description: "other", prompt: "resume", subagent_type: "general", task_id: "child-1" }),
    /recorded mini-debate child/i,
  )
  host.controller.release("unknown-session")
})

test("disposal releases all sessions and keeps tombstones", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  host.addSession(childSession("child-1"))
  await continueFromRoundOne(host.hooks, payload.mini_debate_id)

  await host.hooks.dispose!()
  assert.equal(host.controller.state.sessions.size, 0)
  assert.ok(host.controller.state.tombstones.has("child-1"))
  await assert.rejects(
    dispatch(host.hooks, taskCall(taskRequest(2, "y", payload.mini_debate_id), ALIAS_ONE, "child-1"), "main", "call-2"),
    /no active mini-debate invocation/i,
  )
})

test("preserves ordinary task calls in enrolled sessions", async () => {
  const host = makeHost()
  const { payload } = await start(host)
  const ordinary = await dispatch(host.hooks, {
    description: "ordinary",
    prompt: `{\"mini_debate_id\":\"${payload.mini_debate_id}\",\"round\":1,\"turn\":\"x\"}`,
    subagent_type: "general",
  })
  assert.match(ordinary.prompt as string, /mini_debate_id/u)
})

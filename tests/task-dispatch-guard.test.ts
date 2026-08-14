import { test } from "node:test"
import assert from "node:assert/strict"
import { TaskDispatchGuardPlugin } from "../src/task-dispatch-guard.ts"

type Purpose = "normal" | "retry" | "formatter-correction"
type ParticipantTypes = readonly [string, string, string]

const DEFAULT_PARTICIPANT_TYPES: ParticipantTypes = [
  "debate-one",
  "debate-two",
  "debate-three",
]

const activatedSessions = new WeakMap<object, Set<string>>()

function taskArgs(
  purpose: Purpose,
  participant: number,
  round: number,
  options: { subagentType?: string; markerSubagentType?: string; taskId?: string } = {},
) {
  const markerSubagentType = options.markerSubagentType ?? options.subagentType ?? "debate-one"
  const marker = `[DEBATE_DISPATCH purpose=${purpose} participant=${participant} round=${round} subagent_type=${
    options.markerSubagentType ?? markerSubagentType
  }]`
  return {
    description: `Participant ${participant}`,
    prompt: `${marker}\nReturn the participant response.`,
    ...(options.subagentType === undefined ? {} : { subagent_type: options.subagentType }),
    ...(options.taskId === undefined ? {} : { task_id: options.taskId }),
  }
}

async function guardHooks() {
  return TaskDispatchGuardPlugin({} as never)
}

async function activate(
  hooks: Awaited<ReturnType<typeof guardHooks>>,
  sessionID: string,
  participantTypes: ParticipantTypes = DEFAULT_PARTICIPANT_TYPES,
) {
  assert.ok(hooks["command.execute.before"])
  await hooks["command.execute.before"](
    { command: "debate", sessionID, arguments: "topic" },
    {
      parts: [{
        type: "text",
        text: [
          "Run a debate with this parsed request.",
          "",
          "Resolved participants:",
          `Participant 1: ${participantTypes[0]}`,
          `Participant 2: ${participantTypes[1]}`,
          `Participant 3: ${participantTypes[2]}`,
          "",
          "The command arguments have already been parsed and validated.",
        ].join("\n"),
      }],
    } as never,
  )
  let sessions = activatedSessions.get(hooks as object)
  if (!sessions) {
    sessions = new Set()
    activatedSessions.set(hooks as object, sessions)
  }
  sessions.add(sessionID)
}

function inferredParticipantTypes(args: Record<string, unknown>): ParticipantTypes {
  const marker = typeof args.prompt === "string"
    ? /^\[DEBATE_DISPATCH\s+purpose=\S+\s+participant=([1-3])\s+round=\S+\s+subagent_type=([^\s\]]+)/.exec(args.prompt)
    : null
  const participant = marker ? Number(marker[1]) - 1 : -1
  const subagentType = typeof args.subagent_type === "string"
    ? args.subagent_type
    : marker?.[2]
  if (participant < 0 || participant > 2 || !subagentType) return DEFAULT_PARTICIPANT_TYPES
  const types = [...DEFAULT_PARTICIPANT_TYPES] as [string, string, string]
  types[participant] = subagentType
  return types
}

async function ensureActivated(
  hooks: Awaited<ReturnType<typeof guardHooks>>,
  sessionID: string,
  participantTypes: ParticipantTypes = DEFAULT_PARTICIPANT_TYPES,
) {
  const sessions = activatedSessions.get(hooks as object)
  if (sessions?.has(sessionID)) return
  await activate(hooks, sessionID, participantTypes)
}

async function ordinaryTask(hooks: Awaited<ReturnType<typeof guardHooks>>, sessionID: string, callID: string) {
  assert.ok(hooks["tool.execute.before"])
  await hooks["tool.execute.before"](
    { tool: "task", sessionID, callID },
    { args: { description: "ordinary task", prompt: "ordinary task", subagent_type: "general" } },
  )
}

async function before(
  hooks: Awaited<ReturnType<typeof guardHooks>>,
  sessionID: string,
  callID: string,
  args: Record<string, unknown>,
) {
  await ensureActivated(hooks, sessionID, inferredParticipantTypes(args))
  assert.ok(hooks["tool.execute.before"])
  await hooks["tool.execute.before"](
    { tool: "task", sessionID, callID },
    { args },
  )
}

async function after(
  hooks: Awaited<ReturnType<typeof guardHooks>>,
  sessionID: string,
  callID: string,
  output = "participant output",
  childSessionID = "child-1",
) {
  await ensureActivated(hooks, sessionID)
  assert.ok(hooks["tool.execute.after"])
  await hooks["tool.execute.after"](
    { tool: "task", sessionID, callID, args: {} },
    {
      title: "task",
      output: `<task id="${childSessionID}" state="completed">\n<task_result>\n${output}\n</task_result>\n</task>`,
      metadata: { parentSessionId: sessionID, sessionId: childSessionID },
    },
  )
}

async function afterFailure(
  hooks: Awaited<ReturnType<typeof guardHooks>>,
  sessionID: string,
  callID: string,
  childSessionID = "child-1",
) {
  await ensureActivated(hooks, sessionID)
  assert.ok(hooks["tool.execute.after"])
  await hooks["tool.execute.after"](
    { tool: "task", sessionID, callID, args: {} },
    {
      title: "task",
      output: `<task id="${childSessionID}" state="error">\n<task_error>\nparticipant failed\n</task_error>\n</task>`,
      metadata: { parentSessionId: sessionID, sessionId: childSessionID },
    },
  )
}

function lifecycleEvent(
  sessionID: string,
  callID: string,
  status: "completed" | "error",
  childSessionID = "child-1",
) {
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
          state: status === "completed"
            ? {
                status,
                input: {},
                output: `<task id="${childSessionID}" state="completed">\n<task_result>\nparticipant output\n</task_result>\n</task>`,
                title: "task",
                metadata: { parentSessionId: sessionID, sessionId: childSessionID },
                time: { start: 1, end: 2 },
              }
            : {
                status,
                input: {},
                error: "<task_error>\nparticipant failed\n</task_error>",
                metadata: { parentSessionId: sessionID, sessionId: childSessionID },
                time: { start: 1, end: 2 },
              },
        },
      },
    },
  } as never
}

function runningLifecycleEvent(
  sessionID: string,
  callID: string,
  childSessionID: string,
) {
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
            output: `<task id="${childSessionID}" state="running">\n<task_result>\nstarted\n</task_result>\n</task>`,
            title: "task",
            metadata: { parentSessionId: sessionID, sessionId: childSessionID },
            time: { start: 1 },
          },
        },
      },
    },
  } as never
}

function terminalErrorWithoutMetadata(sessionID: string, callID: string) {
  return {
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: `part-${callID}-error`,
          sessionID,
          messageID: `message-${callID}`,
          type: "tool",
          callID,
          tool: "task",
          state: {
            status: "error",
            input: {},
            error: "<task_error>\nparticipant failed\n</task_error>",
            title: "task",
            time: { start: 1, end: 2 },
          },
        },
      },
    },
  } as never
}

test("admits three distinct concurrent normal participant dispatches", async () => {
  const hooks = await guardHooks()

  await Promise.all([
    before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" })),
    before(hooks, "debate-1", "call-2", taskArgs("normal", 2, 1, { subagentType: "debate-two" })),
    before(hooks, "debate-1", "call-3", taskArgs("normal", 3, 1, { subagentType: "debate-three" })),
  ])
})

test("rejects a marked dispatch with omitted subagent_type", async () => {
  const hooks = await guardHooks()

  await assert.rejects(
    before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1)),
    /subagent_type.*required/i,
  )
})

test("leaves ordinary unmarked task calls in unrelated sessions untouched", async () => {
  const hooks = await guardHooks()

  await ordinaryTask(hooks, "ordinary-session", "ordinary-call")
})

test("leaves ordinary task completion envelopes untouched in unrelated sessions", async () => {
  const hooks = await guardHooks()
  await ordinaryTask(hooks, "ordinary-session", "ordinary-call")
  assert.ok(hooks["tool.execute.after"])

  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "ordinary-session", callID: "ordinary-call", args: {} },
    {
      title: "task",
      output: "<task id=\"ordinary-child\" state=\"completed\">\n<task_result>ordinary</task_result>\n</task>",
      metadata: { sessionId: "different-child" },
    },
  )
})

test("enforces markers after the debate command activates its coordinator session", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "activated-session")

  await assert.rejects(
    ordinaryTask(hooks, "activated-session", "ordinary-call"),
    /dispatch marker.*required/i,
  )
})

test("does not register an invalid debate command as a coordinator session", async () => {
  const hooks = await guardHooks()
  assert.ok(hooks["command.execute.before"])
  await hooks["command.execute.before"](
    { command: "debate", sessionID: "invalid-session", arguments: "--bad" },
    { parts: [{ type: "text", text: "The /debate command arguments are invalid." }] } as never,
  )
  await ordinaryTask(hooks, "invalid-session", "ordinary-call")
})

test("requires round one normal dispatches to omit task_id", async () => {
  const hooks = await guardHooks()

  await assert.rejects(
    before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one", taskId: "child-1" })),
    /round 1.*omit|task_id.*round 1/i,
  )
})

test("rejects a task dispatch without a structured marker", async () => {
  const hooks = await guardHooks()

  await assert.rejects(
    before(hooks, "debate-1", "call-1", {
      description: "Participant 1",
      prompt: "Return the participant response.",
      subagent_type: "debate-one",
    }),
    /dispatch marker.*required/i,
  )
})

test("rejects a marker that is not exact at the start of the first line", async () => {
  const hooks = await guardHooks()

  await assert.rejects(
    before(hooks, "debate-1", "call-1", {
      description: "Participant 1",
      prompt: "  [DEBATE_DISPATCH purpose=normal participant=1 round=1 subagent_type=debate-one]\nReturn the participant response.",
      subagent_type: "debate-one",
    }),
    /dispatch marker.*required|malformed/i,
  )
})

test("rejects a subagent_type that mismatches the structured marker", async () => {
  const hooks = await guardHooks()

  await assert.rejects(
    (async () => {
      await activate(hooks, "debate-1")
      await hooks["tool.execute.before"]?.(
        { tool: "task", sessionID: "debate-1", callID: "call-1" },
        { args: taskArgs("normal", 1, 1, { subagentType: "debate-two", markerSubagentType: "debate-one" }) },
      )
    })(),
    /subagent_type.*mismatch/i,
  )
})

test("rejects a conflicting round-one assignment after the established attempt fails", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "debate-round-one-type", ["registry-alpha", "debate-two", "debate-three"])

  await before(hooks, "debate-round-one-type", "normal", taskArgs("normal", 1, 1, { subagentType: "registry-alpha" }))
  await afterFailure(hooks, "debate-round-one-type", "normal", "child-round-one-type")

  await assert.rejects(
    before(hooks, "debate-round-one-type", "conflict", taskArgs("normal", 1, 1, { subagentType: "registry-beta" })),
    /subagent_type.*established/i,
  )
})

test("rejects duplicate active normal dispatches", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-1", "call-1", args)
  await assert.rejects(
    before(hooks, "debate-1", "call-2", args),
    /duplicate active|already active/i,
  )
})

test("rejects duplicate completed normal dispatches", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-1", "call-1", args)
  await after(hooks, "debate-1", "call-1")
  await assert.rejects(
    before(hooks, "debate-1", "call-2", args),
    /duplicate completed|already completed/i,
  )
})

test("resets completed dispatch state when a second debate starts in the same session", async () => {
  const hooks = await guardHooks()

  await before(hooks, "same-session", "first", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "same-session", "first", "first debate output", "first-child")
  await activate(hooks, "same-session")

  await before(hooks, "same-session", "second", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
})

test("does not reset an in-flight debate when a duplicate command starts", async () => {
  const hooks = await guardHooks()

  await before(hooks, "in-flight-command", "first", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await assert.rejects(
    activate(hooks, "in-flight-command"),
    /in.?flight|active dispatch/i,
  )
  await assert.rejects(
    before(hooks, "in-flight-command", "duplicate", taskArgs("normal", 1, 1, { subagentType: "debate-one" })),
    /duplicate active|already active/i,
  )
})

test("admits the next eligible normal round after completion", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-1", "call-1")
  await before(hooks, "debate-1", "call-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-1" }))
})

test("rejects a changed subagent_type on a later normal round", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "debate-later-type", ["registry-alpha", "debate-two", "debate-three"])

  await before(hooks, "debate-later-type", "round-1", taskArgs("normal", 1, 1, { subagentType: "registry-alpha" }))
  await after(hooks, "debate-later-type", "round-1", "participant output", "child-later-type")

  await assert.rejects(
    before(hooks, "debate-later-type", "round-2", taskArgs("normal", 1, 2, { subagentType: "registry-beta", taskId: "child-later-type" })),
    /subagent_type.*established/i,
  )
})

test("rejects a wrong first-round assignment against the resolved participant mapping", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "authoritative-mapping", ["configured-one", "configured-two", "configured-three"])

  await assert.rejects(
    before(hooks, "authoritative-mapping", "wrong-first", taskArgs("normal", 1, 1, { subagentType: "wrong-agent" })),
    /configured|resolved|participant type/i,
  )
})

test("rejects duplicate configured agent assignments in the resolved mapping", async () => {
  const hooks = await guardHooks()

  await assert.rejects(
    activate(hooks, "duplicate-mapping", ["same-agent", "same-agent", "third-agent"]),
    /distinct|duplicate|assigned/i,
  )
})

test("rejects a round two normal dispatch with a missing task_id", async () => {
  const hooks = await guardHooks()
  await before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-1", "call-1", "participant output", "child-1")

  await assert.rejects(
    before(hooks, "debate-1", "call-2", taskArgs("normal", 1, 2, { subagentType: "debate-one" })),
    /task_id.*required|requires task_id|child session/i,
  )
})

test("rejects arbitrary and cross-participant task_id values on continuation", async () => {
  const hooks = await guardHooks()
  await before(hooks, "debate-1", "p1-r1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-1", "p1-r1", "participant output", "child-one")
  await before(hooks, "debate-1", "p2-r1", taskArgs("normal", 2, 1, { subagentType: "debate-two" }))
  await after(hooks, "debate-1", "p2-r1", "participant output", "child-two")

  await assert.rejects(
    before(hooks, "debate-1", "p1-bad", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "arbitrary" })),
    /task_id.*mismatch|child session|next eligible/i,
  )
  await assert.rejects(
    before(hooks, "debate-1", "p1-cross", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-two" })),
    /task_id.*mismatch|child session|next eligible/i,
  )
})

test("admits one retry only after a recorded task failure", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await hooks.event?.(lifecycleEvent("debate-1", "call-1", "error"))
  await before(hooks, "debate-1", "call-2", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-1" }))
  await assert.rejects(
    before(hooks, "debate-1", "call-3", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-1" })),
    /retry.*active|duplicate/i,
  )
  await hooks.event?.(lifecycleEvent("debate-1", "call-2", "completed"))
  await assert.rejects(
    before(hooks, "debate-1", "call-4", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-1" })),
    /retry.*completed|already completed|only one/i,
  )
})

test("rejects a changed subagent_type on a retry", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "debate-retry-type", ["registry-alpha", "debate-two", "debate-three"])

  await before(hooks, "debate-retry-type", "normal", taskArgs("normal", 1, 1, { subagentType: "registry-alpha" }))
  await afterFailure(hooks, "debate-retry-type", "normal", "child-retry-type")

  await assert.rejects(
    before(hooks, "debate-retry-type", "retry", taskArgs("retry", 1, 1, { subagentType: "registry-beta", taskId: "child-retry-type" })),
    /subagent_type.*established/i,
  )
})

test("records an empty task result as a failure eligible for one retry", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-empty", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-empty", "call-1", "", "child-empty")
  await before(hooks, "debate-empty", "call-2", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-empty" }))
})

test("authoritative task errors override an optimistic non-empty after result", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-error", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-error", "call-1", "participant output", "child-error")
  await hooks.event?.(lifecycleEvent("debate-error", "call-1", "error", "child-error"))
  await before(hooks, "debate-error", "call-2", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-error" }))
})

test("does not admit continuation until the child session is identified", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-deferred", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  assert.ok(hooks["tool.execute.after"])
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "debate-deferred", callID: "call-1", args: {} },
    { title: "task", output: "unstructured wrapper output", metadata: {} },
  )
  await assert.rejects(
    before(hooks, "debate-deferred", "call-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "unknown" })),
    /task_id.*mismatch|child session|next eligible/i,
  )
})

test("recognises a task error envelope from tool.execute.after", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-error-envelope", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  assert.ok(hooks["tool.execute.after"])
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "debate-error-envelope", callID: "call-1", args: {} },
    {
      title: "task",
      output: "<task id=\"child-error-envelope\" state=\"error\">\n<task_error>\nfailed\n</task_error>\n</task>",
      metadata: { parentSessionId: "debate-error-envelope", sessionId: "child-error-envelope" },
    },
  )
  await before(hooks, "debate-error-envelope", "call-2", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-error-envelope" }))
})

test("keeps a running task active until its terminal lifecycle event", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-running", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  assert.ok(hooks["tool.execute.after"])
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "debate-running", callID: "call-1", args: {} },
    {
      title: "task",
      output: "<task id=\"child-running\" state=\"running\">\n<task_result>\nstarted\n</task_result>\n</task>",
      metadata: { parentSessionId: "debate-running", sessionId: "child-running" },
    },
  )
  await assert.rejects(
    before(hooks, "debate-running", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-running" })),
    /active|requires.*failure/i,
  )
  await hooks.event?.(lifecycleEvent("debate-running", "call-1", "completed", "child-running"))
  await before(hooks, "debate-running", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-running" }))
})

test("retains a running event child ID for a metadata-free terminal retry", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-running-event", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await hooks.event?.(runningLifecycleEvent("debate-running-event", "normal", "child-running-event"))
  await hooks.event?.(terminalErrorWithoutMetadata("debate-running-event", "normal"))

  await assert.rejects(
    before(hooks, "debate-running-event", "wrong-retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "wrong-child" })),
    /task_id.*mismatch|child session/i,
  )
  await before(hooks, "debate-running-event", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-running-event" }))
})

test("ignores running task events from unrelated sessions and calls", async () => {
  const hooks = await guardHooks()

  await activate(hooks, "coordinator-with-untracked-call")

  await hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "untracked-part",
          sessionID: "coordinator-with-untracked-call",
          messageID: "untracked-message",
          type: "tool",
          callID: "untracked-call",
          tool: "task",
          state: {
            status: "running",
            input: {},
            metadata: { sessionId: "metadata-child" },
            title: "task",
            time: { start: 1 },
          },
        },
      },
    },
  } as never)

  await hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "unrelated-part",
          sessionID: "unrelated-session",
          messageID: "unrelated-message",
          type: "tool",
          callID: "unrelated-call",
          tool: "task",
          state: {
            status: "running",
            input: {},
            output: "not a task envelope",
            metadata: { sessionId: "metadata-child" },
            title: "task",
            time: { start: 1 },
          },
        },
      },
    },
  } as never)

  await before(
    hooks,
    "coordinator-with-untracked-call",
    "untracked-call",
    taskArgs("normal", 1, 1, { subagentType: "debate-one" }),
  )
})

test("rejects a conflicting running child ID without permitting the conflicting retry", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-write-once-running", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  assert.ok(hooks.event)
  await hooks.event?.(runningLifecycleEvent("debate-write-once-running", "normal", "child-a"))
  await assert.rejects(
    hooks.event?.(runningLifecycleEvent("debate-write-once-running", "normal", "child-b")),
    /child session.*(?:already|mismatch|conflict)/i,
  )
  await hooks.event?.(terminalErrorWithoutMetadata("debate-write-once-running", "normal"))

  await assert.rejects(
    before(hooks, "debate-write-once-running", "wrong-retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-b" })),
    /task_id.*mismatch|child session/i,
  )
  await before(hooks, "debate-write-once-running", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-a" }))
})

test("keeps an admission-time child ID write-once for a resumed normal attempt", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-write-once-normal", "round-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-write-once-normal", "round-1", "participant output", "child-a")
  await before(hooks, "debate-write-once-normal", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-a" }))
  assert.ok(hooks.event)
  await assert.rejects(
    hooks.event?.(lifecycleEvent("debate-write-once-normal", "round-2", "completed", "child-b")),
    /child session.*(?:already|mismatch|conflict)/i,
  )
  await hooks.event?.(lifecycleEvent("debate-write-once-normal", "round-2", "completed", "child-a"))

  await assert.rejects(
    before(hooks, "debate-write-once-normal", "round-3-wrong", taskArgs("normal", 1, 3, { subagentType: "debate-one", taskId: "child-b" })),
    /task_id.*mismatch|child session/i,
  )
  await before(hooks, "debate-write-once-normal", "round-3", taskArgs("normal", 1, 3, { subagentType: "debate-one", taskId: "child-a" }))
})

test("keeps an admission-time child ID write-once for a resumed retry attempt", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-write-once-retry", "round-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await afterFailure(hooks, "debate-write-once-retry", "round-1", "child-a")
  await before(hooks, "debate-write-once-retry", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-a" }))
  assert.ok(hooks.event)
  await assert.rejects(
    hooks.event?.(lifecycleEvent("debate-write-once-retry", "retry", "completed", "child-b")),
    /child session.*(?:already|mismatch|conflict)/i,
  )
  await hooks.event?.(lifecycleEvent("debate-write-once-retry", "retry", "completed", "child-a"))

  await assert.rejects(
    before(hooks, "debate-write-once-retry", "round-2-wrong", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-b" })),
    /task_id.*mismatch|child session/i,
  )
  await before(hooks, "debate-write-once-retry", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-a" }))
})

test("keeps an admission-time child ID write-once for a resumed formatter correction", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-write-once-correction", "round-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-write-once-correction", "round-1", "participant output", "child-a")
  await before(hooks, "debate-write-once-correction", "correction-1", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-a" }))
  assert.ok(hooks.event)
  await assert.rejects(
    hooks.event?.(lifecycleEvent("debate-write-once-correction", "correction-1", "completed", "child-b")),
    /child session.*(?:already|mismatch|conflict)/i,
  )
  await hooks.event?.(lifecycleEvent("debate-write-once-correction", "correction-1", "completed", "child-a"))

  await assert.rejects(
    before(hooks, "debate-write-once-correction", "correction-2-wrong", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-b" })),
    /task_id.*mismatch|child session/i,
  )
  await before(hooks, "debate-write-once-correction", "correction-2", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-a" }))
})

test("accepts repeated same-ID running and terminal lifecycle metadata", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-write-once-idempotent", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await hooks.event?.(runningLifecycleEvent("debate-write-once-idempotent", "normal", "child-a"))
  await hooks.event?.(runningLifecycleEvent("debate-write-once-idempotent", "normal", "child-a"))
  await after(hooks, "debate-write-once-idempotent", "normal", "participant output", "child-a")
  await hooks.event?.(lifecycleEvent("debate-write-once-idempotent", "normal", "completed", "child-a"))
  await hooks.event?.(lifecycleEvent("debate-write-once-idempotent", "normal", "completed", "child-a"))

  await before(hooks, "debate-write-once-idempotent", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-a" }))
})

test("delayed original failure cannot demote a successful retry", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-retry-authority", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await afterFailure(hooks, "debate-retry-authority", "normal", "child-retry-authority")
  await before(hooks, "debate-retry-authority", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-retry-authority" }))
  await after(hooks, "debate-retry-authority", "retry", "retry output", "child-retry-authority")
  await hooks.event?.(lifecycleEvent("debate-retry-authority", "normal", "error", "child-retry-authority"))

  await before(hooks, "debate-retry-authority", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-retry-authority" }))
})

test("delayed original terminal events cannot reopen a failed retry", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-retry-failed", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await afterFailure(hooks, "debate-retry-failed", "normal", "child-retry-failed")
  await before(hooks, "debate-retry-failed", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-retry-failed" }))
  await hooks.event?.(lifecycleEvent("debate-retry-failed", "retry", "error", "child-retry-failed"))
  await hooks.event?.(lifecycleEvent("debate-retry-failed", "normal", "completed", "child-retry-failed"))
  await hooks.event?.(lifecycleEvent("debate-retry-failed", "normal", "error", "child-retry-failed"))

  await assert.rejects(
    before(hooks, "debate-retry-failed", "retry-2", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-retry-failed" })),
    /retry.*completed|already completed|only one/i,
  )
  await assert.rejects(
    before(hooks, "debate-retry-failed", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-retry-failed" })),
    /normal dispatch failed|next eligible|task_id/i,
  )
})

test("authoritative retry error blocks continuation after an optimistic retry success", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-retry-error", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await afterFailure(hooks, "debate-retry-error", "normal", "child-retry-error")
  await before(hooks, "debate-retry-error", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-retry-error" }))
  await after(hooks, "debate-retry-error", "retry", "retry output", "child-retry-error")
  await hooks.event?.(lifecycleEvent("debate-retry-error", "retry", "error", "child-retry-error"))

  await assert.rejects(
    before(hooks, "debate-retry-error", "round-2", taskArgs("normal", 1, 2, { subagentType: "debate-one", taskId: "child-retry-error" })),
    /normal dispatch failed|next eligible|task_id/i,
  )
})

test("treats an empty completed lifecycle envelope as a failure", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-empty-event", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await hooks.event?.({
    event: {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-empty-event",
          sessionID: "debate-empty-event",
          messageID: "message-empty-event",
          type: "tool",
          callID: "call-1",
          tool: "task",
          state: {
            status: "completed",
            input: {},
            output: "<task id=\"child-empty-event\" state=\"completed\">\n<task_result>\n\n</task_result>\n</task>",
            title: "task",
            metadata: { sessionId: "child-empty-event" },
            time: { start: 1, end: 2 },
          },
        },
      },
    },
  } as never)
  await before(hooks, "debate-empty-event", "retry", taskArgs("retry", 1, 1, { subagentType: "debate-one", taskId: "child-empty-event" }))
})

test("admits formatter semantic correction without duplicating the normal dispatch", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-1", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await hooks.event?.(lifecycleEvent("debate-1", "call-1", "completed"))
  await before(hooks, "debate-1", "call-2", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-1" }))
  await assert.rejects(
    before(hooks, "debate-1", "call-3", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-1" })),
    /correction.*active|duplicate/i,
  )
  await hooks.event?.(lifecycleEvent("debate-1", "call-2", "completed"))
})

test("rejects a changed subagent_type on a formatter correction", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "debate-correction-type", ["registry-alpha", "debate-two", "debate-three"])

  await before(hooks, "debate-correction-type", "normal", taskArgs("normal", 1, 1, { subagentType: "registry-alpha" }))
  await after(hooks, "debate-correction-type", "normal", "participant output", "child-correction-type")

  await assert.rejects(
    before(hooks, "debate-correction-type", "correction", taskArgs("formatter-correction", 1, 1, { subagentType: "registry-beta", taskId: "child-correction-type" })),
    /subagent_type.*established/i,
  )
})

test("allows another formatter correction after a completed correction", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-repeat", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-repeat", "normal", "participant output", "child-repeat")
  await before(hooks, "debate-repeat", "correction-1", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-repeat" }))
  await hooks.event?.(lifecycleEvent("debate-repeat", "correction-1", "completed", "child-repeat"))
  await before(hooks, "debate-repeat", "correction-2", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-repeat" }))
})

test("allows another formatter correction after a failed correction", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-repeat-failed", "normal", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-repeat-failed", "normal", "participant output", "child-repeat-failed")
  await before(hooks, "debate-repeat-failed", "correction-1", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-repeat-failed" }))
  await hooks.event?.(lifecycleEvent("debate-repeat-failed", "correction-1", "error", "child-repeat-failed"))
  await before(hooks, "debate-repeat-failed", "correction-2", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-repeat-failed" }))
})

test("formatter correction does not consume the normal dispatch slot", async () => {
  const hooks = await guardHooks()

  await before(hooks, "debate-correction", "call-1", taskArgs("normal", 1, 1, { subagentType: "debate-one" }))
  await after(hooks, "debate-correction", "call-1", "participant output", "child-correction")
  await before(hooks, "debate-correction", "call-2", taskArgs("formatter-correction", 1, 1, { subagentType: "debate-one", taskId: "child-correction" }))
  await hooks.event?.(lifecycleEvent("debate-correction", "call-2", "completed", "child-correction"))
  await assert.rejects(
    before(hooks, "debate-correction", "call-3", taskArgs("normal", 1, 1, { subagentType: "debate-one" })),
    /duplicate completed/i,
  )
})

test("keeps dispatch state independent between debates", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-1", "call-1", args)
  await before(hooks, "debate-2", "call-2", args)
})

test("allows independent debates to establish different participant subagent types", async () => {
  const hooks = await guardHooks()
  await activate(hooks, "debate-type-a", ["registry-alpha", "debate-two", "debate-three"])
  await activate(hooks, "debate-type-b", ["registry-beta", "debate-two", "debate-three"])

  await before(hooks, "debate-type-a", "call-1", taskArgs("normal", 1, 1, { subagentType: "registry-alpha" }))
  await before(hooks, "debate-type-b", "call-2", taskArgs("normal", 1, 1, { subagentType: "registry-beta" }))
})

test("scopes lifecycle call IDs to their parent debate session", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-1", "same-call-id", args)
  await before(hooks, "debate-2", "same-call-id", args)
})

test("clears a deleted session before admitting a new first round", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-1", "call-1", args)
  await hooks.event?.({
    event: {
      type: "session.deleted",
      properties: { info: { id: "debate-1" } },
    },
  } as never)
  activatedSessions.get(hooks as object)?.delete("debate-1")
  await before(hooks, "debate-1", "call-2", args)
})

test("clears participant round state when its child session is deleted", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-child-delete", "call-1", args)
  await after(hooks, "debate-child-delete", "call-1", "participant output", "child-deleted")
  await hooks.event?.({
    event: {
      type: "session.deleted",
      properties: { info: { id: "child-deleted" } },
    },
  } as never)
  await before(hooks, "debate-child-delete", "call-2", args)
})

test("clears all dispatch state when the plugin is disposed", async () => {
  const hooks = await guardHooks()
  const args = taskArgs("normal", 1, 1, { subagentType: "debate-one" })

  await before(hooks, "debate-1", "call-1", args)
  await hooks.dispose?.()
  activatedSessions.get(hooks as object)?.clear()
  await before(hooks, "debate-1", "call-2", args)
})

test("ignores unrelated tool lifecycle hooks", async () => {
  const hooks = await guardHooks()
  assert.ok(hooks["tool.execute.before"])
  assert.ok(hooks["tool.execute.after"])

  await hooks["tool.execute.before"](
    { tool: "question", sessionID: "debate-1", callID: "question-1" },
    { args: { prompt: "Question" } },
  )
  await hooks["tool.execute.after"](
    { tool: "question", sessionID: "debate-1", callID: "question-1", args: {} },
    { title: "question", output: "answer", metadata: {} },
  )
})

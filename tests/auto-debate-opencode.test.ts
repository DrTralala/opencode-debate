import assert from "node:assert/strict"
import { test } from "node:test"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  createRuntime,
  inheritRestrictions,
  restrictRules,
} from "../src/auto-debate/opencode.ts"
import type { ConversationState, Owner, Rule, Runtime } from "../src/auto-debate/types.ts"
import { checkpointClient } from "./fixtures/checkpoint-client.ts"

test("parent restrictions cannot be replaced by participant allows", () => {
  assert.deepEqual(inheritRestrictions(
    [{ permission: "read", pattern: "*", action: "allow" }],
    [
      { permission: "read", pattern: "private/**", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "allow" },
    ],
  ), [
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "private/**", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("restriction filtering clones non-allow rules without changing order", () => {
  const original: Rule[] = [
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "grep", pattern: "*", action: "allow" },
  ]
  const result = restrictRules(original)

  assert.deepEqual(result, [original[0], original[1]])
  assert.notEqual(result[0], original[0])
  assert.notEqual(result[1], original[1])
})

const owner: Owner = { sessionID: "root-session", agent: "build", directory: "/workspace" }

function response<T>(data: T, error?: unknown) {
  return { data, error }
}

function makeInput(options: {
  session?: Record<string, unknown>
  agents?: Record<string, unknown>[]
  sessionGetError?: unknown
  agentsError?: unknown
  createResult?: Record<string, unknown>
  promptResult?: Record<string, unknown>
  promptError?: unknown
  status?: Record<string, { type: string }>
  messages?: Record<string, unknown>[]
} = {}) {
  const requests: { method: string; options: Record<string, unknown> }[] = []
  let submittedID = "submitted-user-message"
  let lastPrompt: Record<string, unknown> | undefined
  const correlate = (message: Record<string, unknown>): Record<string, unknown> => {
    const info = message.info as Record<string, unknown>
    return { ...message, info: { time: { created: 1, completed: 2 }, ...info,
      ...(info.parentID === "submitted-user-message" ? { parentID: submittedID } : {}) } }
  }
  const session = {
    get: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.get", options: request })
      const path = request.path as { id: string }
      const rootSession = options.session ?? {
        id: owner.sessionID,
        projectID: "project-1",
        directory: owner.directory,
        agent: owner.agent,
        permission: [],
        metadata: {},
      }
      const participantSession = {
        id: "child-session",
        projectID: "project-1",
        parentID: owner.sessionID,
        directory: owner.directory,
        agent: "debate-openai",
        model: { providerID: "fake", id: "fake-model", variant: "careful" },
      }
      return response(path.id === "child-session" ? participantSession : rootSession, options.sessionGetError)
    },
    create: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.create", options: request })
      return response(options.createResult ?? {
        id: "child-session",
        projectID: "project-1",
        parentID: owner.sessionID,
        directory: owner.directory,
        agent: "debate-openai",
        model: { providerID: "fake", id: "fake-model", variant: "careful" },
        metadata: (request.body as Record<string, unknown>).metadata,
      })
    },
    update: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.update", options: request })
      return response({ updated: true })
    },
    messages: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.messages", options: request })
      return response(options.messages?.map(correlate) ?? (lastPrompt ? [lastPrompt] : []))
    },
    status: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.status", options: request })
      return response(options.status ?? {
        [owner.sessionID]: { type: "idle" },
        "child-session": { type: "idle" },
      })
    },
    abort: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.abort", options: request })
      return response(true)
    },
    prompt: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.prompt", options: request })
      const body = request.body as Record<string, unknown>
      submittedID = typeof body.messageID === "string" ? body.messageID : submittedID
      lastPrompt = correlate(options.promptResult ?? {
        info: {
          id: "assistant-message",
          sessionID: "child-session",
          role: "assistant",
          parentID: submittedID,
        },
        parts: [
          { id: "reasoning", type: "reasoning", text: "private reasoning" },
          {
            id: "answer",
            type: "text",
            sessionID: "child-session",
            messageID: "assistant-message",
            text: "final answer",
          },
          {
            id: "other-message",
            type: "text",
            sessionID: "child-session",
            messageID: "older-message",
            text: "stale answer",
          },
        ],
      })
      return response(lastPrompt, options.promptError)
    },
    promptAsync: async (request: Record<string, unknown>) => {
      requests.push({ method: "session.promptAsync", options: request })
      return response(undefined)
    },
    message: async (request: Record<string, unknown>): Promise<{
      data?: Record<string, unknown>; error?: unknown; response?: Response; request?: Request
    }> => {
      requests.push({ method: "session.message", options: request })
      const path = request.path as { id: string; messageID: string }
      return response({
        info: {
          id: path.messageID,
          sessionID: path.id,
          role: "user",
        },
        parts: [{ type: "text", text: "cycle complete" }],
      })
    },
  }
  const app = {
    agents: async (request: Record<string, unknown>) => {
      requests.push({ method: "app.agents", options: request })
      return response(options.agents ?? [{
        name: owner.agent,
        mode: "primary",
        permission: [
          { permission: "read", pattern: "*.env", action: "deny" },
          { permission: "webfetch", pattern: "*", action: "allow" },
        ],
      }], options.agentsError)
    },
  }
  const input = {
    client: { session, app },
    project: { id: "project-1" },
    directory: owner.directory,
  } as unknown as PluginInput
  return { input, requests, session }
}

const participant = { agent: "debate-openai", description: "neutral", model: "fake/fake-model", variant: "careful" }
const createMember = (runtime: Runtime) => runtime.createParticipant(owner, participant, [])
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

test("validates ownership against root session, current agent and directory", async () => {
  const { input, requests } = makeInput()
  const runtime: Runtime = createRuntime(input)

  await runtime.assertOwner(owner)

  assert.ok(requests.some(({ method, options }) => method === "session.get"
    && JSON.stringify(options).includes(owner.directory)))
  assert.ok(requests.some(({ method, options }) => method === "app.agents"
    && JSON.stringify(options).includes(owner.directory)))
})

test("owner validation retains ordered tool permission overrides for effective denial checks", async () => {
  const effectiveRules: Rule[] = [
    { permission: "auto_debate", pattern: "*", action: "deny" },
    { permission: "auto_debate", pattern: "*", action: "allow" },
  ]
  const { input } = makeInput({ agents: [{ name: owner.agent, mode: "primary", permission: effectiveRules }] })

  assert.deepEqual(await createRuntime(input).assertOwner(owner), { agent: effectiveRules, session: [] })

  const sessionRule: Rule = { permission: "auto_debate", pattern: "*", action: "deny" }
  const sessionInput = makeInput({
    session: { id: owner.sessionID, projectID: "project-1", directory: owner.directory, agent: owner.agent,
      permission: [sessionRule] },
    agents: [{ name: owner.agent, mode: "primary", permission: effectiveRules }],
  })
  assert.deepEqual(await createRuntime(sessionInput.input).assertOwner(owner), { agent: effectiveRules, session: [sessionRule] })
})

test("rejects child sessions, cross-directory access and agent mismatches", async () => {
  for (const session of [
    { id: owner.sessionID, projectID: "project-1", directory: owner.directory, parentID: "parent", agent: owner.agent },
    { id: owner.sessionID, projectID: "project-1", directory: "/elsewhere", agent: owner.agent },
    { id: owner.sessionID, projectID: "project-1", directory: owner.directory, agent: "different-agent" },
  ]) {
    const { input } = makeInput({ session })
    await assert.rejects(createRuntime(input).assertOwner(owner), /owner|session|directory|agent/i)
  }
})

test("rejects an owner session that is absent or belongs to another project", async () => {
  for (const session of [
    { id: "other-session", projectID: "project-1", directory: owner.directory, agent: owner.agent },
    { id: owner.sessionID, projectID: "other-project", directory: owner.directory, agent: owner.agent },
  ]) {
    const { input } = makeInput({ session })
    await assert.rejects(createRuntime(input).assertOwner(owner), /owner|session|project/i)
  }
})

test("rejects the manual debate coordinator and non-primary agents", async () => {
  const coordinator = makeInput({
    session: {
      id: owner.sessionID,
      projectID: "project-1",
      directory: owner.directory,
      agent: "debate",
      permission: [],
      metadata: {},
    },
    agents: [{ name: "debate", mode: "primary", permission: [] }],
  })
  await assert.rejects(createRuntime(coordinator.input).assertOwner({ ...owner, agent: "debate" }), /coordinator|owner/i)

  const participant = makeInput({ agents: [{ name: owner.agent, mode: "subagent", permission: [] }] })
  await assert.rejects(createRuntime(participant.input).assertOwner(owner), /primary|participant/i)
})

test("fails closed when owner or effective permission data cannot be fetched", async () => {
  const failedSession = makeInput({ sessionGetError: new Error("session unavailable") })
  await assert.rejects(createRuntime(failedSession.input).assertOwner(owner), /session/i)

  const failedAgents = makeInput({ agentsError: new Error("agents unavailable") })
  const runtime = createRuntime(failedAgents.input)
  await assert.rejects(runtime.restrictions(owner), /agent|permission/i)

  const malformedRules = makeInput({ agents: [{
    name: owner.agent,
    mode: "primary",
    permission: [{ permission: "read", pattern: "*", action: "permit" }],
  }] })
  await assert.rejects(createRuntime(malformedRules.input).restrictions(owner), /permission|rule/i)
})

test("returns effective owner and session deny/ask rules but not allows", async () => {
  const { input, requests } = makeInput({
    session: {
      id: owner.sessionID,
      projectID: "project-1",
      directory: owner.directory,
      agent: owner.agent,
      permission: [
        { permission: "edit", pattern: "private/**", action: "ask" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
      metadata: {},
    },
  })

  assert.deepEqual(await createRuntime(input).restrictions(owner), [
    { permission: "read", pattern: "*.env", action: "deny" },
    { permission: "edit", pattern: "private/**", action: "ask" },
  ])
  assert.equal(requests.filter(({ method }) => method === "app.agents").length, 1)
})

test("creates an explicitly permissioned participant child with its model and variant", async () => {
  const { input, requests } = makeInput()
  const runtime = createRuntime(input)
  const member = await runtime.createParticipant(owner, {
    agent: "debate-openai",
    description: "neutral participant",
    model: "fake/fake-model",
    variant: "careful",
  }, [{ permission: "read", pattern: "*.env", action: "deny" }])
  const createRequest = requests.find(({ method }) => method === "session.create")?.options as {
    body: Record<string, unknown>
    query: Record<string, unknown>
  }

  assert.equal(member.sessionID, "child-session")
  assert.equal(member.runtimeAgent, "debate-openai")
  assert.equal(createRequest.body.parentID, owner.sessionID)
  assert.equal(createRequest.body.agent, "debate-openai")
  assert.deepEqual(createRequest.body.model, {
    providerID: "fake",
    id: "fake-model",
    variant: "careful",
  })
  assert.equal(createRequest.query.directory, owner.directory)
  assert.ok(Array.isArray(createRequest.body.permission))
  assert.ok((createRequest.body.permission as Rule[]).some((rule) => rule.permission === "edit" && rule.action === "deny"))
  assert.ok((createRequest.body.permission as Rule[]).some((rule) => rule.permission === "bash" && rule.action === "deny"))
  for (const permission of ["task", "skill", "question", "auto_debate"]) {
    assert.ok((createRequest.body.permission as Rule[]).some((rule) => rule.permission === permission && rule.action === "deny"))
  }
  assert.ok(!(createRequest.body.permission as Rule[]).some((rule) => rule.permission === "read" && rule.pattern === "*.env" && rule.action === "allow"))
})

test("returns only matching final assistant text and sends participant model selection", async () => {
  const { input, requests } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)

  assert.equal(await runtime.prompt(member, "produce JSON"), "final answer")
  const request = requests.find(({ method }) => method === "session.prompt")?.options as {
    body: Record<string, unknown>
  }
  assert.equal(request.body.agent, "debate-openai")
  assert.deepEqual(request.body.model, { providerID: "fake", modelID: "fake-model" })
  assert.equal(request.body.variant, "careful")
  assert.equal(request.body.sessionID, undefined)
})

test("reads the final assistant response for a prompt when the returned message contains only tools", async () => {
  const { input, requests } = makeInput({
    promptResult: {
      info: {
        id: "tool-step",
        parentID: "submitted-user-message",
        sessionID: "child-session",
        role: "assistant",
      },
      parts: [{ id: "tool-part", type: "tool", sessionID: "child-session", messageID: "tool-step" }],
    },
    messages: [
      {
        info: {
          id: "unrelated-old-answer",
          parentID: "older-user-message",
          sessionID: "child-session",
          role: "assistant",
        },
        parts: [{
          type: "text",
          sessionID: "child-session",
          messageID: "unrelated-old-answer",
          text: "stale response",
        }],
      },
      {
        info: {
          id: "final-answer",
          parentID: "submitted-user-message",
          sessionID: "child-session",
          role: "assistant",
        },
        parts: [
          { type: "reasoning", sessionID: "child-session", messageID: "final-answer", text: "private reasoning" },
          { type: "text", sessionID: "child-session", messageID: "final-answer", text: "completed final answer" },
        ],
      },
    ],
  })
  const runtime = createRuntime(input)

  assert.equal(await runtime.prompt(await createMember(runtime), "prompt after tool step"), "completed final answer")
  assert.ok(requests.some(({ method }) => method === "session.messages"))
})

test("propagates SDK errors instead of accepting a successful HTTP envelope", async () => {
  const { input } = makeInput({ promptError: new Error("provider request failed") })
  const runtime = createRuntime(input)
  await assert.rejects(runtime.prompt(await createMember(runtime), "prompt"), /participant prompt.*failed/i)
})

test("rejects successful HTTP responses containing malformed or non-matching message data", async () => {
  const malformed = makeInput({ promptResult: {
    info: { id: "message", sessionID: "another-session", role: "assistant" },
    parts: [{ id: "part", type: "text", text: "not this session" }],
  } })
  const runtime = createRuntime(malformed.input)
  await assert.rejects(runtime.prompt(await createMember(runtime), "prompt"), /assistant|message|text/i)

  const apiError = makeInput({ createResult: undefined })
  const { input } = apiError
  const typedClient = input.client as unknown as { session: { create: (request: unknown) => Promise<unknown> } }
  typedClient.session.create = async () => ({ data: undefined, error: new Error("HTTP error") })
  await assert.rejects(createRuntime(input).createParticipant(owner, {
    agent: "debate-openai", description: "neutral", model: "fake/fake-model",
  }, []), /create|session/i)
})

test("preserves unrelated session metadata while loading and saving its own state", async () => {
  const saved: ConversationState = {
    version: 1,
    discussions: [],
    outbox: [],
  }
  const f = checkpointClient()
  const runtime = createRuntime(f.input)
  await runtime.save(f.owner, saved)
  assert.deepEqual(await runtime.load(f.owner), saved)
  assert.deepEqual(f.sessions.get(f.owner.sessionID)?.metadata, { unrelated: { retained: true } })
  assert.equal(f.calls.some((call) => call.method === "update"), false)
})

test("participant creation rejects lost or substituted ownership metadata before admitting the child", async () => {
  for (const damage of ["missing", "nonce"]) {
    const f = checkpointClient()
    const create = f.session.create
    f.session.create = async (request) => {
      const response = await create(request)
      const value = response.data as Record<string, unknown>
      if (damage === "missing") value.metadata = {}
      else {
        const metadata = value.metadata as Record<string, Record<string, unknown>>
        assert.ok(metadata?.["opencode-debate-automatic-participant"], "marker must be sent in actual creation")
        const nonce = metadata["opencode-debate-automatic-participant"].nonce
        metadata["opencode-debate-automatic-participant"].nonce = nonce === "a".repeat(32) ? "b".repeat(32) : "a".repeat(32)
      }
      return response
    }
    await assert.rejects(createRuntime(f.input).createParticipant(f.owner, {
      agent: "debate-openai", description: "automatic", model: "fake/fake-model",
    }, []), /marker|binding|ownership|participant/i)
    assert.equal(f.calls.some((call) => call.method === "prompt"), false)
  }
})

test("rejects corrupt nested checkpoint state before writing partially trusted discussions", async () => {
  const state = {
    version: 1,
    discussions: [{
      id: "discussion-1",
      owner,
      config: { enabled: false, maxRounds: 3, persistTranscripts: true },
      brief: {
        question: "Question?",
        objective: "Objective",
        facts: [],
        assumptions: [],
        constraints: [],
        alternatives: [],
        uncertainty: "unknown",
        neededOutcome: "Decision",
      },
      panel: [],
      status: "paused",
      generation: 0,
      cycle: 1,
      results: [{}],
      evaluations: [],
      pendingTurns: [],
      followups: [],
    }],
    outbox: [],
  }
  const { input } = makeInput({
    session: {
      id: owner.sessionID,
      projectID: "project-1",
      directory: owner.directory,
      agent: owner.agent,
      permission: [],
      metadata: { "opencode-debate": state },
    },
  })

  await assert.rejects(createRuntime(input).save(owner, state as unknown as ConversationState), /state.*invalid|unsupported/i)
})

test("uses native idle state and refuses parent delivery when the parent is busy", async () => {
  const idle = makeInput()
  assert.equal(await createRuntime(idle.input).parentIdle(owner), true)

  const omittedIdle = makeInput({ status: {} })
  assert.equal(await createRuntime(omittedIdle.input).parentIdle(owner), true)

  const busy = makeInput({ status: { [owner.sessionID]: { type: "busy" } } })
  assert.equal(await createRuntime(busy.input).parentIdle(owner), false)
})

test("asynchronously delivers only into an idle owner session and returns its persisted message ID", async () => {
  const { runtime, calls, owner: deliveryOwner } = await makeDeliveryInput()
  const result = await runtime.deliver(deliveryOwner, { id: "outbox-delivery-1", outboxIDs: ["result"], text: "cycle complete" })
  assert.equal(result.state, "persisted")
  const messageID = result.messageID
  assert.match(messageID, /^msg_/)
  assert.notEqual(messageID, "outbox-delivery-1")
  const request = calls.find(({ method }) => method === "promptAsync")!
  assert.equal(request.body!.agent, deliveryOwner.agent)
  assert.deepEqual(request.body!.model, { providerID: "fake", modelID: "fake-model" })
  assert.equal(request.body!.variant, "careful")
  assert.equal(request.body!.messageID, messageID)
  assert.equal(request.body!.parts && (request.body!.parts as { text?: string }[])[0]?.text, "cycle complete")
  assert.equal(calls.some(({ method }) => method === "abort"), false)
})

const makeDeliveryInput = async () => {
  const f = checkpointClient()
  f.sessions.get(f.owner.sessionID)!.model = { providerID: "fake", id: "fake-model", variant: "careful" }
  const runtime = createRuntime(f.input)
  await runtime.load(f.owner)
  await runtime.save(f.owner, { version: 1, discussions: [{ id: "delivery-discussion", owner: f.owner,
    config: { enabled: false, maxRounds: 3, persistTranscripts: false },
    brief: { question: "Question", objective: "Decision", facts: [], assumptions: [], constraints: [], alternatives: [], uncertainty: "unknown", neededOutcome: "Decision" },
    panel: [], status: "awaiting-evaluation", generation: 0, cycle: 1, evaluations: [], pendingTurns: [], followups: [],
    results: [{ cycle: 1, rounds: 2, status: "complete", reason: "unanimous-stop", turns: [], failures: [], consensus: true }],
  }], outbox: [{ id: "result", discussionID: "delivery-discussion", cycle: 1, state: "pending" }] })
  return { ...f, runtime }
}

test("delivery polls past an SDK-shaped transient HTTP 404 without redispatching", async () => {
  const { runtime, calls, session, owner } = await makeDeliveryInput()
  const persisted = session.message
  let lookups = 0
  session.message = async (request) => {
    if (!calls.some((call) => call.method === "promptAsync")) return persisted(request)
    lookups++
    if (lookups === 1) return { error: { name: "NotFoundError", data: { message: "not yet persisted" } },
      response: new Response(null, { status: 404 }), request: new Request("http://localhost/session/root/message/pending") }
    return persisted(request)
  }
  const result = await runtime.deliver(owner, { id: "eventual-delivery", outboxIDs: ["result"], text: "result" })
  assert.equal(result.state, "persisted")
  assert.match(result.messageID, /^msg_/)
  assert.equal(lookups, 2)
  assert.equal(calls.filter((request) => request.method === "promptAsync").length, 1)
})

test("delivery does not retry non-404 HTTP failures even if the error payload claims not-found", async () => {
  const { runtime, session, owner } = await makeDeliveryInput()
  let lookups = 0
  session.message = async () => {
    lookups++
    return { error: { status: 404, name: "Unauthorized" }, response: new Response(null, { status: 401 }) }
  }
  const result = await runtime.deliver(owner, { id: "failed-delivery", outboxIDs: ["result"], text: "result" })
  assert.equal(result.state, "uncertain")
  assert.match(result.state === "uncertain" ? result.reason : "", /lookup.*failed/i)
  assert.equal(lookups, 1)
})

test("delivery exhausts its existing not-found polling guard rather than claiming persistence", async () => {
  const { runtime, calls, session, owner } = await makeDeliveryInput()
  let lookups = 0
  session.message = async () => {
    if (calls.some((call) => call.method === "promptAsync")) lookups++
    return { error: { name: "NotFoundError" }, response: new Response(null, { status: 404 }) }
  }
  const result = await runtime.deliver(owner, { id: "missing-delivery", outboxIDs: ["result"], text: "result" })
  assert.equal(result.state, "uncertain")
  assert.equal(lookups, 40)
  assert.equal(calls.filter((request) => request.method === "promptAsync").length, 1)
})

test("stop fences a prompt synchronously registered before its participant lookup", { timeout: 2000 }, async () => {
  const { input, requests, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  const lookup = gate()
  const entered = gate()
  const get = session.get
  let first = true
  session.get = async (request) => {
    if (first) {
      first = false
      entered.release()
      await lookup.promise
    }
    return get(request)
  }
  const outcome = runtime.prompt(member, "must not dispatch").then(() => "accepted", () => "rejected")
  await entered.promise
  let confirmed = false
  const stop = runtime.abort(member).then(() => { confirmed = true })
  try {
    await tick()
    assert.equal(confirmed, false, "lookup/start must be accounted for before confirming stop")
    lookup.release()
    await stop
    assert.equal(await outcome, "rejected")
    assert.equal(requests.some((request) => request.method === "session.prompt"), false)
    await assert.rejects(runtime.prompt(member, "new round"), /stopp|cancel/i)
  } finally {
    lookup.release()
    await Promise.allSettled([stop, outcome])
  }
})

test("idle and abort acknowledgement cannot confirm while an owned native request is still starting", { timeout: 2000 }, async () => {
  const { input, requests, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  const startup = gate()
  const dispatched = gate()
  const prompt = session.prompt
  let responseReceived = false
  let abortsAfterResponse = 0
  session.prompt = async (request) => {
    dispatched.release()
    await startup.promise
    const result = await prompt(request)
    responseReceived = true
    return result
  }
  const abort = session.abort
  session.abort = async (request) => {
    if (responseReceived) abortsAfterResponse++
    return abort(request)
  }
  const outcome = runtime.prompt(member, "pending native startup").then(() => "accepted", () => "rejected")
  await dispatched.promise
  let confirmed = false
  const stop = runtime.abort(member).then(() => { confirmed = true })
  try {
    await tick()
    assert.equal(confirmed, false)
    startup.release()
    await stop
    assert.equal(await outcome, "rejected", "late model output must not be accepted after stop starts")
    assert.ok(abortsAfterResponse > 0, "native runner cancellation must be reconciled after startup passes")
    const count = requests.filter((request) => request.method === "session.prompt").length
    await assert.rejects(runtime.prompt(member, "after stop"), /stopp|cancel/i)
    assert.equal(requests.filter((request) => request.method === "session.prompt").length, count)
  } finally {
    startup.release()
    await Promise.allSettled([stop, outcome])
  }
})

test("a returned intermediate tool step and idle sample do not settle an unfinished native runner", { timeout: 2000 }, async () => {
  const { input, session } = makeInput({ promptResult: {
    info: { id: "tool-step", parentID: "submitted-user-message", sessionID: "child-session", role: "assistant", finish: "tool-calls" },
    parts: [{ type: "tool", tool: "webfetch", sessionID: "child-session", messageID: "tool-step", state: { status: "running" } }],
  } })
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  const inspected = gate()
  const messages = session.messages
  let terminal = false
  session.messages = async (request) => {
    inspected.release()
    const result = await messages(request)
    return terminal ? response(result.data.map((message) => ({ ...message, parts: [],
      info: { ...(message.info as Record<string, unknown>), error: { name: "MessageAbortedError" } } }))) : result
  }
  const outcome = runtime.prompt(member, "tool step").then(() => "accepted", () => "rejected")
  await inspected.promise
  let confirmed = false
  const stop = runtime.abort(member).then(() => { confirmed = true })
  try {
    await tick()
    assert.equal(confirmed, false, "running tools survive neither an HTTP return nor an idle status")
    terminal = true
    await stop
    assert.equal(await outcome, "rejected")
  } finally {
    terminal = true
    await Promise.allSettled([stop, outcome])
  }
})

test("lost transport leaves cancellation unconfirmed and the participant fenced", async () => {
  const { input, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  session.prompt = async () => { throw new Error("transport lost before response") }
  await assert.rejects(runtime.prompt(member, "dispatched but unknown"), /transport lost/)
  await assert.rejects(runtime.abort(member), /unconfirmed|uncertain|verif/i)
  await assert.rejects(runtime.prompt(member, "must not retry this session"), /stopp|cancel|uncertain/i)
})

test("recovery cannot confirm cessation or resume a participant owned by another adapter instance", async () => {
  const { input } = makeInput()
  const previous = createRuntime(input)
  const member = await createMember(previous)
  const recovered = createRuntime(input)
  await assert.rejects(recovered.abort(member), /unknown|owned|verif|recover/i)
  await assert.rejects(recovered.prompt(member, "unknown pending native start"), /unknown|owned|recover/i)
})

test("concurrent prompts cannot introduce an untracked start for one participant", { timeout: 2000 }, async () => {
  const { input, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  const pending = gate()
  const dispatched = gate()
  const prompt = session.prompt
  session.prompt = async (request) => { dispatched.release(); await pending.promise; return prompt(request) }
  const first = runtime.prompt(member, "first")
  await dispatched.promise
  let rejected = false
  const second = runtime.prompt(member, "second").then(() => undefined, (error: Error) => {
    rejected = /pending|in.flight|running/i.test(error.message)
  })
  try {
    await tick()
    assert.equal(rejected, true, "the second dispatch must be rejected without waiting for the first")
  } finally {
    pending.release()
    await Promise.allSettled([first, second])
  }
})

test("failed cessation verification preserves the stopping fence and can be retried", async () => {
  const { input, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  const abort = session.abort
  session.abort = async () => response(false)
  await assert.rejects(runtime.abort(member), /acknowledge|cancellation/i)
  await assert.rejects(runtime.prompt(member, "after unconfirmed stop"), /stopp|cancel/i)
  session.abort = abort
  await runtime.abort(member)
  await assert.rejects(runtime.prompt(member, "after confirmed stop"), /stopp|cancel/i)
})

test("an incomplete native assistant prevents cessation despite idle and an abort acknowledgement", { timeout: 2000 }, async () => {
  const { input, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  await runtime.prompt(member, "completed original turn")
  const messages = session.messages
  const inspected = gate()
  let completed = false
  session.messages = async (request) => {
    const result = await messages(request)
    inspected.release()
    return response(result.data.map((message) => ({ ...message, info: {
      ...(message.info as Record<string, unknown>), time: completed ? { created: 1, completed: 2 } : { created: 1 },
    } })))
  }
  let confirmed = false
  const stop = runtime.abort(member).then(() => { confirmed = true })
  try {
    await inspected.promise
    assert.equal(confirmed, false)
    completed = true
    await stop
  } finally {
    completed = true
    await Promise.allSettled([stop])
  }
})

test("late reconciliation re-verifies cessation instead of reusing a stale successful stop", async () => {
  const { input, session } = makeInput()
  const runtime = createRuntime(input)
  const member = await createMember(runtime)
  await runtime.abort(member)
  session.messages = async () => response([{ info: { id: "foreign-pending-message", sessionID: member.sessionID,
    role: "user", time: { created: 3 } }, parts: [] }])
  await assert.rejects(runtime.abort(member), /unconfirmed|unowned/i)
  await assert.rejects(runtime.prompt(member, "late event must not reopen the participant"), /stopp|cancel/i)
})

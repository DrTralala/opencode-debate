import type { PluginInput } from "@opencode-ai/plugin"
import type { Owner } from "../../src/auto-debate/types.ts"

type RecordValue = Record<string, unknown>
export function checkpointClient() {
  const owner: Owner = { sessionID: "checkpoint-owner", agent: "build", directory: "/checkpoint-project" }
  const sessions = new Map<string, RecordValue>([[owner.sessionID, {
    id: owner.sessionID, agent: owner.agent, projectID: "checkpoint-project", directory: owner.directory,
    model: { providerID: "fake", id: "fake-model" }, permission: [], metadata: { unrelated: { retained: true } },
  }]])
  const histories = new Map<string, RecordValue[]>()
  const calls: { method: string; id?: string; body?: RecordValue }[] = []
  const statuses: RecordValue = {}
  let next = 0
  let modelCalls = 0
  const session = {
    get: async (request: { path: { id: string } }) => ({ data: structuredClone(sessions.get(request.path.id)) }),
    create: async (request: { body: RecordValue }) => {
      const id = `store-${++next}`
      const value = { ...structuredClone(request.body), id, projectID: "checkpoint-project", directory: owner.directory }
      sessions.set(id, value)
      histories.set(id, [])
      calls.push({ method: "create", id, body: request.body })
      return { data: structuredClone(value) }
    },
    children: async (request: { path: { id: string } }) => ({ data: [...sessions.values()]
      .filter((value) => value.parentID === request.path.id).map((value) => structuredClone(value)) }),
    status: async () => ({ data: structuredClone(statuses) }),
    messages: async (request: { path: { id: string } }) => ({ data: structuredClone(histories.get(request.path.id) ?? []) }),
    message: async (request: { path: { id: string; messageID: string } }) => {
      const message = histories.get(request.path.id)?.find((message) => (message.info as RecordValue).id === request.path.messageID)
      return message ? { data: structuredClone(message) } : { error: { name: "NotFoundError" }, response: new Response(null, { status: 404 }) }
    },
    prompt: async (request: { path: { id: string }; body: RecordValue }) => {
      calls.push({ method: "prompt", id: request.path.id, body: request.body })
      if (request.body.noReply !== true) modelCalls++
      const parts = request.body.parts as RecordValue[]
      const value = { info: { id: request.body.messageID, role: "user", sessionID: request.path.id,
        agent: request.body.agent, model: { ...(request.body.model as RecordValue), variant: request.body.variant }, time: { created: 100 } },
      parts: parts.map((part, index) => ({ ...part, id: `part-${next}-${index}`,
        sessionID: request.path.id, messageID: request.body.messageID })) }
      if (!histories.has(request.path.id)) histories.set(request.path.id, [])
      histories.get(request.path.id)!.push(value)
      if (request.body.noReply === true) return { data: structuredClone(value) }
      const id = `msg_answer_${String(request.body.messageID)}`
      const answer = { info: { id, role: "assistant", parentID: request.body.messageID, sessionID: request.path.id,
        time: { created: 100, completed: 101 }, finish: "stop" },
      parts: [{ id: `prt_${id}`, type: "text", sessionID: request.path.id, messageID: id, text: "final answer" }] }
      histories.get(request.path.id)!.push(answer)
      return { data: structuredClone(answer) as RecordValue }
    },
    promptAsync: async (request: { path: { id: string }; body: RecordValue }) => {
      calls.push({ method: "promptAsync", id: request.path.id, body: request.body })
      modelCalls++
      if (!histories.has(request.path.id)) histories.set(request.path.id, [])
      histories.get(request.path.id)!.push({ info: { id: request.body.messageID, role: "user", sessionID: request.path.id,
        agent: request.body.agent, model: { ...(request.body.model as RecordValue), variant: request.body.variant }, time: { created: 100 } },
      parts: (request.body.parts as RecordValue[]).map((part, index) => ({ ...part, id: `prt_delivery_${index}`,
        sessionID: request.path.id, messageID: request.body.messageID })) })
      return { data: undefined }
    },
    abort: async (request: { path: { id: string } }) => {
      calls.push({ method: "abort", id: request.path.id })
      return { data: true }
    },
    update: async (request: { path: { id: string }; body: RecordValue }) => {
      calls.push({ method: "update", id: request.path.id, body: request.body })
      const value = { ...sessions.get(request.path.id), ...structuredClone(request.body) }
      sessions.set(request.path.id, value)
      return { data: structuredClone(value) }
    },
  }
  const input = { client: { session, app: { agents: async () => ({ data: [
    { name: "build", mode: "primary", permission: [] },
  ] }) } }, project: { id: "checkpoint-project" }, directory: owner.directory } as unknown as PluginInput
  return { input, owner, sessions, histories, calls, session, statuses, modelCalls: () => modelCalls }
}

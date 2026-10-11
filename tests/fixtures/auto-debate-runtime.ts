import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createConnection, createServer as createNetServer } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk"
import type { PluginInput } from "@opencode-ai/plugin"
import { createRuntime } from "../../src/auto-debate/opencode.ts"
import type { ConversationState, Discussion, Owner, PanelMember, Rule } from "../../src/auto-debate/types.ts"

type RecordValue = Record<string, unknown>
type NativeClient = ReturnType<typeof createOpencodeClient>
type UpdateOptions = NonNullable<Parameters<NativeClient["session"]["update"]>[0]>
type MetadataUpdate = Omit<UpdateOptions, "body"> & { body: NonNullable<UpdateOptions["body"]> & { metadata: RecordValue } }
type Observation = {
  parentToolReturnedBeforeChildrenFinished: boolean
  threeChildrenWereBusyTogether: boolean
  deniedReadExecuted: boolean
  deniedEditExecuted: boolean
  participantSpawnedChild: boolean
  parentAskWasAutoApproved: boolean
  parentAskWasObserved: boolean
  deniedReadWasObserved: boolean
  immutableToolsWereHidden: boolean
  resultEvaluatedAfterBusyParentBecameIdle: boolean
  parentWasAbortedForDelivery: boolean
  childRanAfterConfirmedCancellation: boolean
  checkpointStateSurvivedRestart: boolean
  otherMetadataPreserved: boolean
  abortImmediatelyAfterDispatchWasChecked: boolean
  abortAfterBusyWasChecked: boolean
  abortBeforeDispatchWasChecked: boolean
  pendingStartupAcknowledgementWasNotConfirmation: boolean
  stoppedResultsWereRejected: boolean
  stoppedDispatchesWereRejected: boolean
  recoveryStopWasUnconfirmed: boolean
  rawNativeAbortWasAcknowledgementOnly: boolean
  stoppedReverificationWasExecuted: boolean
  checkpointSavesMadeNoModelCalls: boolean
  checkpointSavesDidNotChangeOwnerHistory: boolean
  checkpointSavesPreservedBusyOwner: boolean
  concurrentOwnerMetadataPreserved: boolean
  multipleCheckpointRecordsSurvivedRestart: boolean
  sameManagerCheckpointWritesSerialized: boolean
  incompleteCheckpointTailRejected: boolean
  corruptCheckpointRejected: boolean
  forkedCheckpointHistoryRejected: boolean
  ambiguousCheckpointStoresRejected: boolean
  deletedCheckpointStoreRejected: boolean
  transcriptOffCreatedNoFiles: boolean
  checkpointBootstrapLifecycleWorked: boolean
  missingStateParticipantRemnantsRejected: boolean
  unrelatedExistingChildAllowsBootstrap: boolean
  corruptAutomaticParticipantMarkerRejected: boolean
  erasedStateAutomaticMembersRejected: boolean
  unmarkedRenamedCheckpointHistoryRejected: boolean
  heldDeliveryForkReconciledWithoutRedispatch: boolean
  lostDeliveryResponseReconciledAfterWriterRestart: boolean
  pausedPanelContinuedAfterWriterRestart: boolean
  pausedPanelContinuedAfterNativeRestart: boolean
  unknownStartupStayedUnconfirmedAfterRecovery: boolean
  receiptPrefixesSurvivedManagerSaves: boolean
  changedReceiptPrefixRejected: boolean
  receiptWritesPreservedOwnerPrivacy: boolean
  fakeProviderRequests: number
  observedNativeToolCalls: string[]
}

type ProbeResult = { observation: Observation; version: string }
type NativeEvent = {
  type: string
  sessionID?: string
  permissionID?: string
  permission?: string
  response?: string
  requestID?: string
  reply?: string
  errorName?: string
  errorMessage?: string
  tool?: string
  parentID?: string
  status?: string
  index?: number
  ok?: boolean
  finalMatched?: boolean
  time: number
}
type ProviderObservation = {
  requests: { marker: string; time: number; stage: number; sessionID: string; tools: string[]; stream: boolean }[]
  finalResponses: { marker: string; time: number }[]
  parentAskHits: number
  autoApprovedPanelHits: Set<number>
  explicitlyApprovedPanels: Set<number>
  pendingPanels: Set<number>
  errors: string[]
  startups: { sessionID: string; kind: string; time: number; released?: number }[]
}

const PARENT_RULES: Rule[] = [
  { permission: "read", pattern: "*private.txt", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "ask" },
]
const WAIT_MS = 20_000
const POLL_MS = 25

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function getData<T>(result: unknown, operation: string): T {
  if (!isRecord(result)) throw new Error(`Native ${operation} returned an invalid SDK response`)
  if (result.error !== undefined && result.error !== null) {
    throw new Error(`Native ${operation} failed`)
  }
  if (!Object.hasOwn(result, "data") || result.data === undefined || result.data === null) {
    throw new Error(`Native ${operation} returned no data`)
  }
  return result.data as T
}

function assertNoError(result: unknown, operation: string): void {
  if (!isRecord(result) || (result.error !== undefined && result.error !== null)) {
    throw new Error(`Native ${operation} failed`)
  }
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined | false>, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    let timer: NodeJS.Timeout | undefined
    const result = await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for isolated native runtime: ${label}`)), remaining)
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
    if (result !== undefined && result !== false) return result as T
    await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_MS))
  }
  throw new Error(`Timed out waiting for isolated native runtime: ${label}`)
}

export async function observeBusyTogether(
  sessionIDs: readonly string[],
  ready: () => Promise<boolean>,
  snapshot: () => Promise<unknown>,
  timeoutMs = WAIT_MS,
): Promise<boolean> {
  return waitFor("simultaneous native busy snapshot after dispatch", async () => {
    if (!await ready()) return undefined
    const statuses = await snapshot()
    if (!isRecord(statuses)) throw new Error("Native status snapshot was invalid")
    return sessionIDs.length === 3 && sessionIDs.every((id) =>
      isRecord(statuses[id]) && statuses[id].type === "busy") ? true : undefined
  }, timeoutMs)
}

export function assertPendingNativePrompts(events: readonly NativeEvent[], sessionIDs: readonly string[]): void {
  const failed = events.find((event) => event.sessionID && sessionIDs.includes(event.sessionID)
    && ((event.type === "runtime-probe-child-settled" && event.ok === false) || event.type === "session.error"))
  if (failed) throw new Error(`Native participant ${failed.sessionID} failed: ${failed.errorMessage ?? failed.errorName ?? "prompt failed"}`)
}

export function nativeParentReturnedBeforeChildren(
  messages: readonly RecordValue[], events: readonly NativeEvent[], panelIDs: readonly string[], parentID: string,
): boolean {
  return panelIDs.length === 3 && toolParts(messages)
    .some((part) => part.tool === "auto_debate_probe_launch" && part.state === "completed")
    && events.some((event) => event.type === "tool.execute.after" && event.sessionID === parentID
      && event.tool === "auto_debate_probe_launch")
    && !events.some((event) => event.type === "runtime-probe-child-settled" && event.sessionID && panelIDs.includes(event.sessionID))
}

export function nativeCancellationEffects(input: {
  events: readonly NativeEvent[]
  requests: readonly { sessionID: string; time: number }[]
  messages: readonly { sessionID: string; time: number; final: boolean }[]
  confirmed: Readonly<Record<string, number>>
}): boolean {
  // Millisecond timestamps cannot order a tie. Treat it as indeterminate/failing,
  // not evidence of quiescence, for every native-effect surface in the hard gate.
  const atOrAfterAbort = (sessionID: string | undefined, time: number) => sessionID !== undefined
    && input.confirmed[sessionID] !== undefined && time >= input.confirmed[sessionID]
  return input.requests.some((request) => atOrAfterAbort(request.sessionID, request.time))
    || input.events.some((event) => atOrAfterAbort(event.sessionID, event.time)
      && (event.type === "tool.execute.after" || (event.type === "session.status" && event.status === "busy")))
    || input.messages.some((message) => message.final && atOrAfterAbort(message.sessionID, message.time))
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve an isolated loopback port")
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  return address.port
}

function deferred() {
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
  return { promise, release: () => resolvePromise() }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length === 0 ? undefined : JSON.parse(text) as unknown
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").join("\n")
  }
  return ""
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ""
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (isRecord(message) && message.role === "user") return contentText(message.content)
  }
  return ""
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

function providerToolCall(name: string, args: RecordValue, suffix: string) {
  return {
    id: `call_${suffix}_${randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

function streamResponse(response: ServerResponse, marker: string, calls?: ReturnType<typeof providerToolCall>[]): void {
  const id = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  const created = Math.floor(Date.now() / 1000)
  const model = "fake-model"
  if (response.destroyed || response.writableEnded) return
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const chunk = (delta: RecordValue, finishReason: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }, null))}\n\n`)
  if (calls) {
    calls.forEach((call, index) => {
      response.write(`data: ${JSON.stringify(chunk({
        tool_calls: [{
          index,
          id: call.id,
          type: call.type,
          function: call.function,
        }],
      }, null))}\n\n`)
    })
    response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify(chunk({ content: JSON.stringify({ turn: `native probe ${marker}` }) }, null))}\n\n`)
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

function writeNonStreaming(response: ServerResponse, marker: string, calls?: ReturnType<typeof providerToolCall>[]): void {
  const message = calls
    ? { role: "assistant", content: null, tool_calls: calls }
    : { role: "assistant", content: JSON.stringify({ turn: `native probe ${marker}` }) }
  json(response, 200, {
    id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, message, finish_reason: calls ? "tool_calls" : "stop" }],
  })
}

function respond(response: ServerResponse, body: RecordValue, marker: string, calls?: ReturnType<typeof providerToolCall>[]): void {
  if (body.stream === false) writeNonStreaming(response, marker, calls)
  else streamResponse(response, marker, calls)
}

async function readEvents(path: string): Promise<NativeEvent[]> {
  let content: string
  try {
    content = await readFile(path, "utf8")
  } catch {
    return []
  }
  const events: NativeEvent[] = []
  for (const line of content.split("\n")) {
    if (!line) continue
    try {
      const item: unknown = JSON.parse(line)
      if (isRecord(item) && typeof item.type === "string" && typeof item.time === "number") {
        events.push(item as NativeEvent)
      }
    } catch {
      // The plugin writes complete JSONL records; a trailing partial line is ignored.
    }
  }
  return events
}

export function nativeStartupKind(text: string): string | undefined {
  return text.startsWith("AUTO_DEBATE_CANCEL_PENDING:") ? "adapter"
    : text.startsWith("AUTO_DEBATE_RAW_NATIVE_START:") ? "raw"
      : text.startsWith("AUTO_DEBATE_RECONCILIATION_DELIVERY:") ? "delivery"
        : text.startsWith("AUTO_DEBATE_RECONCILIATION_PENDING:") ? "recovery" : undefined
}

function nativePluginSource(providerURL: string): string {
  const runtimeURL = new URL("../../src/auto-debate/opencode.ts", import.meta.url).href
  return `import { appendFileSync } from "node:fs";
import { tool } from "@opencode-ai/plugin";
import { createRuntime } from ${JSON.stringify(runtimeURL)};
const file = process.env.OPENCODE_DEBATE_PROBE_EVENTS;
const providerURL = ${JSON.stringify(providerURL)};
${nativeStartupKind.toString()}
function record(entry) {
  if (!file) return;
  appendFileSync(file, JSON.stringify({ ...entry, time: Date.now() }) + "\\n", "utf8");
}
export default async function RuntimeProbePlugin(input) {
  record({ type: "runtime-probe-plugin-loaded" });
  const runtime = createRuntime(input);
  return {
    "chat.message": async ({ sessionID }, { parts }) => {
      const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\\n");
      const kind = nativeStartupKind(text);
      if (!kind) return;
      record({ type: "runtime-probe-startup-held", sessionID });
      const response = await fetch(providerURL + "/probe-startup?kind=" + kind + "&session=" + sessionID);
      if (!response.ok) throw new Error("Isolated startup barrier failed");
      await response.text();
      record({ type: "runtime-probe-startup-released", sessionID });
    },
    tool: {
      auto_debate_probe_launch: tool({
        description: "Launch the three isolated native runtime probe participants in the background.",
        args: {},
        async execute(_args, context) {
          const owner = { sessionID: context.sessionID, agent: context.agent, directory: input.directory };
          const restrictions = await runtime.restrictions(owner);
          const participant = { agent: "probe-participant", description: "isolated native participant", model: "probe/fake-model" };
          const members = [];
          for (let index = 0; index < 3; index++) members.push(await runtime.createParticipant(owner, participant, restrictions));
          members.forEach((member, index) => {
            record({ type: "runtime-probe-participant-dispatched", sessionID: member.sessionID, index });
            void runtime.prompt(member, "AUTO_DEBATE_RUNTIME_PANEL_" + index + ": run the isolated permission probe.").then(
              (text) => record({ type: "runtime-probe-child-settled", sessionID: member.sessionID, ok: true,
                finalMatched: text.includes("native probe panel-" + index) }),
              (error) => record({ type: "runtime-probe-child-settled", sessionID: member.sessionID, ok: false,
                errorMessage: String(error?.message || "participant failed").slice(0, 500) })
            );
          });
          return JSON.stringify({ sessionIDs: members.map((member) => member.sessionID) });
        },
      }),
    },
    event: async ({ event }) => {
      const p = event && event.properties && typeof event.properties === "object" ? event.properties : {};
      const info = p.info && typeof p.info === "object" ? p.info : p;
      if (event.type === "session.created") {
        record({ type: event.type, sessionID: info.id, parentID: info.parentID });
      } else if (event.type === "session.status") {
        record({ type: event.type, sessionID: p.sessionID, status: p.status && p.status.type });
      } else if (event.type === "session.error") {
        record({ type: event.type, sessionID: p.sessionID, errorName: p.error && p.error.name,
          errorMessage: String(p.error?.data?.message || p.error?.message || "").slice(0, 500) });
      } else if (typeof event.type === "string" && event.type.startsWith("permission.")) {
        const nested = p.permission && typeof p.permission === "object" ? p.permission : {};
        record({
          type: event.type,
          sessionID: p.sessionID || nested.sessionID,
          permissionID: p.id || p.permissionID || nested.id || p.requestID,
          requestID: p.requestID,
          permission: p.permissionName || p.type || (typeof p.permission === "string" ? p.permission : nested.type),
          response: p.response,
          reply: p.reply,
        });
      }
    },
    "tool.execute.after": async ({ tool, sessionID }) => {
      record({ type: "tool.execute.after", tool, sessionID });
    },
  };
}
`
}

function createProviderServer(options: {
  projectDirectory: string
  providerURL: string
  panelGates: ReturnType<typeof deferred>[]
  parentBusyGate: ReturnType<typeof deferred>
  parentEvaluationGate: ReturnType<typeof deferred>
  cancelImmediateGate: ReturnType<typeof deferred>
  cancelBusyGate: ReturnType<typeof deferred>
  pendingStartupGate: ReturnType<typeof deferred>
  rawStartupGate: ReturnType<typeof deferred>
  deliveryStartupGate: ReturnType<typeof deferred>
  recoveryStartupGate: ReturnType<typeof deferred>
  recoveryBusyGate: ReturnType<typeof deferred>
  receiptTurnGate: ReturnType<typeof deferred>
  observations: ProviderObservation
}) {
  const requestCounts = new Map<string, number>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`)
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, { object: "list", data: [{ id: "fake-model", object: "model", created: 0, owned_by: "local-probe" }] })
      return
    }
    if (request.method === "GET" && url.pathname === "/probe-parent-ask") {
      options.observations.parentAskHits++
      const panelIndex = Number(url.searchParams.get("panel"))
      if (!options.observations.explicitlyApprovedPanels.has(panelIndex)) {
        options.observations.autoApprovedPanelHits.add(panelIndex)
      }
      response.writeHead(200, { "content-type": "text/plain" })
      response.end("local permission probe response")
      return
    }
    if (request.method === "GET" && url.pathname === "/probe-startup") {
      const entry = { sessionID: url.searchParams.get("session") ?? "", kind: url.searchParams.get("kind") ?? "",
        time: Date.now(), released: undefined as number | undefined }
      options.observations.startups.push(entry)
      await (entry.kind === "adapter" ? options.pendingStartupGate.promise : entry.kind === "raw" ? options.rawStartupGate.promise
        : entry.kind === "delivery" ? options.deliveryStartupGate.promise : options.recoveryStartupGate.promise)
      entry.released = Date.now()
      response.end("isolated startup released")
      return
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      json(response, 404, { error: { message: "local probe route not found" } })
      return
    }

    try {
      const requestBody = await readBody(request)
      if (!isRecord(requestBody)) throw new Error("invalid provider request")
      const marker = lastUserText(requestBody.messages)
      const panel = /AUTO_DEBATE_RUNTIME_PANEL_(\d)/.exec(marker)
      const markerKey = panel ? `panel-${panel[1]}`
        : marker.includes("AUTO_DEBATE_RUNTIME_LAUNCH") ? "parent-launch"
          : marker.includes("AUTO_DEBATE_RUNTIME_PARENT_BUSY") ? "parent-busy"
            : marker.includes("AUTO_DEBATE_RUNTIME_OWNER_EVALUATE") ? "parent-evaluation"
              : marker.includes("AUTO_DEBATE_CANCEL_PENDING") ? "cancel-pending"
                : marker.includes("AUTO_DEBATE_CANCEL_BEFORE_DISPATCH") ? "cancel-before"
                  : marker.includes("AUTO_DEBATE_RAW_NATIVE_START") ? "raw-native"
              : marker.includes("AUTO_DEBATE_CANCEL_BUSY") ? "cancel-busy"
                 : marker.includes("AUTO_DEBATE_RECONCILIATION_PENDING") ? "reconciliation-pending"
                   : marker.includes("AUTO_DEBATE_RECONCILIATION_HELD") ? "receipt-held"
                     : "other"
      const count = (requestCounts.get(markerKey) ?? 0) + 1
      requestCounts.set(markerKey, count)
      const tools = Array.isArray(requestBody.tools)
        ? requestBody.tools.flatMap((item) => isRecord(item) && isRecord(item.function)
          && typeof item.function.name === "string" ? [item.function.name] : [])
        : []
      options.observations.requests.push({
        marker: markerKey, time: Date.now(), stage: count,
        sessionID: String(request.headers["x-opencode-session-id"] ?? ""), tools,
        stream: requestBody.stream !== false,
      })

      if (markerKey === "parent-launch") {
        respond(response, requestBody, markerKey, count === 1
          ? [providerToolCall("auto_debate_probe_launch", {}, "launch")] : undefined)
        return
      }

      if (panel) {
        const index = Number(panel[1])
        if (count === 1) {
          if (!tools.includes("read")) throw new Error("Scoped-denial read tool was not advertised")
          const calls = [
            providerToolCall("read", { filePath: join(options.projectDirectory, "private.txt") }, `read${index}`),
            providerToolCall("edit", {
              filePath: join(options.projectDirectory, "protected-edit.txt"),
              oldString: "before",
              newString: "after",
            }, `edit${index}`),
            providerToolCall("task", {
              description: "must not spawn",
              prompt: "This attempt must be denied by the native runtime.",
              subagent_type: "probe-participant",
            }, `task${index}`),
          ]
          respond(response, requestBody, markerKey, calls)
          return
        }
        if (count === 2) {
          const call = providerToolCall(
            "webfetch",
            { url: `${options.providerURL}/probe-parent-ask?panel=${index}`, format: "text" },
            `ask${index}`,
          )
          respond(response, requestBody, markerKey, [call])
          return
        }
        options.observations.pendingPanels.add(index)
        await options.panelGates[index]?.promise
        options.observations.finalResponses.push({ marker: markerKey, time: Date.now() })
        respond(response, requestBody, markerKey)
        return
      }

      if (markerKey === "parent-busy") {
        await options.parentBusyGate.promise
        options.observations.finalResponses.push({ marker: markerKey, time: Date.now() })
        respond(response, requestBody, markerKey)
        return
      }
      if (markerKey === "parent-evaluation") {
        await options.parentEvaluationGate.promise
        options.observations.finalResponses.push({ marker: markerKey, time: Date.now() })
        respond(response, requestBody, markerKey)
        return
      }
      if (markerKey === "cancel-pending") {
        await options.cancelImmediateGate.promise
        options.observations.finalResponses.push({ marker: markerKey, time: Date.now() })
        respond(response, requestBody, markerKey)
        return
      }
      if (markerKey === "cancel-busy") {
        await options.cancelBusyGate.promise
        options.observations.finalResponses.push({ marker: markerKey, time: Date.now() })
        respond(response, requestBody, markerKey)
        return
      }
      if (markerKey === "reconciliation-pending") await options.recoveryBusyGate.promise
      if (markerKey === "receipt-held") await options.receiptTurnGate.promise
      respond(response, requestBody, markerKey)
    } catch (error) {
      options.observations.errors.push(error instanceof Error ? error.message.slice(0, 300) : "local provider failed")
      if (!response.destroyed && !response.writableEnded) {
        json(response, 500, { error: { message: "local fake provider failed" } })
      }
    }
  })
  return server
}

async function startServer(
  binary: string,
  projectDirectory: string,
  port: number,
  environment: NodeJS.ProcessEnv,
  diagnostics: string[],
): Promise<ChildProcess> {
  const process = spawn(binary, [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "ERROR",
  ], {
    cwd: projectDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue
      if (!/(error|warn|listen|server|config|plugin|install)/i.test(line)) continue
      diagnostics.push(line.replace(/(api[_-]?key|token|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 500))
    }
    if (diagnostics.length > 40) diagnostics.splice(0, diagnostics.length - 40)
  }
  process.stdout?.on("data", capture)
  process.stderr?.on("data", capture)
  try {
    await waitFor("server startup", async () => {
      if (process.exitCode !== null) throw new Error("Isolated OpenCode process exited during startup")
      return await new Promise<boolean | undefined>((resolvePromise) => {
        const socket = createConnection({ host: "127.0.0.1", port })
        socket.once("connect", () => {
          socket.destroy()
          resolvePromise(true)
        })
        socket.once("error", () => resolvePromise(undefined))
      })
    })
  } catch (error) {
    await stopServer(process)
    throw error
  }
  return process
}

async function stopServer(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = new Promise<void>((resolvePromise) => process.once("exit", () => resolvePromise()))
  process.kill("SIGTERM")
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 4_000)),
  ])
  if (graceful) return
  if (process.exitCode === null) process.kill("SIGKILL")
  await Promise.race([
    exited,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000)),
  ])
  if (process.exitCode === null && process.signalCode === null) {
    throw new Error("Isolated native process did not exit after bounded shutdown")
  }
}

export function isolatedEnvironment(paths: {
  home: string
  xdgConfig: string
  xdgData: string
  xdgCache: string
  xdgState: string
  temporary: string
  events: string
}): NodeJS.ProcessEnv {
  const workspace = dirname(resolve(paths.events))
  if (!workspace.startsWith("/tmp/opencode/")
    || Object.values(paths).some((path) => !resolve(path).startsWith(`${workspace}/`))) {
    throw new Error("Native fixture paths must remain in one isolated disposable /tmp/opencode workspace")
  }
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: paths.home,
    TMPDIR: paths.temporary,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_STATE_HOME: paths.xdgState,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    OPENCODE_DEBATE_PROBE_EVENTS: paths.events,
    OPENCODE_TEST_HOME: paths.home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(workspace, "managed-config"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_CONFIG: join(workspace, "project", "opencode.json"),
    OPENCODE_CONFIG_DIR: join(workspace, "project", ".opencode"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    npm_config_cache: join(paths.xdgCache, "npm"),
    npm_config_logs_dir: join(paths.xdgCache, "npm-logs"),
    npm_config_userconfig: join(paths.home, ".npmrc"),
    npm_config_globalconfig: join(paths.home, "npm-globalrc"),
    npm_config_prefix: join(paths.home, "npm-prefix"),
    BUN_INSTALL: join(paths.home, ".bun"),
    BUN_INSTALL_CACHE_DIR: join(paths.xdgCache, "bun"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(paths.home, ".gitconfig"),
  }
  if (process.env.OPENCODE_BIN) environment.OPENCODE_BIN = process.env.OPENCODE_BIN
  return environment
}

function trackedClient(
  baseUrl: string,
  abortRequests: { sessionID: string; time: number }[],
  boundaries: { method: string; route: string; status: number; time: number }[],
  beforeRequest?: (request: Request) => Promise<void>,
): NativeClient {
  const client = createOpencodeClient({
    baseUrl,
    fetch: async (request) => {
      if (beforeRequest) await beforeRequest(request)
      const response = await fetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
      })
      boundaries.push({ method: request.method, route: new URL(request.url).pathname,
        status: response.status, time: Date.now() })
      if (boundaries.length > 200) boundaries.splice(0, boundaries.length - 200)
      return response
    },
  })
  const abort = client.session.abort.bind(client.session)
  client.session.abort = (request) => {
    abortRequests.push({ sessionID: request.path.id, time: Date.now() })
    return abort(request)
  }
  return client
}

async function nativeStatus(client: NativeClient, directory: string, sessionID: string): Promise<string | undefined> {
  const statuses = getData<unknown>(await client.session.status({ query: { directory } }), "session status")
  if (!isRecord(statuses)) throw new Error("Native session status map was invalid")
  if (statuses[sessionID] === undefined) return "idle"
  return isRecord(statuses[sessionID]) && typeof statuses[sessionID].type === "string"
    ? statuses[sessionID].type
    : undefined
}

async function nativeMessages(client: NativeClient, directory: string, sessionID: string): Promise<RecordValue[]> {
  const messages = getData<unknown>(await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  }), "session messages")
  if (!Array.isArray(messages)) throw new Error("Native session messages were invalid")
  return messages.filter(isRecord)
}

function toolParts(messages: readonly RecordValue[]): { tool: string; state: string; error?: string; callID?: string }[] {
  const result: { tool: string; state: string; error?: string; callID?: string }[] = []
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool" || typeof part.tool !== "string") continue
      const status = isRecord(part.state) && typeof part.state.status === "string" ? part.state.status : "unknown"
      result.push({ tool: part.tool, state: status,
        error: isRecord(part.state) && typeof part.state.error === "string" ? part.state.error.slice(0, 500) : undefined,
        callID: typeof part.callID === "string" ? part.callID : undefined })
    }
  }
  return result
}

function assistantForUser(messages: readonly RecordValue[], messageID: string): RecordValue | undefined {
  return messages.find((message) => isRecord(message.info)
    && message.info.role === "assistant"
    && message.info.parentID === messageID)
}

function promptAsyncRequest(
  sessionID: string,
  directory: string,
  messageID: string,
  agent: string,
  text: string,
) {
  return {
    path: { id: sessionID },
    query: { directory },
    body: {
      messageID,
      agent,
      model: { providerID: "probe", modelID: "fake-model" },
      parts: [{ type: "text" as const, text }],
    },
  }
}

export async function runAutoDebateRuntimeProbe(options: { evidencePath?: string } = {}): Promise<ProbeResult> {
  if (options.evidencePath && dirname(resolve(options.evidencePath)) !== resolve(
    ".superpowers/sdd/2026-10-09-automatic-debate",
  )) throw new Error("Native probe evidence must stay in the Task 1 evidence directory")
  const workspace = await mkdtemp("/tmp/opencode/auto-debate-task3-")
  const projectDirectory = join(workspace, "project")
  const home = join(workspace, "home")
  const temporary = join(workspace, "tmp")
  const xdgConfig = join(workspace, "xdg-config")
  const xdgData = join(workspace, "xdg-data")
  const xdgCache = join(workspace, "xdg-cache")
  const xdgState = join(workspace, "xdg-state")
  const eventsPath = join(workspace, "native-events.jsonl")
  const pluginDirectory = join(projectDirectory, ".opencode", "plugins")
  const projectConfigPath = join(projectDirectory, "opencode.json")
  const providerPort = await freePort()
  const serverPort = await freePort()
  const providerURL = `http://127.0.0.1:${providerPort}`
  const baseURL = `http://127.0.0.1:${serverPort}`
  const nativeAbortRequests: { sessionID: string; time: number }[] = []
  const nativeDiagnostics: string[] = []
  const apiBoundaries: { method: string; route: string; status: number; time: number }[] = []
  const promptFailures: string[] = []
  const messageEvidence: unknown[] = []
  const statusEvidence: unknown[] = []
  const persistenceEvidence: unknown[] = []
  let beforeNativeRequest: ((request: Request) => Promise<void>) | undefined
  const confirmedAborts: Record<string, number> = {}
  const acknowledgedRawAborts: Record<string, number> = {}
  const cancellationProof: unknown[] = []
  const nativeProcesses: ChildProcess[] = []
  let workspacePathsVerified = false
  let client!: NativeClient
  let version = "not-queried"
  let failure: string | undefined
  let completedObservation: Observation | undefined
  const providerObservations: ProviderObservation = {
    requests: [],
    finalResponses: [],
    parentAskHits: 0,
    autoApprovedPanelHits: new Set(),
    explicitlyApprovedPanels: new Set(),
    pendingPanels: new Set(),
    errors: [],
    startups: [],
  }
  const panelGates = [deferred(), deferred(), deferred()]
  const parentBusyGate = deferred()
  const parentEvaluationGate = deferred()
  const cancelImmediateGate = deferred()
  const cancelBusyGate = deferred()
  const pendingStartupGate = deferred()
  const rawStartupGate = deferred()
  const deliveryStartupGate = deferred()
  const recoveryStartupGate = deferred()
  const recoveryBusyGate = deferred()
  const receiptTurnGate = deferred()
  const nativeChildren: PanelMember[] = []
  let providerServer: ReturnType<typeof createServer> | undefined
  let nativeProcess: ChildProcess | undefined
  let stage = "isolated workspace setup"

  const gates = [
    ...panelGates,
    parentBusyGate,
    parentEvaluationGate,
    cancelImmediateGate,
    cancelBusyGate,
    pendingStartupGate,
    rawStartupGate,
    deliveryStartupGate, recoveryStartupGate, recoveryBusyGate, receiptTurnGate,
  ]

  try {
    await Promise.all([
      mkdir(projectDirectory, { recursive: true }),
      mkdir(home, { recursive: true }),
      mkdir(temporary, { recursive: true }),
      mkdir(xdgConfig, { recursive: true }),
      mkdir(xdgData, { recursive: true }),
      mkdir(xdgCache, { recursive: true }),
      mkdir(xdgState, { recursive: true }),
      mkdir(pluginDirectory, { recursive: true }),
      mkdir(join(workspace, "managed-config")),
    ])
    const protectedEditPath = join(projectDirectory, "protected-edit.txt")
    await writeFile(join(projectDirectory, "private.txt"), "private probe data\n", "utf8")
    await writeFile(protectedEditPath, "before\n", "utf8")
    await writeFile(join(pluginDirectory, "runtime-probe.js"), nativePluginSource(providerURL), "utf8")

    providerServer = createProviderServer({
      projectDirectory,
      providerURL,
      panelGates,
      parentBusyGate,
      parentEvaluationGate,
      cancelImmediateGate,
      cancelBusyGate,
      pendingStartupGate,
      rawStartupGate,
      deliveryStartupGate, recoveryStartupGate, recoveryBusyGate, receiptTurnGate,
      observations: providerObservations,
    })
    await new Promise<void>((resolvePromise, reject) => {
      providerServer?.once("error", reject)
      providerServer?.listen(providerPort, "127.0.0.1", () => resolvePromise())
    })

    stage = "isolated project configuration"
    const config = {
      $schema: "https://opencode.ai/config.json",
      model: "probe/fake-model",
      small_model: "probe/fake-model",
      autoupdate: false,
      share: "disabled",
      enabled_providers: ["probe"],
      provider: {
        probe: {
          npm: "@ai-sdk/openai-compatible",
          name: "isolated local probe provider",
          options: { baseURL: `${providerURL}/v1`, apiKey: "not-a-real-credential" },
          models: {
            "fake-model": {
              name: "isolated deterministic fake model",
              limit: { context: 32_000, output: 2_048 },
            },
          },
        },
      },
      agent: {
        build: {
          mode: "primary",
          model: "probe/fake-model",
          permission: {
            "*": "allow",
            read: { "*": "allow", "*private.txt": "deny" },
            webfetch: "ask",
          },
        },
        "probe-participant": {
          mode: "subagent",
          model: "probe/fake-model",
          permission: { "*": "allow" },
        },
        ...Object.fromEntries(["proof-one", "proof-two", "proof-three"].map((name) => [name, {
          mode: "subagent", model: "probe/fake-model", permission: { "*": "allow" },
        }])),
      },
    }
    await writeFile(projectConfigPath, JSON.stringify(config, null, 2), "utf8")
    const environment = isolatedEnvironment({
      home,
      xdgConfig,
      xdgData,
      xdgCache,
      xdgState,
      temporary,
      events: eventsPath,
    })
    if (await realpath(workspace) !== resolve(workspace)) throw new Error("Disposable native workspace must not be a symlink")
    for (const path of [home, temporary, xdgConfig, xdgData, xdgCache, xdgState, projectDirectory, dirname(pluginDirectory)]) {
      if (!(await realpath(path)).startsWith(`${workspace}/`)) throw new Error("Native fixture path escaped its disposable root")
    }
    workspacePathsVerified = true
    const binary = environment.OPENCODE_BIN ?? "opencode"
    execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory, env: environment, timeout: 10_000 })
    stage = "native runtime version query"
    version = execFileSync(binary, ["--version"], {
      cwd: projectDirectory,
      env: environment,
      encoding: "utf8",
      timeout: 10_000,
    }).trim()
    if (version !== "1.18.35") throw new Error(`Unreviewed native runtime version: ${version}`)

    stage = "native server startup"
    nativeProcess = await startServer(binary, projectDirectory, serverPort, environment, nativeDiagnostics)
    nativeProcesses.push(nativeProcess)
    client = trackedClient(baseURL, nativeAbortRequests, apiBoundaries, async (request) => { await beforeNativeRequest?.(request) })
    const initialClient = client
    stage = "native project identity"
    const project = await waitFor("native project identity API readiness", async () => {
      try {
        return getData<{
          id: string
          worktree: string
        }>(await initialClient.project.current({ query: { directory: projectDirectory } }), "project identity")
      } catch {
        return undefined
      }
    }, 35_000)
    if (resolve(project.worktree) !== resolve(projectDirectory)) {
      throw new Error("Native project worktree escaped its disposable project")
    }
    const nativePaths = getData<RecordValue>(await client.path.get({ query: { directory: projectDirectory } }), "native paths")
    for (const key of ["home", "state", "config", "directory", "worktree"]) {
      if (typeof nativePaths[key] !== "string" || !resolve(nativePaths[key]).startsWith(`${workspace}/`)) {
        throw new Error(`Native ${key} path escaped its isolated workspace`)
      }
    }
    statusEvidence.push({ label: "native-isolated-paths", paths: nativePaths })
    stage = "native owner session creation"
    const rootRequest = {
      query: { directory: projectDirectory },
      body: {
        title: "Automatic debate native boundary probe",
        agent: "build",
        model: { providerID: "probe", id: "fake-model" },
        permission: PARENT_RULES,
        metadata: { unrelatedProbeMetadata: { retained: true } },
      },
    }
    const rootSession = getData<RecordValue>(await client.session.create(rootRequest), "owner session creation")
    if (typeof rootSession.id !== "string" || typeof rootSession.projectID !== "string") {
      throw new Error("Native owner session did not expose session and project identities")
    }
    if (project.id !== rootSession.projectID) throw new Error("Native owner session changed project identity")
    const pluginInput = {
      client,
      project,
      directory: projectDirectory,
      worktree: project.worktree,
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL(baseURL),
      $: undefined,
    } as unknown as PluginInput
    const runtime = createRuntime(pluginInput)
    const owner: Owner = {
      sessionID: rootSession.id,
      agent: "build",
      directory: projectDirectory,
    }

    stage = "native plugin event observation"
    const observedCreation = await waitFor("native plugin startup evidence", async () => {
      const events = await readEvents(eventsPath)
      return events.some((event) => event.type === "runtime-probe-plugin-loaded")
        ? true
        : undefined
    })
    void observedCreation

    stage = "native recovery-first checkpoint bootstrap"
    const bootstrap = { version: 1 as const, discussions: [], outbox: [] }
    const unrelatedRequest = { query: { directory: projectDirectory }, body: { parentID: owner.sessionID,
      title: "Completed manual specialist research", agent: "probe-participant",
      model: { providerID: "probe", id: "fake-model" }, permission: PARENT_RULES,
      metadata: { unrelatedPlugin: { retained: true } } } }
    const unrelatedChild = getData<RecordValue>(await client.session.create(unrelatedRequest), "ordinary pre-existing child creation")
    if (typeof unrelatedChild.id !== "string") throw new Error("Ordinary child identity missing")
    const unrelatedBefore = JSON.stringify(unrelatedChild)
    const absent = await runtime.load(owner)
    const bootstrapChildrenBefore = getData<RecordValue[]>(await client.session.children({ path: { id: owner.sessionID },
      query: { directory: projectDirectory } }), "bootstrap children before save")
    const bootstrapHistoryBefore = await nativeMessages(client, projectDirectory, owner.sessionID)
    await runtime.save(owner, bootstrap) // Explicit fixture initialisation before automatic participant creation.
    const bootstrapped = await runtime.load(owner)
    const checkpointBootstrapLifecycleWorked = absent === undefined && bootstrapChildrenBefore.length === 1
      && bootstrapHistoryBefore.length === 0 && (await nativeMessages(client, projectDirectory, owner.sessionID)).length === 0
      && JSON.stringify(bootstrapped) === JSON.stringify(bootstrap)
    const unrelatedAfter = getData<RecordValue>(await client.session.get({ path: { id: unrelatedChild.id },
      query: { directory: projectDirectory } }), "ordinary child after bootstrap")
    const unrelatedExistingChildAllowsBootstrap = checkpointBootstrapLifecycleWorked
      && bootstrapChildrenBefore[0]?.id === unrelatedChild.id && unrelatedBefore === JSON.stringify(unrelatedAfter)
      && !providerObservations.requests.some((request) => request.sessionID === unrelatedChild.id)
    persistenceEvidence.push({ phase: "recovery-first-bootstrap", noRecoveredState: absent === undefined,
      createdChildrenBeforeSave: bootstrapChildrenBefore.length, ownerHistoryBeforeSave: bootstrapHistoryBefore.length,
      explicitInitialSaveLoaded: JSON.stringify(bootstrapped) === JSON.stringify(bootstrap), unrelatedChildID: unrelatedChild.id,
      unrelatedChildUnchanged: unrelatedBefore === JSON.stringify(unrelatedAfter) })

    stage = "effective owner permission retrieval"
    const inherited = await runtime.restrictions(owner)
    if (!inherited.some((rule) => rule.permission === "read" && rule.action === "deny")
      || !inherited.some((rule) => rule.permission === "webfetch" && rule.action === "ask")) {
      throw new Error("Native owner agent and session restrictions were not exposed as effective rules")
    }

    const participant = {
      agent: "probe-participant",
      description: "temporary deterministic runtime probe participant",
      model: "probe/fake-model",
    }
    stage = "genuine native parent launch tool"
    const launchMessageID = `msg_${randomUUID()}`
    assertNoError(await client.session.promptAsync(promptAsyncRequest(owner.sessionID, projectDirectory,
      launchMessageID, owner.agent, "AUTO_DEBATE_RUNTIME_LAUNCH: invoke the isolated launch tool.")), "native launch dispatch")
    const dispatches = await waitFor("native launch tool participant dispatch", async () => {
      const events = await readEvents(eventsPath)
      assertPendingNativePrompts(events, [owner.sessionID])
      const launched = events.filter((event) => event.type === "runtime-probe-participant-dispatched")
      return launched.length === 3 ? launched.toSorted((a, b) => (a.index ?? -1) - (b.index ?? -1)) : undefined
    })
    for (const event of dispatches) {
      if (!event.sessionID) throw new Error("Native parent tool did not identify its participant")
      nativeChildren.push({ participant, sessionID: event.sessionID, runtimeAgent: participant.agent })
    }
    const panelIDs = new Set(nativeChildren.map((member) => member.sessionID))

    stage = "native participant permission assertions"

    const askEventsSeen = new Set<string>()
    const askResponsesSent = new Set<string>()
    let parentAskWasObserved = false
    let parentAskWasAutoApproved = false
    await waitFor("native inherited-ask decisions and child provider barriers", async () => {
      const events = await readEvents(eventsPath)
      assertPendingNativePrompts(events, [...panelIDs])
      const asks = events.filter((event) => (event.type === "permission.asked" || event.type === "permission.updated")
        && nativeChildren.some((member) => member.sessionID === event.sessionID))
      for (const ask of asks) {
        if (ask.permission !== "webfetch") continue
        parentAskWasObserved = true
        if (!ask.sessionID || !ask.permissionID) continue
        const key = `${ask.sessionID}:${ask.permissionID}`
        if (askResponsesSent.has(key)) continue
        askEventsSeen.add(key)
        const panelIndex = nativeChildren.findIndex((member) => member.sessionID === ask.sessionID)
        if (panelIndex >= 0) providerObservations.explicitlyApprovedPanels.add(panelIndex)
        const reply = await client.postSessionIdPermissionsPermissionId({
          path: { id: ask.sessionID, permissionID: ask.permissionID },
          query: { directory: projectDirectory },
          body: { response: "once" },
        })
        assertNoError(reply, "native explicit once permission reply")
        askResponsesSent.add(key)
      }
      if (providerObservations.autoApprovedPanelHits.size > 0) parentAskWasAutoApproved = true
      return providerObservations.pendingPanels.size === 3 && askResponsesSent.size === 3
        && [...askResponsesSent].every((key) => events.some((event) => event.type === "permission.replied"
          && `${event.sessionID}:${event.requestID}` === key && event.reply === "once"))
        ? true
        : undefined
    })

    const threeChildrenWereBusyTogether = await observeBusyTogether([...panelIDs], async () => {
      assertPendingNativePrompts(await readEvents(eventsPath), [...panelIDs])
      return providerObservations.pendingPanels.size === 3
    }, async () => {
      const statuses = getData<unknown>(await client.session.status({ query: { directory: projectDirectory } }), "shared busy snapshot")
      statusEvidence.push({ label: "held-three-child-barrier", time: Date.now(), statuses })
      return statuses
    })
    const parentLaunchMessages = await nativeMessages(client, projectDirectory, owner.sessionID)
    const launchEvents = await readEvents(eventsPath)
    const parentToolReturnedBeforeChildrenFinished = nativeParentReturnedBeforeChildren(
      parentLaunchMessages, launchEvents, [...panelIDs], owner.sessionID,
    )

    stage = "native participant tool message collection"
    const gatheredChildMessages = await Promise.all(nativeChildren.map((member) => nativeMessages(
      client,
      projectDirectory,
      member.sessionID,
    )))
    const observedNativeToolCalls = [...new Set(gatheredChildMessages.flatMap(toolParts).map(({ tool }) => tool))]
    const deniedReadWasObserved = gatheredChildMessages.every((messages) => toolParts(messages)
      .some((part) => part.tool === "read" && part.state === "error" && part.error?.includes("rule which prevents")))
    const immutableToolsWereHidden = nativeChildren.every((member) => {
      const offered = providerObservations.requests.find((request) => request.sessionID === member.sessionID)
      return offered !== undefined && ["edit", "task", "bash", "skill", "question", "auto_debate_probe_launch"]
        .every((name) => !offered.tools.includes(name))
    }) && gatheredChildMessages.every((messages) => ["edit", "task"].every((name) => toolParts(messages)
      .some((part) => part.callID?.startsWith(`call_${name}`) && part.state === "error")))
    messageEvidence.push(...nativeChildren.map((member, index) => ({ sessionID: member.sessionID,
      label: "permission-attempts", tools: toolParts(gatheredChildMessages[index]) })))

    for (const gate of panelGates) gate.release()
    await waitFor("native adapter final participant results", async () => {
      const events = await readEvents(eventsPath)
      assertPendingNativePrompts(events, [...panelIDs])
      return [...panelIDs].every((id) => events.some((event) => event.type === "runtime-probe-child-settled"
        && event.sessionID === id && event.ok === true && event.finalMatched === true)) ? true : undefined
    })

    const toolAfterEvents = await readEvents(eventsPath)
    const deniedReadExecuted = toolAfterEvents.some((event) => event.type === "tool.execute.after"
      && event.tool === "read" && event.sessionID !== undefined && panelIDs.has(event.sessionID))
    const fileAfter = await readFile(protectedEditPath, "utf8")
    const deniedEditExecuted = fileAfter !== "before\n"
      || toolAfterEvents.some((event) => event.type === "tool.execute.after"
        && event.tool === "edit" && event.sessionID !== undefined && panelIDs.has(event.sessionID))
    const participantChildren = await Promise.all(nativeChildren.map(async (member) => {
      const children = getData<unknown>(await client.session.children({
        path: { id: member.sessionID },
        query: { directory: projectDirectory },
      }), "participant child-session listing")
      return Array.isArray(children) ? children.length : -1
    }))
    const participantSpawnedChild = participantChildren.some((count) => count !== 0)
      || (await readEvents(eventsPath)).some((event) => event.type === "session.created"
        && event.parentID !== undefined && panelIDs.has(event.parentID))

    stage = "busy owner and idle-aware delivery"
    const rootBusyMessageID = `msg_${randomUUID()}`
    const busyDispatch = await client.session.promptAsync(promptAsyncRequest(
      owner.sessionID,
      projectDirectory,
      rootBusyMessageID,
      owner.agent,
      "AUTO_DEBATE_RUNTIME_PARENT_BUSY: hold this native parent run at the local fake provider barrier.",
    ) as never)
    assertNoError(busyDispatch, "busy parent async dispatch")
    const observedParentBusy = await waitFor("native owner session busy state", async () => {
      const status = await nativeStatus(client, projectDirectory, owner.sessionID)
      return status === "busy" ? status : undefined
    })
    const parentWasBusyBeforeBecomingIdle = observedParentBusy === "busy"
    await waitFor("busy-owner provider barrier before checkpoint saves", async () =>
      providerObservations.requests.some((request) => request.marker === "parent-busy") ? true : undefined)
    stage = "native append-only checkpoints while owner is busy"
    const state = { version: 1 as const, override: false, discussions: [{
      id: "checkpoint-off", owner, config: { enabled: false, maxRounds: 3, persistTranscripts: false },
      brief: { question: "Fixture checkpoint", objective: "Recover state", facts: [], assumptions: [], constraints: [],
        alternatives: [], uncertainty: "test", neededOutcome: "durable native state" },
      panel: [], status: "paused" as const, generation: 0, cycle: 1, results: [], evaluations: [], pendingTurns: [], followups: [],
    }], outbox: [] }
    const ownerContext = async () => (await nativeMessages(client, projectDirectory, owner.sessionID)).map((message) => ({
      id: isRecord(message.info) ? message.info.id : undefined,
      role: isRecord(message.info) ? message.info.role : undefined,
      text: Array.isArray(message.parts) ? message.parts.filter(isRecord).filter((part) => part.type === "text").map((part) => part.text) : [],
    }))
    const ownerHistoryBeforeSave = await ownerContext()
    const filesBeforeSave = (await readdir(projectDirectory, { recursive: true })).sort()
    let outsiderWrites = 0
    beforeNativeRequest = async (request) => {
      if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/message")) return
      const body: unknown = await request.clone().json()
      if (!isRecord(body) || body.noReply !== true) return
      const root = getData<RecordValue>(await initialClient.session.get({ path: { id: owner.sessionID },
        query: { directory: projectDirectory } }), "outsider owner metadata read")
      const update: MetadataUpdate = { path: { id: owner.sessionID }, query: { directory: projectDirectory }, body: {
        metadata: { ...(isRecord(root.metadata) ? root.metadata : {}), outsiderCheckpointWrite: ++outsiderWrites },
      } }
      getData(await initialClient.session.update(update), "outsider owner metadata write")
    }
    await Promise.all([runtime.save(owner, { ...state, override: true }), runtime.save(owner, state)])
    beforeNativeRequest = undefined
    const storesFor = async (sessionOwner: Owner) => {
      const children = getData<RecordValue[]>(await client.session.children({ path: { id: sessionOwner.sessionID },
        query: { directory: projectDirectory } }), "checkpoint child discovery")
      return children.filter((child) => isRecord(child.metadata) && Object.hasOwn(child.metadata, "opencode-debate-checkpoint-store"))
    }
    const storageChildren = await storesFor(owner)
    if (storageChildren.length !== 1 || typeof storageChildren[0].id !== "string") throw new Error("Native checkpoint store was ambiguous/missing")
    const storageID = storageChildren[0].id
    const allStorageIDs = new Set<string>([storageID])
    let recordsBeforeRestart = await nativeMessages(client, projectDirectory, storageID)
    const checkpointPayload = (message: RecordValue): RecordValue => {
      if (!Array.isArray(message.parts) || !isRecord(message.parts[0]) || typeof message.parts[0].text !== "string") {
        throw new Error("Native checkpoint payload missing")
      }
      const text = message.parts[0].text
      const wrapper = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { payload: string }
      return JSON.parse(wrapper.payload) as RecordValue
    }
    const logicalRecords = recordsBeforeRestart.toSorted((a, b) => Number(checkpointPayload(a).revision) - Number(checkpointPayload(b).revision))
    const firstCheckpoint = checkpointPayload(logicalRecords[1])
    const secondCheckpoint = checkpointPayload(logicalRecords[2])
    const sameManagerCheckpointWritesSerialized = firstCheckpoint.revision === 2 && secondCheckpoint.revision === 3
      && firstCheckpoint.previous === (isRecord(logicalRecords[0].info) ? logicalRecords[0].info.id : undefined)
      && secondCheckpoint.previous === (isRecord(logicalRecords[1].info) ? logicalRecords[1].info.id : undefined)
      && isRecord(firstCheckpoint.state) && firstCheckpoint.state.override === true
      && isRecord(secondCheckpoint.state) && secondCheckpoint.state.override === false
    const checkpointSavesDidNotChangeOwnerHistory = JSON.stringify(ownerHistoryBeforeSave) === JSON.stringify(await ownerContext())
    const checkpointSavesPreservedBusyOwner = await nativeStatus(client, projectDirectory, owner.sessionID) === "busy"
    const transcriptOffCreatedNoFiles = JSON.stringify(filesBeforeSave) === JSON.stringify((await readdir(projectDirectory, { recursive: true })).sort())
    const concurrentOwnerMetadata = getData<RecordValue>(await client.session.get({ path: { id: owner.sessionID },
      query: { directory: projectDirectory } }), "concurrent owner metadata observation").metadata
    const outsiderDuringSavesPreserved = outsiderWrites === 2 && isRecord(concurrentOwnerMetadata)
      && concurrentOwnerMetadata.outsiderCheckpointWrite === 2 && !Object.hasOwn(concurrentOwnerMetadata, "opencode-debate")
    persistenceEvidence.push({ phase: "busy-owner-two-concurrent-checkpoint-saves", storageID, records: recordsBeforeRestart.map((message) => {
      const payload = checkpointPayload(message)
      return { id: isRecord(message.info) ? message.info.id : undefined, revision: payload.revision, previous: payload.previous }
    }), outsiderWrites, ownerHistoryUnchanged: checkpointSavesDidNotChangeOwnerHistory,
      ownerStayedBusy: checkpointSavesPreservedBusyOwner, projectFileSetUnchanged: transcriptOffCreatedNoFiles })
    stage = "busy owner and idle-aware delivery"
    parentBusyGate.release()
    const observedParentIdle = await waitFor("native owner session idle state after busy run", async () => {
      const status = await nativeStatus(client, projectDirectory, owner.sessionID)
      return status === "idle" ? status : undefined
    })
    const parentBecameIdleBeforeDelivery = observedParentIdle === "idle"

    const deliveryID = `outbox-${randomUUID()}`
    const notificationState: ConversationState = structuredClone(state)
    notificationState.discussions[0].results.push({ cycle: 1, rounds: 2, status: "complete", reason: "unanimous-stop",
      turns: [], failures: [], consensus: false })
    notificationState.outbox.push({ id: deliveryID, discussionID: "checkpoint-off", cycle: 1, state: "pending" })
    await runtime.save(owner, notificationState)
    const delivered = await runtime.deliver(owner, { id: deliveryID, outboxIDs: [deliveryID],
      text: "AUTO_DEBATE_RUNTIME_OWNER_EVALUATE: evaluate the completed panel result now." })
    if (delivered.state !== "persisted") throw new Error(`Native notification was not persisted: ${delivered.state}`)
    const deliveryMessageID = delivered.messageID
    if (!deliveryMessageID.startsWith("msg_")) throw new Error("Native delivery did not return a persisted message ID")
    await waitFor("native owner evaluation provider barrier", async () =>
      providerObservations.requests.some((request) => request.marker === "parent-evaluation")
        ? true
        : undefined)
    const evaluationBusy = await nativeStatus(client, projectDirectory, owner.sessionID)
    const deliveredMessages = await nativeMessages(client, projectDirectory, owner.sessionID)
    const deliveredUser = deliveredMessages.find((message) => isRecord(message.info)
      && message.info.id === deliveryMessageID
      && message.info.role === "user")
    parentEvaluationGate.release()
    await waitFor("native owner evaluation after delivery", async () => {
      const status = await nativeStatus(client, projectDirectory, owner.sessionID)
      if (status !== "idle") return undefined
      const messages = await nativeMessages(client, projectDirectory, owner.sessionID)
      const assistant = assistantForUser(messages, deliveryMessageID)
      return assistant ? { messages, assistant } : undefined
    })
    const evaluationMessages = await nativeMessages(client, projectDirectory, owner.sessionID)
    const evaluatedAssistant = assistantForUser(evaluationMessages, deliveryMessageID)
    const resultEvaluatedAfterBusyParentBecameIdle = evaluationBusy === "busy"
      && deliveredUser !== undefined
      && parentWasBusyBeforeBecomingIdle
      && parentBecameIdleBeforeDelivery
      && evaluatedAssistant !== undefined
      && Array.isArray(evaluatedAssistant.parts) && evaluatedAssistant.parts.some((part) => isRecord(part)
        && part.type === "text" && typeof part.text === "string" && part.text.includes("native probe parent-evaluation"))
      && deliveredMessages.some((message) => isRecord(message.info)
        && message.info.role === "user" && message.info.id === rootBusyMessageID)
    const parentWasAbortedForDelivery = nativeAbortRequests.some((request) => request.sessionID === owner.sessionID)

    stage = "receipt-backed native paused panel and writer restart"
    const createProofOwner = async (title: string) => {
      const root = getData<RecordValue>(await client.session.create({ ...rootRequest, body: { ...rootRequest.body, title } }), "proof owner creation")
      if (typeof root.id !== "string") throw new Error("Proof owner identity missing")
      return { sessionID: root.id, agent: "build", directory: projectDirectory } as Owner
    }
    const proofOwner = await createProofOwner("Receipt-backed complete paused native cycle")
    const proofRuntime = createRuntime(pluginInput)
    const proofDiscussion: Discussion = { ...structuredClone(state.discussions[0]), id: "proof-discussion", owner: proofOwner,
      status: "running", panel: [], results: [], evaluations: [], followups: [] }
    const proofState: ConversationState = { version: 1, override: true, discussions: [proofDiscussion], outbox: [] }
    await proofRuntime.load(proofOwner)
    await proofRuntime.save(proofOwner, proofState)
    for (const agent of ["proof-one", "proof-two", "proof-three"]) proofDiscussion.panel.push(await proofRuntime.createParticipant(proofOwner,
      { agent, description: "original receipt-backed panel member", model: "probe/fake-model" }, await proofRuntime.restrictions(proofOwner)))
    await proofRuntime.save(proofOwner, proofState)
    const proofIDs = proofDiscussion.panel.map((member) => member.sessionID)
    const proofStore = (await storesFor(proofOwner))[0]
    if (typeof proofStore.id !== "string") throw new Error("Proof store missing")
    allStorageIDs.add(proofStore.id)
    const proofOwnerHistory = JSON.stringify(await nativeMessages(client, projectDirectory, proofOwner.sessionID))
    const proofOwnerMetadata = JSON.stringify(getData<RecordValue>(await client.session.get({ path: { id: proofOwner.sessionID },
      query: { directory: projectDirectory } }), "proof owner metadata").metadata)
    const proofFileSet = JSON.stringify((await readdir(projectDirectory, { recursive: true })).sort())
    const heldTurn = proofRuntime.prompt(proofDiscussion.panel[0], "AUTO_DEBATE_RECONCILIATION_HELD: independent round 1")
    await waitFor("receipt-backed participant native provider barrier", async () => providerObservations.requests.some((request) =>
      request.marker === "receipt-held" && request.sessionID === proofIDs[0]) ? true : undefined)
    await Promise.all([proofRuntime.save(proofOwner, { ...proofState, override: false }), proofRuntime.save(proofOwner, proofState)])
    receiptTurnGate.release()
    const firstAnswer = await heldTurn
    proofDiscussion.pendingTurns.push({ participant: proofDiscussion.panel[0].participant.agent, cycle: 1, round: 1, text: firstAnswer })
    for (const member of proofDiscussion.panel.slice(1)) proofDiscussion.pendingTurns.push({ participant: member.participant.agent,
      cycle: 1, round: 1, text: await proofRuntime.prompt(member, "independent round 1") })
    for (const member of proofDiscussion.panel) proofDiscussion.pendingTurns.push({ participant: member.participant.agent,
      cycle: 1, round: 2, text: await proofRuntime.prompt(member, "dependent round 2 with peer findings"), stop: true })
    const pauseProof = async (adapter: ReturnType<typeof createRuntime>, current: ConversationState) => {
      const discussion = current.discussions[0]
      discussion.status = "paused"
      discussion.results.push({ cycle: discussion.cycle, rounds: discussion.cycle === 1 ? 2 : 1, status: "complete",
        reason: "unanimous-stop", turns: [...discussion.pendingTurns], failures: [], consensus: false })
      discussion.pendingTurns = []
      discussion.evaluations.push({ cycle: discussion.cycle, conclusion: "Explicit follow-up needed", caveats: [],
        rationale: "Changed context", next: "continue" })
      current.override = false
      await adapter.save(proofOwner, current)
    }
    await pauseProof(proofRuntime, proofState)
    const continueProof = async (adapter: ReturnType<typeof createRuntime>, current: ConversationState, feedback: string) => {
      const discussion = current.discussions[0]
      const requestsBefore = providerObservations.requests.length
      const inspections = await Promise.all(discussion.panel.map((member) => adapter.reconcileParticipant(proofOwner, member)))
      if (!inspections.every((inspection) => inspection.state === "exhausted" && inspection.canContinue)
        || providerObservations.requests.length !== requestsBefore || current.override !== false) throw new Error("Paused native panel was not safely inspectable while off")
      discussion.status = "running"
      discussion.cycle++
      discussion.followups.push({ cycle: discussion.cycle, feedback })
      await adapter.save(proofOwner, current)
      const answers = await Promise.all(discussion.panel.map((member) => adapter.prompt(member, `dependent follow-up with original brief and peer history: ${feedback}`)))
      discussion.pendingTurns.push(...answers.map((text, index) => ({ participant: discussion.panel[index].participant.agent,
        cycle: discussion.cycle, round: 1, text, stop: true })))
      const histories = await Promise.all(discussion.panel.map((member) => nativeMessages(client, projectDirectory, member.sessionID)))
      const nativeUsers = histories.map((history) => history.filter((message) => isRecord(message.info) && message.info.role === "user"))
      const sameIDs = JSON.stringify(discussion.panel.map((member) => member.sessionID)) === JSON.stringify(proofIDs)
      const followed = nativeUsers.every((history) => Array.isArray(history.at(-1)?.parts) && (history.at(-1)!.parts as RecordValue[])
        .some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes(feedback)))
      await pauseProof(adapter, current)
      return sameIDs && followed && answers.length === 3 && nativeUsers.every((history) => history.length === discussion.cycle + 1)
    }
    const writerRestart = createRuntime(pluginInput)
    const writerState = (await writerRestart.load(proofOwner))!
    const pausedPanelContinuedAfterWriterRestart = await continueProof(writerRestart, writerState, "writer restart changed context")
    const proofMessages = await nativeMessages(client, projectDirectory, proofStore.id)
    const proofs = proofMessages.toSorted((a, b) => Number(checkpointPayload(a).revision) - Number(checkpointPayload(b).revision))
      .map((message) => (checkpointPayload(message).runtimeProof as { entries: unknown[] }).entries)
    const receiptPrefixesSurvivedManagerSaves = proofs.length > 10 && proofs.every((entries, index) => index === 0
      || JSON.stringify(entries.slice(0, proofs[index - 1].length)) === JSON.stringify(proofs[index - 1]))
      && proofs.at(-1)!.filter((entry) => isRecord(entry) && entry.kind === "participant-start-closed").length === 9
    const receiptWritesPreservedOwnerPrivacy = proofOwnerHistory === JSON.stringify(await nativeMessages(client, projectDirectory, proofOwner.sessionID))
      && proofOwnerMetadata === JSON.stringify(getData<RecordValue>(await client.session.get({ path: { id: proofOwner.sessionID },
        query: { directory: projectDirectory } }), "proof owner metadata after receipts").metadata)
      && proofFileSet === JSON.stringify((await readdir(projectDirectory, { recursive: true })).sort())
    persistenceEvidence.push({ phase: "receipt-backed-paused-writer-restart", owner: proofOwner.sessionID, store: proofStore.id,
      originalIDs: proofIDs, continued: pausedPanelContinuedAfterWriterRestart, receiptPrefixesSurvivedManagerSaves, receiptWritesPreservedOwnerPrivacy,
      records: proofs.length, closedStarts: 9, automaticModeOff: writerState.override === false })

    stage = "held native notification fork with lost response and writer restart"
    const notifyOwner = await createProofOwner("Held async delivery reconciliation")
    const notifyRuntime = createRuntime(pluginInput)
    const notifyState: ConversationState = { version: 1, discussions: [{ ...structuredClone(proofDiscussion), id: "notification-discussion",
      owner: notifyOwner, panel: [], pendingTurns: [], cycle: 1, results: [{ cycle: 1, rounds: 2, status: "complete", reason: "unanimous-stop",
        turns: [], failures: [], consensus: false }], evaluations: [], followups: [], status: "awaiting-evaluation" }], outbox: [
      { id: "notification-one", discussionID: "notification-discussion", cycle: 1, state: "pending" },
      { id: "notification-two", discussionID: "notification-discussion", cycle: 1, state: "pending" },
    ] }
    await notifyRuntime.load(notifyOwner)
    await notifyRuntime.save(notifyOwner, notifyState)
    allStorageIDs.add(String((await storesFor(notifyOwner))[0].id))
    const batch = { id: "held-batch", outboxIDs: ["notification-one", "notification-two"],
      text: "AUTO_DEBATE_RECONCILIATION_DELIVERY: evaluate both explicit saved result IDs" }
    const asyncPrompt = initialClient.session.promptAsync.bind(initialClient.session)
    let actualSends = 0
    initialClient.session.promptAsync = (async (request: Parameters<NativeClient["session"]["promptAsync"]>[0]) => {
      if (request?.path?.id !== notifyOwner.sessionID) return asyncPrompt(request)
      actualSends++
      assertNoError(await asyncPrompt(request), "held native delivery acceptance")
      throw new Error("Deliberately lost native async acceptance response")
    }) as NativeClient["session"]["promptAsync"]
    const ambiguous = await notifyRuntime.deliver(notifyOwner, batch)
    const nativeHeld = providerObservations.startups.find((entry) => entry.kind === "delivery" && entry.sessionID === notifyOwner.sessionID)
    const noMessage = (await nativeMessages(client, projectDirectory, notifyOwner.sessionID)).length === 0
    const deliveryRestart = createRuntime(pluginInput)
    await deliveryRestart.load(notifyOwner)
    const beforeRelease = await deliveryRestart.reconcileDeliveries(notifyOwner)
    const duplicates = await Promise.all([deliveryRestart.deliver(notifyOwner, batch), deliveryRestart.deliver(notifyOwner, batch)])
    const uncertainHeld = ambiguous.state === "uncertain" && beforeRelease[0]?.state === "uncertain"
      && duplicates.every((observation) => observation.state === "uncertain") && noMessage && nativeHeld?.released === undefined
      && await nativeStatus(client, projectDirectory, notifyOwner.sessionID) === "idle" && actualSends === 1
    deliveryStartupGate.release()
    await waitFor("original held native notification fully persisted", async () => (await nativeMessages(client, projectDirectory, notifyOwner.sessionID))
      .some((message) => isRecord(message.info) && message.info.id === ambiguous.messageID && Array.isArray(message.parts) && message.parts.length === 1) ? true : undefined)
    const reconciledDelivery = await deliveryRestart.reconcileDeliveries(notifyOwner)
    await waitFor("native main agent evaluated original reconciled notification", async () => {
      const history = await nativeMessages(client, projectDirectory, notifyOwner.sessionID)
      const assistant = assistantForUser(history, ambiguous.messageID)
      return assistant && isRecord(assistant.info) && isRecord(assistant.info.time) && typeof assistant.info.time.completed === "number" ? true : undefined
    })
    const notifyHistory = await nativeMessages(client, projectDirectory, notifyOwner.sessionID)
    const heldDeliveryForkReconciledWithoutRedispatch = uncertainHeld && reconciledDelivery[0]?.state === "persisted"
      && actualSends === 1 && notifyHistory.filter((message) => isRecord(message.info) && message.info.role === "user").length === 1
      && !nativeAbortRequests.some((request) => request.sessionID === notifyOwner.sessionID)
    const lostDeliveryResponseReconciledAfterWriterRestart = heldDeliveryForkReconciledWithoutRedispatch
      && JSON.stringify(reconciledDelivery[0].delivery) === JSON.stringify(batch)
    initialClient.session.promptAsync = asyncPrompt
    persistenceEvidence.push({ phase: "held-fork-lost-response-restart", owner: notifyOwner.sessionID, messageID: ambiguous.messageID,
      uncertainHeld, heldDeliveryForkReconciledWithoutRedispatch, actualSends, lostDeliveryResponseReconciledAfterWriterRestart })

    stage = "native checkpoint persistence and restart"
    const stateBeforeRestart = await runtime.load(owner)
    if (JSON.stringify(stateBeforeRestart) !== JSON.stringify(notificationState)) throw new Error("Native checkpoints did not load the latest state before restart")
    recordsBeforeRestart = await nativeMessages(client, projectDirectory, storageID)
    const unrelatedBeforeRestart = getData<RecordValue>(await client.session.get({
      path: { id: owner.sessionID },
      query: { directory: projectDirectory },
    }), "owner metadata before restart").metadata

    await stopServer(nativeProcess)
    nativeProcess = undefined
    nativeAbortRequests.length = 0
    nativeProcess = await startServer(binary, projectDirectory, serverPort, environment, nativeDiagnostics)
    nativeProcesses.push(nativeProcess)
    client = trackedClient(baseURL, nativeAbortRequests, apiBoundaries)
    const restartedInput = {
      client,
      project,
      directory: projectDirectory,
      worktree: project.worktree,
      experimental_workspace: { register: () => undefined },
      serverUrl: new URL(baseURL),
      $: undefined,
    } as unknown as PluginInput
    const restartedRuntime = createRuntime(restartedInput)
    const stateAfterRestart = await waitFor("persisted runtime state after server restart", async () => {
      try {
        const state = await restartedRuntime.load(owner)
        return state?.version === 1 ? state : undefined
      } catch {
        return undefined
      }
    }, 35_000)
    const sessionAfterRestart = await waitFor("native session metadata after server restart", async () => {
      try {
        return getData<RecordValue>(await client.session.get({
          path: { id: owner.sessionID },
          query: { directory: projectDirectory },
        }), "owner metadata after restart")
      } catch {
        return undefined
      }
    }, 35_000)
    const metadataAfterRestart = isRecord(sessionAfterRestart.metadata) ? sessionAfterRestart.metadata : {}
    const concurrentOwnerMetadataPreserved = outsiderDuringSavesPreserved && metadataAfterRestart.outsiderCheckpointWrite === 2
    const checkpointStateSurvivedRestart = JSON.stringify(stateAfterRestart) === JSON.stringify(notificationState)
    const recordsAfterRestart = await nativeMessages(client, projectDirectory, storageID)
    const multipleCheckpointRecordsSurvivedRestart = recordsAfterRestart.length === 7
      && JSON.stringify(recordsAfterRestart.map(checkpointPayload).sort((a, b) => Number(a.revision) - Number(b.revision)))
        === JSON.stringify(recordsBeforeRestart.map(checkpointPayload).sort((a, b) => Number(a.revision) - Number(b.revision)))
    const metadataBeforeRecord = isRecord(unrelatedBeforeRestart) ? unrelatedBeforeRestart : {}
    const otherMetadataPreserved = isRecord(metadataAfterRestart.unrelatedProbeMetadata)
      && metadataAfterRestart.unrelatedProbeMetadata.retained === true
      && isRecord(metadataBeforeRecord.unrelatedProbeMetadata)
      && metadataBeforeRecord.unrelatedProbeMetadata.retained === true

    stage = "receipt-backed explicit continuation after native process restart"
    const nativeRestart = createRuntime(restartedInput)
    const nativeRestartState = (await nativeRestart.load(proofOwner))!
    const pausedPanelContinuedAfterNativeRestart = await continueProof(nativeRestart, nativeRestartState, "native restart changed context")
    persistenceEvidence.push({ phase: "receipt-backed-paused-native-restart", continued: pausedPanelContinuedAfterNativeRestart,
      originalIDs: proofIDs, automaticModeOff: nativeRestartState.override === false })

    stage = "unclosed native startup remains unconfirmed across writer recovery"
    const unknownOwner = await createProofOwner("Unclosed native startup recovery")
    const unknownRuntime = createRuntime(restartedInput)
    const unknownDiscussion: Discussion = { ...structuredClone(proofDiscussion), id: "unknown-start", owner: unknownOwner,
      panel: [], status: "running", results: [], evaluations: [], pendingTurns: [], followups: [], cycle: 1 }
    const unknownState: ConversationState = { version: 1, discussions: [unknownDiscussion], outbox: [] }
    await unknownRuntime.load(unknownOwner)
    await unknownRuntime.save(unknownOwner, unknownState)
    const unknownMember = await unknownRuntime.createParticipant(unknownOwner, { ...participant, agent: "proof-one" }, await unknownRuntime.restrictions(unknownOwner))
    unknownDiscussion.panel = [unknownMember]
    await unknownRuntime.save(unknownOwner, unknownState)
    allStorageIDs.add(String((await storesFor(unknownOwner))[0].id))
    const synchronousPrompt = client.session.prompt.bind(client.session)
    let remotePending: Promise<unknown> | undefined
    let unknownSends = 0
    client.session.prompt = (async (request: Parameters<NativeClient["session"]["prompt"]>[0]) => {
      if (request?.path?.id !== unknownMember.sessionID) return synchronousPrompt(request)
      unknownSends++
      remotePending = synchronousPrompt(request).catch(() => undefined)
      await waitFor("genuine native invisible startup before losing synchronous transport", async () => providerObservations.startups
        .find((entry) => entry.kind === "recovery" && entry.sessionID === unknownMember.sessionID))
      throw new Error("Deliberately lost synchronous transport with native startup still held")
    }) as NativeClient["session"]["prompt"]
    const startupRejected = await unknownRuntime.prompt(unknownMember, "AUTO_DEBATE_RECONCILIATION_PENDING: held native startup")
      .then(() => false, () => true)
    client.session.prompt = synchronousPrompt
    const unknownRestart = createRuntime(restartedInput)
    await unknownRestart.load(unknownOwner)
    const unknownInspection = await unknownRestart.reconcileParticipant(unknownOwner, unknownMember)
    const idleBeforeContainment = await nativeStatus(client, projectDirectory, unknownMember.sessionID) === "idle"
    const earlyUnconfirmed = await unknownRestart.abort(unknownMember).then(() => false, (error: unknown) => error instanceof Error && /unconfirmed|uncertain/i.test(error.message))
    recoveryStartupGate.release()
    await waitFor("late native busy event after invisible startup release", async () => providerObservations.requests.some((request) =>
      request.sessionID === unknownMember.sessionID && request.marker === "reconciliation-pending") ? true : undefined)
    const busyAfterRelease = await nativeStatus(client, projectDirectory, unknownMember.sessionID) === "busy"
    const lateUnconfirmed = await unknownRestart.abort(unknownMember).then(() => false, (error: unknown) => error instanceof Error && /unconfirmed|uncertain/i.test(error.message))
    recoveryBusyGate.release()
    await remotePending
    const noAdoption = await unknownRestart.prompt(unknownMember, "must not adopt even final/aborted history").then(() => false, () => true)
    const unknownStartupStayedUnconfirmedAfterRecovery = startupRejected && unknownInspection.state === "uncertain"
      && idleBeforeContainment && earlyUnconfirmed && busyAfterRelease && lateUnconfirmed && noAdoption && unknownSends === 1
    cancellationProof.push({ phase: "receipt-backed-unclosed-native-startup", sessionID: unknownMember.sessionID,
      idleBeforeContainment, earlyUnconfirmed, busyAfterRelease, lateUnconfirmed, noAdoption, unknownSends,
      abortCalls: nativeAbortRequests.filter((request) => request.sessionID === unknownMember.sessionID).length })

    stage = "native checkpoint failure-mode assertions"
    const negativeOwners: Owner[] = []
    const rejection = async (label: string, operation: Promise<unknown>) => operation.then(() => {
      persistenceEvidence.push({ phase: label, rejected: false }); return false
    }, (error: unknown) => {
      persistenceEvidence.push({ phase: label, rejected: true, error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }); return true
    })
    const negativeStore = async (label: string) => {
      const rootRequest = { query: { directory: projectDirectory }, body: {
        title: `Checkpoint negative probe ${label}`, agent: "build", model: { providerID: "probe", id: "fake-model" },
        permission: PARENT_RULES,
      } }
      const root = getData<RecordValue>(await client.session.create(rootRequest), "negative checkpoint owner creation")
      if (typeof root.id !== "string") throw new Error("Negative checkpoint owner identity missing")
      const caseOwner: Owner = { sessionID: root.id, agent: "build", directory: projectDirectory }
      negativeOwners.push(caseOwner)
      const caseRuntime = createRuntime(restartedInput)
      if (await caseRuntime.load(caseOwner) !== undefined) throw new Error("Negative owner was not a fresh bootstrap opportunity")
      await caseRuntime.save(caseOwner, { version: 1, discussions: [], outbox: [] })
      const child = (await storesFor(caseOwner))[0]
      if (!child || typeof child.id !== "string") throw new Error("Negative storage identity missing")
      allStorageIDs.add(child.id)
      const messages = await nativeMessages(client, projectDirectory, child.id)
      return { caseOwner, caseRuntime, child, message: messages[0] }
    }
    const appendDamage = async (testCase: Awaited<ReturnType<typeof negativeStore>>, suffix: string, text?: string) => {
      const info = testCase.message.info
      if (!isRecord(info) || typeof info.id !== "string" || typeof testCase.child.id !== "string" || !isRecord(testCase.child.model)) {
        throw new Error("Native damaged checkpoint context invalid")
      }
      const id = `${info.id}${suffix}`
      let damaged = text
      if (text === "valid-fork") {
        const payload = { ...checkpointPayload(testCase.message), messageID: id }
        const body = JSON.stringify(payload)
        damaged = "opencode-debate/checkpoint/v1\n" + JSON.stringify({ payload: body, digest: createHash("sha256").update(body).digest("hex") })
      }
      getData(await client.session.prompt({ path: { id: testCase.child.id }, query: { directory: projectDirectory }, body: {
        messageID: id, agent: String(testCase.child.agent), model: { providerID: String(testCase.child.model.providerID), modelID: String(testCase.child.model.id) },
        noReply: true, parts: damaged === undefined ? [] : [{ type: "text", text: damaged }],
      } }), "native checkpoint damage append")
    }
    const unmarkedCase = await negativeStore("unmarked-renamed-history")
    const unmarkedID = String(unmarkedCase.child.id)
    const unmarkedHistoryBefore = await nativeMessages(client, projectDirectory, unmarkedID)
    const unmarkedMetadata = { ...(isRecord(unmarkedCase.child.metadata) ? unmarkedCase.child.metadata : {}) }
    delete unmarkedMetadata["opencode-debate-checkpoint-store"]
    const removeMarker: MetadataUpdate = { path: { id: unmarkedID }, query: { directory: projectDirectory }, body: {
      title: "Renamed ordinary research history", metadata: { ...unmarkedMetadata, unrelatedPlugin: { retained: true } },
    } }
    getData(await client.session.update(removeMarker), "native checkpoint marker removal and rename")
    const unmarkedChild = getData<RecordValue>(await client.session.get({ path: { id: unmarkedID },
      query: { directory: projectDirectory } }), "unmarked renamed checkpoint child observation")
    const unmarkedRuntime = createRuntime(restartedInput)
    const unmarkedLoadRejected = await rejection("unmarked-renamed-checkpoint-load", unmarkedRuntime.load(unmarkedCase.caseOwner))
    const unmarkedDefaultSaveRejected = await rejection("unmarked-renamed-checkpoint-default-save", unmarkedRuntime.save(unmarkedCase.caseOwner, bootstrap))
    const unmarkedFreshSaveRejected = await rejection("unmarked-renamed-checkpoint-fresh-save", createRuntime(restartedInput).save(unmarkedCase.caseOwner, bootstrap))
    const unmarkedChildrenAfter = getData<RecordValue[]>(await client.session.children({ path: { id: unmarkedCase.caseOwner.sessionID },
      query: { directory: projectDirectory } }), "unmarked renamed checkpoint children after recovery")
    const unmarkedHistoryAfter = await nativeMessages(client, projectDirectory, unmarkedID)
    const unmarkedHistoryUnchanged = JSON.stringify(unmarkedHistoryBefore) === JSON.stringify(unmarkedHistoryAfter)
    const unmarkedRenamedCheckpointHistoryRejected = unmarkedLoadRejected && unmarkedDefaultSaveRejected && unmarkedFreshSaveRejected
      && unmarkedChild.title === removeMarker.body.title && isRecord(unmarkedChild.metadata)
      && !Object.hasOwn(unmarkedChild.metadata, "opencode-debate-checkpoint-store")
      && unmarkedChildrenAfter.length === 1 && unmarkedChildrenAfter[0]?.id === unmarkedID
      && unmarkedHistoryBefore.length === 1 && unmarkedHistoryUnchanged
    persistenceEvidence.push({ phase: "unmarked-renamed-native-checkpoint-history", storageID: unmarkedID,
      markerRemoved: isRecord(unmarkedChild.metadata) && !Object.hasOwn(unmarkedChild.metadata, "opencode-debate-checkpoint-store"),
      titleRenamed: unmarkedChild.title === removeMarker.body.title, historyCount: unmarkedHistoryAfter.length,
      historyUnchanged: unmarkedHistoryUnchanged, childIDsAfter: unmarkedChildrenAfter.map((child) => child.id),
      messageIDs: unmarkedHistoryAfter.map((message) => isRecord(message.info) ? message.info.id : undefined) })
    const incompleteCase = await negativeStore("incomplete")
    await appendDamage(incompleteCase, "incomplete")
    const incompleteCheckpointTailRejected = await rejection("incomplete-tail", createRuntime(restartedInput).load(incompleteCase.caseOwner))
    const corruptCase = await negativeStore("corrupt")
    await appendDamage(corruptCase, "corrupt", "opencode-debate/checkpoint/v1\ncorrupt-json")
    const corruptCheckpointRejected = await rejection("corrupt-record", createRuntime(restartedInput).load(corruptCase.caseOwner))
    const forkCase = await negativeStore("fork")
    await appendDamage(forkCase, "fork", "valid-fork")
    const forkedCheckpointHistoryRejected = await rejection("forked-history", createRuntime(restartedInput).load(forkCase.caseOwner))
    const ambiguousCase = await negativeStore("ambiguous")
    const duplicate = { query: { directory: projectDirectory }, body: { parentID: ambiguousCase.caseOwner.sessionID,
      title: String(ambiguousCase.child.title), agent: String(ambiguousCase.child.agent), model: ambiguousCase.child.model,
      metadata: ambiguousCase.child.metadata, permission: ambiguousCase.child.permission } }
    const duplicateChild = getData<RecordValue>(await client.session.create(duplicate), "ambiguous native store creation")
    if (typeof duplicateChild.id === "string") allStorageIDs.add(duplicateChild.id)
    const ambiguousCheckpointStoresRejected = await rejection("ambiguous-stores", createRuntime(restartedInput).load(ambiguousCase.caseOwner))
    const deletedCase = await negativeStore("deleted")
    const erasedMember = await deletedCase.caseRuntime.createParticipant(deletedCase.caseOwner, participant,
      await deletedCase.caseRuntime.restrictions(deletedCase.caseOwner))
    getData(await client.session.update({ path: { id: erasedMember.sessionID }, query: { directory: projectDirectory },
      body: { title: "Renamed member after state erasure" } }), "erased-state member rename")
    assertNoError(await client.session.delete({ path: { id: String(deletedCase.child.id) }, query: { directory: projectDirectory } }), "native storage deletion")
    const deletedCheckpointStoreRejected = await rejection("deleted-known-store", deletedCase.caseRuntime.save(deletedCase.caseOwner, { version: 1, discussions: [], outbox: [] }))
      && (await storesFor(deletedCase.caseOwner)).length === 0
    const erasedStateAutomaticMembersRejected = await rejection("erased-state-automatic-member-load", createRuntime(restartedInput).load(deletedCase.caseOwner))
      && await rejection("erased-state-automatic-member-save", createRuntime(restartedInput).save(deletedCase.caseOwner, bootstrap))
      && (await storesFor(deletedCase.caseOwner)).length === 0
    const remnantRootRequest = { query: { directory: projectDirectory }, body: { title: "Missing-state participant remnant probe",
      agent: "build", model: { providerID: "probe", id: "fake-model" }, permission: PARENT_RULES } }
    const remnantRoot = getData<RecordValue>(await client.session.create(remnantRootRequest), "remnant owner creation")
    if (typeof remnantRoot.id !== "string") throw new Error("Remnant owner identity missing")
    const remnantOwner: Owner = { sessionID: remnantRoot.id, agent: "build", directory: projectDirectory }
    const remnantRuntime = createRuntime(restartedInput)
    const remnant = await remnantRuntime.createParticipant(remnantOwner, participant, await remnantRuntime.restrictions(remnantOwner))
    getData(await client.session.update({ path: { id: remnant.sessionID }, query: { directory: projectDirectory },
      body: { title: "Renamed to an ordinary specialist title" } }), "automatic remnant rename")
    const missingStateParticipantRemnantsRejected = await rejection("missing-state-participant-remnant-load", createRuntime(restartedInput).load(remnantOwner))
      && await rejection("missing-state-participant-remnant-save", createRuntime(restartedInput).save(remnantOwner, bootstrap))
      && (await storesFor(remnantOwner)).length === 0
      && !providerObservations.requests.some((request) => request.sessionID === remnant.sessionID)
    const remnantChild = getData<RecordValue>(await client.session.get({ path: { id: remnant.sessionID },
      query: { directory: projectDirectory } }), "persisted automatic participant marker observation")
    const remnantMetadata = isRecord(remnantChild.metadata) ? remnantChild.metadata : {}
    const participantMarker = remnantMetadata["opencode-debate-automatic-participant"]
    if (!isRecord(participantMarker) || participantMarker.owner !== remnantOwner.sessionID || participantMarker.version !== 1) {
      throw new Error("Native participant creation did not persist its ownership marker")
    }
    persistenceEvidence.push({ phase: "renamed-automatic-participant-binding", sessionID: remnant.sessionID,
      kind: participantMarker.kind, version: participantMarker.version, owner: participantMarker.owner,
      project: participantMarker.project, directory: participantMarker.directory })
    const damageMarker: MetadataUpdate = { path: { id: remnant.sessionID }, query: { directory: projectDirectory }, body: {
      metadata: { ...remnantMetadata, "opencode-debate-automatic-participant": { ...participantMarker, version: "corrupt" } },
    } }
    getData(await client.session.update(damageMarker), "native automatic participant marker corruption")
    const corruptAutomaticParticipantMarkerRejected = await rejection("corrupt-automatic-participant-marker-load", createRuntime(restartedInput).load(remnantOwner))
      && await rejection("corrupt-automatic-participant-marker-save", createRuntime(restartedInput).save(remnantOwner, bootstrap))
      && (await storesFor(remnantOwner)).length === 0
    const prefixCase = await negativeStore("receipt-prefix")
    const prefixMember = await prefixCase.caseRuntime.createParticipant(prefixCase.caseOwner, participant, await prefixCase.caseRuntime.restrictions(prefixCase.caseOwner))
    await prefixCase.caseRuntime.save(prefixCase.caseOwner, { version: 1, discussions: [{ ...structuredClone(unknownDiscussion),
      owner: prefixCase.caseOwner, panel: [prefixMember] }], outbox: [] })
    const prefixMessages = await nativeMessages(client, projectDirectory, String(prefixCase.child.id))
    const prefixHead = prefixMessages.toSorted((a, b) => Number(checkpointPayload(a).revision) - Number(checkpointPayload(b).revision)).at(-1)!
    const prefixID = `${String((prefixHead.info as RecordValue).id)}prefix`
    const prefixPayload = { ...checkpointPayload(prefixHead), messageID: prefixID,
      previous: (prefixHead.info as RecordValue).id, revision: Number(checkpointPayload(prefixHead).revision) + 1,
      runtimeProof: { version: 1, entries: [] } }
    const prefixText = JSON.stringify(prefixPayload)
    getData(await client.session.prompt({ path: { id: String(prefixCase.child.id) }, query: { directory: projectDirectory }, body: {
      messageID: prefixID, agent: "build", model: { providerID: "probe", modelID: "fake-model" }, noReply: true,
      parts: [{ type: "text", text: "opencode-debate/checkpoint/v1\n" + JSON.stringify({ payload: prefixText,
        digest: createHash("sha256").update(prefixText).digest("hex") }) }],
    } }), "native changed receipt prefix append")
    const changedReceiptPrefixRejected = await rejection("changed-native-receipt-prefix", createRuntime(restartedInput).load(prefixCase.caseOwner))
    const checkpointSavesMadeNoModelCalls = !providerObservations.requests.some((request) => allStorageIDs.has(request.sessionID))

    stage = "native cancellation races"
    const outcomes: Promise<{ ok: boolean; error?: string }>[] = []
    const track = (promise: Promise<string>) => {
      const outcome = promise.then(() => ({ ok: true }), (error: unknown) => ({ ok: false,
        error: error instanceof Error ? error.message.slice(0, 300) : "participant failed" }))
      outcomes.push(outcome)
      return outcome
    }
    const confirm = async (member: PanelMember) => {
      await waitFor("adapter-verified cessation", async () => {
        await runtime.abort(member)
        return true
      })
      confirmedAborts[member.sessionID] = Date.now()
    }

    const cancelBefore = await runtime.createParticipant(owner, participant, inherited)
    const beforeOutcome = track(runtime.prompt(cancelBefore, "AUTO_DEBATE_CANCEL_BEFORE_DISPATCH: do not dispatch after stop."))
    await confirm(cancelBefore) // Same turn as prompt(), before its first lookup can resolve.
    const beforeMessages = await nativeMessages(client, projectDirectory, cancelBefore.sessionID)
    const abortBeforeDispatchWasChecked = !(await beforeOutcome).ok && beforeMessages.length === 0
      && !apiBoundaries.some((call) => call.method === "POST" && call.route === `/session/${cancelBefore.sessionID}/message`)
      && !providerObservations.requests.some((request) => request.sessionID === cancelBefore.sessionID)
    cancellationProof.push({ phase: "before-dispatch", sessionID: cancelBefore.sessionID,
      confirmed: confirmedAborts[cancelBefore.sessionID], noDispatch: abortBeforeDispatchWasChecked })

    const cancelImmediate = await runtime.createParticipant(owner, participant, inherited)
    const pendingOutcome = track(runtime.prompt(cancelImmediate, "AUTO_DEBATE_CANCEL_PENDING: hold native startup before runner registration."))
    const startup = await waitFor("native pending-startup barrier", async () =>
      providerObservations.startups.find((entry) => entry.sessionID === cancelImmediate.sessionID))
    let pendingConfirmed = false
    let pendingError: string | undefined
    const pendingStop = runtime.abort(cancelImmediate).then(() => { pendingConfirmed = true }, (error: unknown) => {
      pendingError = error instanceof Error ? error.message : "unconfirmed pending stop"
    })
    const earlyAck = await waitFor("native acknowledgement while adapter-owned startup remains held", async () =>
      apiBoundaries.find((call) => call.route === `/session/${cancelImmediate.sessionID}/abort` && call.status === 200))
    const pendingStartupAcknowledgementWasNotConfirmation = !pendingConfirmed && pendingError === undefined
      && startup.released === undefined
    pendingStartupGate.release()
    await waitFor("owned pending-startup stop settlement", async () => {
      if (pendingError) throw new Error(pendingError)
      return pendingConfirmed ? true : undefined
    })
    await pendingStop
    confirmedAborts[cancelImmediate.sessionID] = Date.now()
    cancelImmediateGate.release() // A late fake callback must not become a native result.
    await pendingOutcome
    const abortImmediatelyAfterDispatchWasChecked = earlyAck.time >= startup.time
      && pendingStartupAcknowledgementWasNotConfirmation
    cancellationProof.push({ phase: "pending-native-startup", sessionID: cancelImmediate.sessionID,
      startup: startup.time, acknowledged: earlyAck.time, released: startup.released,
      confirmed: confirmedAborts[cancelImmediate.sessionID], acknowledgementWasNotConfirmation: pendingStartupAcknowledgementWasNotConfirmation })

    const cancelBusy = await runtime.createParticipant(owner, participant, inherited)
    const busyOutcome = track(runtime.prompt(cancelBusy, "AUTO_DEBATE_CANCEL_BUSY: hold the native runner at the fake provider."))
    await waitFor("provider request for busy-cancellation child", async () =>
      providerObservations.requests.some((request) => request.marker === "cancel-busy") ? true : undefined)
    const busyBeforeAbort = await nativeStatus(client, projectDirectory, cancelBusy.sessionID)
    if (busyBeforeAbort !== "busy") throw new Error("Cancellation probe child was not busy before abort")
    await confirm(cancelBusy)
    cancelBusyGate.release()
    await busyOutcome
    cancellationProof.push({ phase: "after-busy", sessionID: cancelBusy.sessionID,
      busyBeforeStop: busyBeforeAbort, confirmed: confirmedAborts[cancelBusy.sessionID] })
    const abortCallsBeforeReverification = nativeAbortRequests.length
    await waitFor("fresh verification for an already stopped participant", async () => {
      await runtime.abort(cancelBusy)
      return true
    })
    const stoppedReverificationWasExecuted = nativeAbortRequests.length > abortCallsBeforeReverification
    cancellationProof.push({ phase: "late-event-reverification", sessionID: cancelBusy.sessionID,
      freshNativeAbort: stoppedReverificationWasExecuted })

    const stoppedMembers = [cancelBefore, cancelImmediate, cancelBusy]
    const stoppedResultsWereRejected = (await Promise.all(outcomes)).every((outcome) => !outcome.ok)
    const stoppedDispatchesWereRejected = (await Promise.all(stoppedMembers.map(async (member) => {
      const before = providerObservations.requests.filter((request) => request.sessionID === member.sessionID).length
      const rejected = await runtime.prompt(member, "a stopped participant must never dispatch another round")
        .then(() => false, (error: unknown) => error instanceof Error && /stopp|cancel/i.test(error.message))
      return rejected && providerObservations.requests.filter((request) => request.sessionID === member.sessionID).length === before
    }))).every(Boolean)
    const recoveryStopWasUnconfirmed = await restartedRuntime.abort(cancelImmediate)
      .then(() => false, (error: unknown) => error instanceof Error && /unknown|owned|provenance/i.test(error.message))
      && await restartedRuntime.prompt(cancelImmediate, "recovery must not adopt unknown native starts")
        .then(() => false, (error: unknown) => error instanceof Error && /unknown|owned|provenance/i.test(error.message))

    // Retain the raw-native counterexample, labelled acknowledgement only. It is
    // deliberately outside adapter dispatch and never enters confirmedAborts.
    const rawMember = await runtime.createParticipant(owner, participant, inherited)
    const rawMessageID = `msg_${randomUUID()}`
    assertNoError(await client.session.promptAsync(promptAsyncRequest(rawMember.sessionID, projectDirectory,
      rawMessageID, participant.agent, "AUTO_DEBATE_RAW_NATIVE_START: hold untracked native startup.")), "raw diagnostic dispatch")
    const rawStartup = await waitFor("raw native startup held", async () =>
      providerObservations.startups.find((entry) => entry.sessionID === rawMember.sessionID))
    const rawAck = getData<unknown>(await client.session.abort({ path: { id: rawMember.sessionID },
      query: { directory: projectDirectory } }), "raw native abort acknowledgement")
    acknowledgedRawAborts[rawMember.sessionID] = Date.now()
    const rawNativeAbortWasAcknowledgementOnly = rawAck === true && rawStartup.released === undefined
      && confirmedAborts[rawMember.sessionID] === undefined
    rawStartupGate.release()
    const rawFinal = await waitFor("raw acknowledgement-only counterexample native final", async () => {
      const messages = await nativeMessages(client, projectDirectory, rawMember.sessionID)
      return messages.some((message) => Array.isArray(message.parts) && message.parts.some((part) => isRecord(part)
        && part.type === "text" && typeof part.text === "string" && part.text.includes("native probe raw-native"))) ? messages : undefined
    })
    cancellationProof.push({ phase: "raw-native-diagnostic-not-confirmation", sessionID: rawMember.sessionID,
      acknowledged: acknowledgedRawAborts[rawMember.sessionID], startupReleased: rawStartup.released,
      nativeFinalObserved: rawFinal.some((message) => isRecord(message.info) && message.info.role === "assistant") })

    // All adapter-owned operations have settled, and each stop performed native
    // termination reconciliation. No fixed quiet sleep is used as a proof.
    const immediateMessages = await nativeMessages(client, projectDirectory, cancelImmediate.sessionID)
    const busyCancelMessages = await nativeMessages(client, projectDirectory, cancelBusy.sessionID)
    const cancelledMessages = [immediateMessages, busyCancelMessages].flatMap((messages) => messages.flatMap((message) => {
      const info = message.info
      if (!isRecord(info) || info.role !== "assistant" || typeof info.sessionID !== "string") return []
      const time = isRecord(info.time) ? info.time : {}
      const final = Array.isArray(message.parts) && message.parts.some((part) => isRecord(part)
        && part.type === "text" && typeof part.text === "string" && part.text.includes("native probe cancel-"))
      return [{ sessionID: info.sessionID, time: typeof time.completed === "number" ? time.completed
        : typeof time.created === "number" ? time.created : 0, final,
        messageID: info.id, error: info.error }]
    }))
    messageEvidence.push({ label: "native-cancellation-messages", messages: cancelledMessages })
    const cancellationEvents = await readEvents(eventsPath)
    const childRanAfterConfirmedCancellation = nativeCancellationEffects({
      events: cancellationEvents, requests: providerObservations.requests, messages: cancelledMessages,
      confirmed: confirmedAborts,
    })

    const observation: Observation = {
      parentToolReturnedBeforeChildrenFinished,
      threeChildrenWereBusyTogether,
      deniedReadExecuted,
      deniedEditExecuted,
      participantSpawnedChild,
      parentAskWasAutoApproved,
      parentAskWasObserved: parentAskWasObserved && askEventsSeen.size > 0,
      deniedReadWasObserved,
      immutableToolsWereHidden,
      resultEvaluatedAfterBusyParentBecameIdle,
      parentWasAbortedForDelivery,
      childRanAfterConfirmedCancellation,
      checkpointStateSurvivedRestart,
      otherMetadataPreserved,
      abortImmediatelyAfterDispatchWasChecked,
      abortAfterBusyWasChecked: busyBeforeAbort === "busy",
      abortBeforeDispatchWasChecked,
      pendingStartupAcknowledgementWasNotConfirmation,
      stoppedResultsWereRejected,
      stoppedDispatchesWereRejected,
      recoveryStopWasUnconfirmed,
      rawNativeAbortWasAcknowledgementOnly,
      stoppedReverificationWasExecuted,
      checkpointSavesMadeNoModelCalls,
      checkpointSavesDidNotChangeOwnerHistory,
      checkpointSavesPreservedBusyOwner,
      concurrentOwnerMetadataPreserved,
      multipleCheckpointRecordsSurvivedRestart,
      sameManagerCheckpointWritesSerialized,
      incompleteCheckpointTailRejected,
      corruptCheckpointRejected,
      forkedCheckpointHistoryRejected,
      ambiguousCheckpointStoresRejected,
      deletedCheckpointStoreRejected,
      transcriptOffCreatedNoFiles,
      checkpointBootstrapLifecycleWorked,
      missingStateParticipantRemnantsRejected,
      unrelatedExistingChildAllowsBootstrap,
      corruptAutomaticParticipantMarkerRejected,
      erasedStateAutomaticMembersRejected,
      unmarkedRenamedCheckpointHistoryRejected,
      heldDeliveryForkReconciledWithoutRedispatch, lostDeliveryResponseReconciledAfterWriterRestart,
      pausedPanelContinuedAfterWriterRestart, pausedPanelContinuedAfterNativeRestart,
      unknownStartupStayedUnconfirmedAfterRecovery, receiptPrefixesSurvivedManagerSaves,
      changedReceiptPrefixRejected, receiptWritesPreservedOwnerPrivacy,
      fakeProviderRequests: providerObservations.requests.length,
      observedNativeToolCalls,
    }
    completedObservation = observation
    return { observation, version }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown native probe failure"
    failure = message
    if (client) {
      for (const member of nativeChildren) {
        const messages = await nativeMessages(client, projectDirectory, member.sessionID).catch(() => [])
        messageEvidence.push({ sessionID: member.sessionID, messages: messages.slice(-8).map((item) => {
          const info = isRecord(item.info) ? item.info : {}
          return { role: info.role, finish: info.finish, error: info.error,
            tools: Array.isArray(item.parts) ? item.parts.filter(isRecord).filter((part) => part.type === "tool")
              .map((part) => ({ tool: part.tool, state: isRecord(part.state) ? {
                status: part.state.status, error: part.state.error,
              } : undefined })) : [] }
        }) })
      }
    }
    const diagnostics = nativeDiagnostics.slice(-8).join(" | ")
    const parentAbortCount = nativeAbortRequests.length
    const providerTrace = providerObservations.requests.map(({ marker, stage: requestStage }) => `${marker}.${requestStage}`).join(",")
    const events = await readEvents(eventsPath)
    const eventTrace = events.filter((event) => event.type.startsWith("permission.") || event.type === "tool.execute.after")
      .map((event) => `${event.type}:${event.permission ?? event.tool ?? ""}:${event.sessionID ?? ""}`)
      .join(",")
    throw new Error(
      `Native runtime probe failed during ${stage}: ${message}${parentAbortCount ? `; session abort calls=${parentAbortCount}` : ""}`
      + `${providerTrace ? `; provider=${providerTrace}` : ""}`
      + `${eventTrace ? `; events=${eventTrace}` : ""}`
      + `${diagnostics ? `; server: ${diagnostics}` : ""}`,
      { cause: error },
    )
  } finally {
    for (const gate of gates) gate.release()
    if (nativeProcess) await stopServer(nativeProcess)
    if (providerServer) {
      providerServer.closeAllConnections()
      await new Promise<void>((resolvePromise) => providerServer?.close(() => resolvePromise()))
    }
    try {
      if (options.evidencePath) {
        const installations = await Promise.all([join(xdgConfig, "opencode"), join(projectDirectory, ".opencode")]
          .map(async (directory) => {
            const versions: Record<string, unknown> = {}
            for (const name of ["plugin", "sdk"]) {
              const packagePath = join(directory, "node_modules", "@opencode-ai", name, "package.json")
              const text = await readFile(packagePath, "utf8").catch(() => undefined)
              versions[name] = text ? (JSON.parse(text) as RecordValue).version : "not-installed"
            }
            return { directory, versions }
          }))
        const evidence = { version, stage, failure, observation: completedObservation,
          workspace, workspaceName: basename(workspace), isolation: Object.fromEntries(Object.entries(isolatedEnvironment({ home, xdgConfig, xdgData, xdgCache, xdgState,
            temporary, events: eventsPath })).filter(([key]) => key !== "PATH")),
          provider: providerObservations.requests.slice(-40),
          providerErrors: providerObservations.errors.slice(-10),
          events: (await readEvents(eventsPath)).slice(-100),
          api: apiBoundaries.slice(-100), promptFailures, messages: messageEvidence,
          statusSnapshots: statusEvidence, persistenceEvidence, confirmedAborts, acknowledgedRawAborts, cancellationProof,
          startups: providerObservations.startups,
          processCleanup: nativeProcesses.map((process) => ({ pid: process.pid,
            exited: process.exitCode !== null || process.signalCode !== null })),
          workspacePathsVerified, installations,
          server: nativeDiagnostics.slice(-8), aborts: nativeAbortRequests }
        const sanitised = JSON.stringify(evidence, null, 2).replaceAll(workspace, "$WORKSPACE")
          .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]")
        if (Buffer.byteLength(sanitised) > 65_536) throw new Error("Native evidence exceeded its sanitised size bound")
        await writeFile(options.evidencePath, `${sanitised}\n`, { encoding: "utf8", flag: "wx" })
      }
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

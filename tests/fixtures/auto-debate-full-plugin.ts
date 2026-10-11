import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { createConnection, createServer as createNetServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { isolatedEnvironment } from "./auto-debate-runtime.ts"

type RecordValue = Record<string, unknown>
type NativeClient = ReturnType<typeof createOpencodeClient>
type ParentAction = { action: string; [key: string]: unknown }
type ParticipantPrompt = {
  sessionID: string
  discussionID: string
  cycle: number
  round: number
  text: string
}
type Task6Observation = {
  fullPluginWasLoaded: boolean
  enabledByConversationCommand: boolean
  twoDiscussionsWereIndependent: boolean
  noCrossDiscussionMixup: boolean
  unanimousStopWasNotConsensus: boolean
  parentCompletedIndependentWorkWhileBothPanelsWereBusy: boolean
  offAllowedBothExistingCyclesToFinish: boolean
  resumedPanelRetainedAllSessionIDsAndFocusedFeedback: boolean
  cancelledOtherDiscussionWithoutAffectingResume: boolean
  mainAgentEvaluatedBothCycles: boolean
  transcriptLinksWereReturnedAndRecordsWereSaved: boolean
  resetRestoredConfiguredDefault: boolean
  panelPromptCount: number
  uniqueParticipantSessions: number
  transcriptPaths: string[]
  discussionIDs: { alpha: string; beta: string }
  participantSessionIDs: { alpha: string[]; beta: string[] }
  providerRequests: number
}
type AcceptanceResult = { observation: Task6Observation; version: string;
  cleanup?: { nativeProcessesExited: boolean; isolatedWorkspaceRemoved: boolean }; fixes?: NativeFixResult }
type NativeFixResult = {
  version: string
  configEnabledFirstStart: boolean
  configEnabledFirstStatus: boolean
  currentInvocationProofPersisted: boolean
  nativeAskRejectedBeforeAnyChildOrDispatch: boolean
  agentPatternedDenyPreventedDispatch: boolean
  sessionWildcardPatternedDenyPreventedDispatch: boolean
  userStopAllCancelledTwoOwnedDiscussions: boolean
  userStopAllPreservedOtherOwner: boolean
  stopAllHadDurableCessationProof: boolean
  cancelledPanelsRejectedFurtherResume: boolean
  yamlUnchanged: boolean
  permissionRequest: RecordValue
  rejectedToolError: string
  deniedToolErrors: string[]
  ownedDiscussionIDs: string[]
  ownedParticipantSessionIDs: string[]
  confirmedStopSessionIDs: string[]
  providerPanelPrompts: number
  corrective?: { refusalThenApproved: boolean; approvalOwnerID: string; approvedDiscussionID: string;
    approvedPermissionRequest: RecordValue; batches: RecordValue[] }
  cleanup: { nativeProcessesExited: boolean; isolatedWorkspaceRemoved: boolean }
}

const WAIT_MS = 20_000
const POLL_MS = 25
const ALPHA = {
  question: "TASK6_ALPHA_DECISION: Should the cache use bounded LRU or time-based expiry?",
  objective: "Choose a safe cache policy for the alpha workload.",
  facts: ["TASK6_ALPHA_FACT: alpha entries are shared across two workers."],
  assumptions: ["TASK6_ALPHA_ASSUMPTION: callers can tolerate a short stale window."],
  constraints: ["TASK6_ALPHA_CONSTRAINT: do not lose valid entries during deployment."],
  alternatives: ["TASK6_ALPHA_ALTERNATIVE_LRU", "TASK6_ALPHA_ALTERNATIVE_TTL"],
  uncertainty: "TASK6_ALPHA_UNCERTAINTY: eviction and expiry behaviour under load is unmeasured.",
  neededOutcome: "A recommendation with the key trade-off.",
}
const BETA = {
  question: "TASK6_BETA_DECISION: Should the index use compact pages or a sparse map?",
  objective: "Choose a predictable index layout for the beta workload.",
  facts: ["TASK6_BETA_FACT: beta keys are mostly sequential."],
  assumptions: ["TASK6_BETA_ASSUMPTION: the index is rebuilt from durable source data."],
  constraints: ["TASK6_BETA_CONSTRAINT: readers must not observe a partial rebuild."],
  alternatives: ["TASK6_BETA_ALTERNATIVE_COMPACT", "TASK6_BETA_ALTERNATIVE_SPARSE"],
  uncertainty: "TASK6_BETA_UNCERTAINTY: rebuild cost and read amplification are unmeasured.",
  neededOutcome: "A recommendation with the key trade-off.",
}
const ALPHA_FEEDBACK = "TASK6_ALPHA_FOCUSED_FEEDBACK: compare restart recovery under the measured stale-window constraint."

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function responseData<T>(result: unknown, operation: string): T {
  if (!isRecord(result) || result.error !== undefined && result.error !== null
    || !Object.hasOwn(result, "data") || result.data === undefined || result.data === null) {
    throw new Error(`Native Task 6 ${operation} failed or returned no data`)
  }
  return result.data as T
}

function assertNoError(result: unknown, operation: string): void {
  if (!isRecord(result) || result.error !== undefined && result.error !== null) {
    throw new Error(`Native Task 6 ${operation} failed`)
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n")
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

async function readBody(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length === 0 ? undefined : JSON.parse(text) as unknown
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(value))
}

function toolCall(name: string, args: ParentAction, suffix: string) {
  return {
    id: `call_${suffix}_${randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

function writeCompletion(
  response: ServerResponse,
  body: RecordValue,
  text: string,
  calls?: ReturnType<typeof toolCall>[],
): void {
  const id = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  if (body.stream === false) {
    json(response, 200, {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake-model",
      choices: [{ index: 0, message: calls
        ? { role: "assistant", content: null, tool_calls: calls }
        : { role: "assistant", content: text }, finish_reason: calls ? "tool_calls" : "stop" }],
    })
    return
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
  const chunk = (delta: RecordValue, finishReason: string | null) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant" }, null))}\n\n`)
  if (calls) {
    calls.forEach((call, index) => response.write(`data: ${JSON.stringify(chunk({
      tool_calls: [{ index, id: call.id, type: call.type, function: call.function }],
    }, null))}\n\n`))
    response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`)
  } else {
    response.write(`data: ${JSON.stringify(chunk({ content: text }, null))}\n\n`)
    response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`)
  }
  response.end("data: [DONE]\n\n")
}

function discussionDetails(text: string): { discussionID: string; cycle: number; round: number } | undefined {
  const match = /Discussion:\s+"([^"]+)"\. Cycle (\d+), round (\d+)\. Response schema: round[12]\./u.exec(text)
  return match ? { discussionID: match[1], cycle: Number(match[2]), round: Number(match[3]) } : undefined
}

function visit(value: unknown, operation: (entry: RecordValue) => void, seen = new Set<object>()): void {
  if (typeof value === "string") {
    try { visit(JSON.parse(value) as unknown, operation, seen) } catch { /* Non-JSON text is not a structured tool result. */ }
    return
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  if (isRecord(value)) operation(value)
  if (Array.isArray(value)) for (const item of value) visit(item, operation, seen)
  else for (const child of Object.values(value)) visit(child, operation, seen)
}

function pathsInToolResults(messages: unknown): string[] {
  const paths: string[] = []
  visit(messages, (entry) => {
    if (isRecord(entry.persistence) && typeof entry.persistence.path === "string"
      && /^docs\/debates\/auto-[0-9a-f-]+\.md$/u.test(entry.persistence.path)) {
      paths.push(entry.persistence.path)
    }
  })
  return [...new Set(paths)]
}

function providerServer(options: {
  providerURL: string
  ownerID: () => string | undefined
  ownerIDs?: Set<string>
  holdFirstRound: Promise<void>
  holdParticipant?: (prompt: ParticipantPrompt) => Promise<void>
  holdAbort?: (sessionID: string) => Promise<void>
  actions: Map<string, ParentAction>
  observations: {
    parentCalls: Map<string, number>
    parentToolCalls: string[]
    participantPrompts: ParticipantPrompt[]
    providerErrors: string[]
    unrecognizedRequests: { sessionID: string; promptPrefix: string; messageRoles: string[] }[]
    reportPaths: string[]
  }
}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`)
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, { object: "list", data: [{ id: "fake-model", object: "model", created: 0, owned_by: "task6-local-fixture" }] })
      return
    }
    if (request.method === "GET" && url.pathname === "/corrective-abort") {
      await options.holdAbort?.(url.searchParams.get("session") ?? "")
      json(response, 200, { released: true })
      return
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      json(response, 404, { error: { message: "Task 6 local fake-provider route not found" } })
      return
    }
    try {
      const requestBody = await readBody(request)
      if (!isRecord(requestBody)) throw new Error("provider request was not an object")
      const sessionID = String(request.headers["x-opencode-session-id"] ?? "")
      const prompt = lastUserText(requestBody.messages)
      const rootID = options.ownerID()
      if (rootID && sessionID === rootID || options.ownerIDs?.has(sessionID)) {
        const marker = /^TASK6_E2E_[A-Z_]+/u.exec(prompt)?.[0] ?? "TASK6_E2E_OTHER"
        const stage = (options.observations.parentCalls.get(marker) ?? 0) + 1
        options.observations.parentCalls.set(marker, stage)
        const action = options.actions.get(marker)
        if (action && stage === 1) {
          const offered = Array.isArray(requestBody.tools) ? requestBody.tools.flatMap((candidate) =>
            isRecord(candidate) && isRecord(candidate.function) && typeof candidate.function.name === "string"
              ? [candidate.function.name] : []) : []
          if (!offered.includes("auto_debate")) throw new Error("The actual main-agent request did not expose auto_debate")
          options.observations.parentToolCalls.push(marker)
          writeCompletion(response, requestBody, "", [toolCall("auto_debate", action, marker)])
          return
        }
        if (marker === "TASK6_E2E_REPORT_LINKS" && stage > 1) {
          const paths = pathsInToolResults(requestBody.messages)
          options.observations.reportPaths = paths
          writeCompletion(response, requestBody, paths.length === 2
            ? `Saved automatic-debate records: ${paths.map((path) => `[${path.split("/").at(-1)}](${path})`).join("; ")}`
            : "The saved transcript paths were not present in the status tool result.")
          return
        }
        writeCompletion(response, requestBody, `Task 6 native main-agent work completed: ${marker}.`)
        return
      }

      const details = discussionDetails(prompt)
      if (!details) {
        const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
        options.observations.unrecognizedRequests.push({ sessionID, promptPrefix: prompt.slice(0, 500),
          messageRoles: messages.flatMap((message) => isRecord(message) && typeof message.role === "string" ? [message.role] : []) })
        throw new Error("An unrecognised request reached the local fake provider")
      }
      const observation = { sessionID, ...details, text: prompt }
      options.observations.participantPrompts.push(observation)
      if (details.cycle === 1 && details.round === 1) await options.holdFirstRound
      await options.holdParticipant?.(observation)
      const tag = details.discussionID === "" ? "unknown" : details.discussionID
      const turn = `TASK6_NATIVE_TURN ${tag} cycle ${details.cycle} round ${details.round} session ${sessionID}`
      const content = details.round === 1 && details.cycle === 1
        ? JSON.stringify({ turn })
        : JSON.stringify({ turn, consensus_reached: false, recommend_stopping: true })
      writeCompletion(response, requestBody, content)
    } catch (error) {
      options.observations.providerErrors.push(error instanceof Error ? error.message.slice(0, 300) : "unknown fake-provider error")
      if (!response.destroyed && !response.writableEnded) json(response, 500, { error: { message: "Task 6 local fake-provider failure" } })
    }
  })
}

async function freePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve a Task 6 loopback port")
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  return address.port
}

async function waitFor<T>(label: string, read: () => Promise<T | undefined | false>, timeoutMs = WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined && value !== false) return value as T
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, POLL_MS))
  }
  throw new Error(`Timed out waiting for Task 6 native acceptance: ${label}`)
}

async function startServer(binary: string, projectDirectory: string, port: number, environment: NodeJS.ProcessEnv,
  diagnostics: string[], debug = false): Promise<ChildProcess> {
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--log-level", debug ? "DEBUG" : "ERROR"], {
    cwd: projectDirectory, env: environment, stdio: ["ignore", "pipe", "pipe"],
  })
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (/(error|warn|plugin|config)/i.test(line)) diagnostics.push(line.replace(/(api[_-]?key|token|authorization)\s*[:=]\s*\S+/giu, "$1=[redacted]").slice(0, 400))
    }
    if (diagnostics.length > 12) diagnostics.splice(0, diagnostics.length - 12)
  }
  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)
  try {
    await waitFor("OpenCode server startup", async () => {
      if (child.exitCode !== null) throw new Error(`OpenCode exited during startup${diagnostics.length ? `: ${diagnostics.join(" | ")}` : ""}`)
      return await new Promise<boolean | undefined>((resolvePromise) => {
        const socket = createConnection({ host: "127.0.0.1", port })
        socket.once("connect", () => { socket.destroy(); resolvePromise(true) })
        socket.once("error", () => resolvePromise(undefined))
      })
    })
  } catch (error) {
    await stopServer(child)
    throw error
  }
  return child
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()))
  child.kill("SIGTERM")
  if (await Promise.race([exited.then(() => true), new Promise<false>((resolvePromise) => setTimeout(() => resolvePromise(false), 4_000))])) return
  if (child.exitCode === null) child.kill("SIGKILL")
  await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000))])
  if (child.exitCode === null && child.signalCode === null) throw new Error("Task 6 isolated OpenCode process did not stop")
}

function toolParts(messages: readonly RecordValue[]): RecordValue[] {
  return messages.flatMap((message) => Array.isArray(message.parts) ? message.parts.filter((part): part is RecordValue =>
    isRecord(part) && part.type === "tool" && part.tool === "auto_debate") : [])
}

function resultsFromMessages(messages: readonly RecordValue[]): RecordValue[] {
  const results: RecordValue[] = []
  const seen = new Set<string>()
  for (const part of toolParts(messages)) {
    visit(part.state, (entry) => {
      if (typeof entry.action !== "string") return
      if (!Object.hasOwn(entry, "discussion") && !Object.hasOwn(entry, "discussions")) return
      const key = JSON.stringify(entry)
      if (!seen.has(key)) { seen.add(key); results.push(entry) }
    })
  }
  return results
}

function assistantFinished(messages: readonly RecordValue[], messageID: string): boolean {
  return messages.some((message) => isRecord(message.info) && message.info.role === "assistant"
    && message.info.parentID === messageID)
}

function discussionSummaries(messages: readonly RecordValue[]): RecordValue[] {
  const summaries = new Map<string, RecordValue>()
  for (const result of resultsFromMessages(messages)) {
    const values = [
      ...(isRecord(result.discussion) ? [result.discussion] : []),
      ...(Array.isArray(result.discussions) ? result.discussions.filter(isRecord) : []),
    ]
    for (const summary of values) if (typeof summary.id === "string") summaries.set(summary.id, summary)
  }
  return [...summaries.values()]
}

function statusOf(summary: RecordValue | undefined): string | undefined {
  return summary && typeof summary.status === "string" ? summary.status : undefined
}

function startIDs(messages: readonly RecordValue[]): string[] {
  return resultsFromMessages(messages).flatMap((result) => result.action === "start" && isRecord(result.discussion)
    && typeof result.discussion.id === "string" ? [result.discussion.id] : [])
}

async function nativeMessages(client: NativeClient, directory: string, sessionID: string): Promise<RecordValue[]> {
  const messages = responseData<unknown>(await client.session.messages({ path: { id: sessionID }, query: { directory } }), "session messages")
  if (!Array.isArray(messages)) throw new Error("Native Task 6 session messages were invalid")
  return messages.filter(isRecord)
}

async function nativeStatus(client: NativeClient, directory: string, sessionID: string): Promise<string | undefined> {
  const value = responseData<unknown>(await client.session.status({ query: { directory } }), "session status")
  if (!isRecord(value)) throw new Error("Native Task 6 session status was invalid")
  if (value[sessionID] === undefined) return "idle"
  return isRecord(value[sessionID]) && typeof value[sessionID].type === "string" ? value[sessionID].type : undefined
}

function parseDiscussionFromPrompt(text: string): string | undefined {
  return discussionDetails(text)?.discussionID
}

function containsOnlyDiscussion(prompt: ParticipantPrompt, own: Record<string, unknown>, foreignMarker: string): boolean {
  return prompt.text.includes(String(own.question))
    && prompt.text.includes(String(own.objective))
    && prompt.text.includes(String(own.uncertainty))
    && !prompt.text.includes(foreignMarker)
}

export async function runAutomaticDebateNativeAcceptance(options: { evidencePath?: string; includeFixes?: boolean } = {}): Promise<AcceptanceResult> {
  const evidenceDirectory = resolve(".superpowers/sdd/2026-10-09-automatic-debate")
  if (options.evidencePath && resolve(dirname(resolve(options.evidencePath))) !== evidenceDirectory) {
    throw new Error("Task 6 evidence must stay in its exclusive automatic-debate evidence directory")
  }
  if (options.includeFixes) {
    const baseline = await runAutomaticDebateNativeAcceptance()
    const fixes = await runAutomaticDebateNativeFixRegressions()
    const result = { ...baseline, fixes }
    if (options.evidencePath) await writeFile(options.evidencePath, `${JSON.stringify({
      task: "Consolidated final fix: original full-plugin acceptance plus native F1–F4 regressions",
      nativeOpenCodeVersion: result.version, nodeVersion: process.version,
      provider: "Loopback-only deterministic fake; no real model calls or credentials",
      originalAcceptance: result.observation, originalCleanup: result.cleanup, fixes,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    return result
  }
  const workspace = await mkdtemp("/tmp/opencode/auto-debate-task6-")
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
  let ownerID: string | undefined
  let provider!: Awaited<ReturnType<typeof providerServer>>
  let providerServerStarted = false
  let nativeProcess: ChildProcess | undefined
  let workspaceRemoved = false
  let version = "not-queried"
  let stage = "isolated workspace setup"
  let permissionTrace = "not-inspected"
  let result: AcceptanceResult | undefined
  const nativeProcesses: ChildProcess[] = []
  const nativeRequests: { method: string; route: string; status?: number }[] = []
  const nativeApiFailures: string[] = []
  const nativeDiagnostics: string[] = []
  const firstRoundRelease = (() => {
    let release!: () => void
    const promise = new Promise<void>((resolvePromise) => { release = resolvePromise })
    return { promise, release }
  })()
  const actions = new Map<string, ParentAction>()
  const observations = {
    parentCalls: new Map<string, number>(),
    parentToolCalls: [] as string[],
    participantPrompts: [] as ParticipantPrompt[],
    providerErrors: [] as string[],
    unrecognizedRequests: [] as { sessionID: string; promptPrefix: string; messageRoles: string[] }[],
    reportPaths: [] as string[],
  }

  try {
    await Promise.all([projectDirectory, home, temporary, xdgConfig, xdgData, xdgCache, xdgState, pluginDirectory,
      join(workspace, "managed-config")].map((path) => mkdir(path, { recursive: true })))
    const pluginURL = new URL("../../index.ts", import.meta.url).href
    const pluginSource = `import { appendFileSync } from "node:fs";
import { createServer } from ${JSON.stringify(pluginURL)};
const eventFile = process.env.OPENCODE_DEBATE_PROBE_EVENTS;
function record(type) { if (eventFile) appendFileSync(eventFile, JSON.stringify({ type, time: Date.now() }) + "\\n", "utf8"); }
const registry = {
  participants: ["alpha", "beta", "gamma"].map((agent) => ({ agent, description: "Neutral Task 6 fixture participant", model: "probe/fake-model" })),
  sets: { default: ["alpha", "beta", "gamma"] },
  defaultSet: "default",
  autoDebate: { enabled: false, maxRounds: 3, persistTranscripts: true },
};
const fullPlugin = createServer(() => registry);
export default async function Task6FullPlugin(input, options) {
  record("task6-plugin-entry");
  const app = input.client.app;
  const originalAgents = app.agents.bind(app);
  app.agents = async (...args) => { record("task6-app-agents-start"); try { return await originalAgents(...args); } finally { record("task6-app-agents-end"); } };
  const hooks = await fullPlugin(input, options);
  record("task6-plugin-hooks-ready");
  const originalConfig = hooks.config;
  if (originalConfig) hooks.config = async (config) => {
    record("task6-config-start");
    record("task6-config-agents:" + JSON.stringify(Object.entries(config.agent || {}).map(([name, agent]) => [name, agent && agent.mode, agent && agent.hidden])));
    try { await originalConfig(config); } finally { record("task6-config-end"); }
  };
  return hooks;
}
`
    await writeFile(join(pluginDirectory, "full-automatic-debate.js"), pluginSource, "utf8")
    const environment = isolatedEnvironment({ home, xdgConfig, xdgData, xdgCache, xdgState, temporary, events: eventsPath })
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
          name: "Task 6 loopback fake provider",
          options: { baseURL: `${providerURL}/v1`, apiKey: "not-a-real-credential" },
          models: { "fake-model": { name: "Task 6 local fake model", limit: { context: 32_000, output: 2_048 } } },
        },
      },
    }
    await writeFile(projectConfigPath, JSON.stringify(config, null, 2), "utf8")
    if (await realpath(workspace) !== resolve(workspace)) throw new Error("Task 6 workspace must not be a symlink")
    for (const path of [projectDirectory, home, temporary, xdgConfig, xdgData, xdgCache, xdgState, pluginDirectory]) {
      if (!(await realpath(path)).startsWith(`${workspace}/`)) throw new Error("Task 6 native fixture path escaped its workspace")
    }
    stage = "native binary and version"
    const binary = environment.OPENCODE_BIN ?? "opencode"
    execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory, env: environment, timeout: 10_000 })
    version = execFileSync(binary, ["--version"], { cwd: projectDirectory, env: environment, encoding: "utf8", timeout: 10_000 }).trim()
    if (version !== "1.18.35") throw new Error(`Unreviewed Task 6 native runtime version: ${version}`)

    stage = "loopback fake-provider startup"
    const createdProvider = await providerServer({ providerURL, ownerID: () => ownerID,
      holdFirstRound: firstRoundRelease.promise, actions, observations })
    provider = createdProvider
    await new Promise<void>((resolvePromise, reject) => {
      provider.once("error", reject)
      provider.listen(providerPort, "127.0.0.1", () => resolvePromise())
    })
    providerServerStarted = true
    stage = "native OpenCode server startup"
    nativeProcess = await startServer(binary, projectDirectory, serverPort, environment, nativeDiagnostics)
    nativeProcesses.push(nativeProcess)
    const client = createOpencodeClient({ baseUrl: baseURL, fetch: async (request) => {
      try {
        const response = await fetch(request, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]) })
        nativeRequests.push({ method: request.method, route: new URL(request.url).pathname, status: response.status })
        return response
      } catch (error) {
        nativeApiFailures.push(`${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? error.message : "fetch failed"}`)
        throw error
      }
    } })
    stage = "native project identity and full-plugin loading"
    await waitFor("native project identity", async () => {
      try {
        const project = responseData<RecordValue>(await client.project.current({ query: { directory: projectDirectory } }), "project lookup")
        return typeof project.id === "string" && resolve(String(project.worktree)) === resolve(projectDirectory) ? project : undefined
      } catch (error) {
        nativeApiFailures.push(error instanceof Error ? error.message.slice(0, 200) : "project lookup failed")
        return undefined
      }
    }, 60_000)
    const rootRequest = {
      query: { directory: projectDirectory },
      body: { title: "Task 6 full automatic-debate plugin acceptance", agent: "build",
        model: { providerID: "probe", id: "fake-model" }, permission: [] },
    }
    const root = responseData<RecordValue>(await client.session.create(rootRequest as never), "main-agent session creation")
    if (typeof root.id !== "string") throw new Error("Task 6 native owner session has no ID")
    ownerID = root.id

    const loadedAgents = responseData<unknown>(await client.app.agents({ query: { directory: projectDirectory } }), "loaded agent lookup")
    const loadedCommands = responseData<unknown>(await client.command.list({ query: { directory: projectDirectory } }), "loaded command lookup")
    const nativeRoot = responseData<RecordValue>(await client.session.get({ path: { id: ownerID }, query: { directory: projectDirectory } }), "main-agent session permissions")
    const buildAgent = Array.isArray(loadedAgents) ? loadedAgents.find((agent) => isRecord(agent) && agent.name === "build") : undefined
    permissionTrace = JSON.stringify({ agent: isRecord(buildAgent) ? buildAgent.permission : undefined, session: nativeRoot.permission })
    const fullPluginWasLoaded = Array.isArray(loadedAgents) && loadedAgents.some((agent) => isRecord(agent)
      && agent.name === "opencode-debate-auto-alpha")
      && Array.isArray(loadedCommands) && loadedCommands.some((command) => isRecord(command)
        && command.name === "debate-auto")
    assert.equal(fullPluginWasLoaded, true, "the imported full plugin must register its private agents and command")

    const control = async (arguments_: string): Promise<RecordValue> => {
      const output = responseData<RecordValue>(await client.session.command({
        path: { id: ownerID! }, query: { directory: projectDirectory }, body: { command: "debate-auto", arguments: arguments_ },
      }), `/${"debate-auto"} ${arguments_}`)
      return output
    }
    const promptRoot = async (marker: string, action?: ParentAction): Promise<RecordValue[]> => {
      if (action) actions.set(marker, action)
      const messageID = `msg_${randomUUID().replaceAll("-", "")}`
      const previousCount = observations.parentCalls.get(marker) ?? 0
      const dispatched = await client.session.promptAsync({
        path: { id: ownerID! }, query: { directory: projectDirectory }, body: {
          messageID, agent: "build", model: { providerID: "probe", modelID: "fake-model" },
          parts: [{ type: "text", text: marker }],
        },
      })
      assertNoError(dispatched, `main-agent prompt ${marker}`)
      return waitFor(`main-agent completion for ${marker}`, async () => {
        if ((observations.parentCalls.get(marker) ?? 0) < previousCount + (action ? 2 : 1)) return undefined
        if (await nativeStatus(client, projectDirectory, ownerID!) !== "idle") return undefined
        const messages = await nativeMessages(client, projectDirectory, ownerID!)
        return assistantFinished(messages, messageID) ? messages : undefined
      })
    }

    stage = "conversation control and first real discussion"
    await control("on")
    const alphaMessages = await promptRoot("TASK6_E2E_START_ALPHA", { action: "start", brief: ALPHA })
    const alphaID = startIDs(alphaMessages).at(-1)
    if (!alphaID) throw new Error("Actual auto_debate start result did not return alpha discussion ID"
      + `; provider calls=${JSON.stringify([...observations.parentCalls])}; tool calls=${JSON.stringify(observations.parentToolCalls)}`
      + `; native tool states=${JSON.stringify(toolParts(alphaMessages).map((part) => isRecord(part.state)
        ? { status: part.state.status, error: part.state.error } : { status: "missing" }))}`
      + `; extracted actions=${JSON.stringify(resultsFromMessages(alphaMessages).map((entry) => entry.action))}`
      + `; permissions=${permissionTrace}`)
    const enabledByConversationCommand = typeof alphaID === "string"
    const betaMessages = await promptRoot("TASK6_E2E_START_BETA", { action: "start", brief: BETA })
    const initialIDs = startIDs(betaMessages)
    const betaID = initialIDs.find((id) => id !== alphaID)
    if (!betaID) throw new Error("Actual auto_debate start result did not return independent beta discussion ID")

    await waitFor("six held initial participant prompts", async () => observations.participantPrompts.length === 6 ? true : undefined)
    const initialPrompts = [...observations.participantPrompts]
    const alphaFirst = initialPrompts.filter((prompt) => prompt.discussionID === alphaID)
    const betaFirst = initialPrompts.filter((prompt) => prompt.discussionID === betaID)
    const alphaSessions = alphaFirst.map((prompt) => prompt.sessionID).sort()
    const betaSessions = betaFirst.map((prompt) => prompt.sessionID).sort()
    const twoDiscussionsWereIndependent = alphaFirst.length === 3 && betaFirst.length === 3
      && new Set([...alphaSessions, ...betaSessions]).size === 6
      && alphaFirst.every((prompt) => containsOnlyDiscussion(prompt, ALPHA, "TASK6_BETA_"))
      && betaFirst.every((prompt) => containsOnlyDiscussion(prompt, BETA, "TASK6_ALPHA_"))
      && alphaFirst.every((prompt) => prompt.cycle === 1 && prompt.round === 1)
      && betaFirst.every((prompt) => prompt.cycle === 1 && prompt.round === 1)
    assert.equal(twoDiscussionsWereIndependent, true, "all three real participant prompts must include only their own meaningful brief")

    stage = "independent parent work with busy panels"
    const workMessages = await promptRoot("TASK6_E2E_INDEPENDENT_WORK")
      const workAssistant = workMessages.find((message) => isRecord(message.info) && message.info.role === "assistant"
      && Array.isArray(message.parts) && message.parts.some((part) => isRecord(part) && part.type === "text"
        && typeof part.text === "string" && /independent/iu.test(part.text)))
    const statusSnapshot = responseData<unknown>(await client.session.status({ query: { directory: projectDirectory } }), "busy panel snapshot")
    const parentCompletedIndependentWorkWhileBothPanelsWereBusy = !!workAssistant && isRecord(statusSnapshot)
      && [...alphaSessions, ...betaSessions].every((id) => isRecord(statusSnapshot[id]) && statusSnapshot[id].type === "busy")
    assert.equal(parentCompletedIndependentWorkWhileBothPanelsWereBusy, true,
      "the main agent must finish independent work while both real participant panels remain busy")

    stage = "off and complete both original cycles"
    const offResponse = await control("off")
    const blockedStartMessages = await promptRoot("TASK6_E2E_START_WHILE_OFF", {
      action: "start", brief: { ...ALPHA, question: "TASK6_OFF_SHOULD_NOT_START: new work is disabled." },
    })
    const blockedStartRejected = toolParts(blockedStartMessages).some((part) => isRecord(part.state)
      && part.state.status === "error" && /automatic debate is disabled/iu.test(JSON.stringify(part.state)))
    const offWasEffective = blockedStartRejected && observations.participantPrompts.length === 6
    firstRoundRelease.release()
    await waitFor("both saved cycle-one transcript outcomes", async () => {
      const paths = [alphaID, betaID].map((id) => join(projectDirectory, "docs", "debates", `auto-${id}.md`))
      const transcripts = await Promise.all(paths.map((path) => readFile(path, "utf8").catch(() => "")))
      return transcripts.every((text) => text.includes("**Status:** awaiting-evaluation")) ? true : undefined
    })
    await waitFor("two complete cycle-one panels after off", async () => {
      const requests = observations.participantPrompts
      return requests.length === 12 && requests.filter((prompt) => prompt.cycle === 1 && prompt.round === 2).length === 6
        ? true : undefined
    })
    const cycleOnePrompts = [...observations.participantPrompts]
    const noCrossDiscussionMixup = [
      { id: alphaID, brief: ALPHA, foreignID: betaID, foreignMarker: "TASK6_BETA_" },
      { id: betaID, brief: BETA, foreignID: alphaID, foreignMarker: "TASK6_ALPHA_" },
    ].every(({ id, brief, foreignID, foreignMarker }) => cycleOnePrompts.filter((prompt) => prompt.discussionID === id
      && prompt.cycle === 1 && prompt.round === 2).length === 3
      && cycleOnePrompts.filter((prompt) => prompt.discussionID === id && prompt.cycle === 1 && prompt.round === 2)
        .every((prompt) => prompt.text.includes(String(brief.question))
          && prompt.text.includes(`TASK6_NATIVE_TURN ${id} cycle 1 round 1`)
          && !prompt.text.includes(foreignID) && !prompt.text.includes(foreignMarker)))
    const cycleOneComplete = [alphaID, betaID].every((id) => {
      const prompts = cycleOnePrompts.filter((prompt) => prompt.discussionID === id)
      return prompts.length === 6 && prompts.filter((prompt) => prompt.round === 1).length === 3
        && prompts.filter((prompt) => prompt.round === 2).length === 3
    })
    assert.equal(noCrossDiscussionMixup, true, "round-two peer submissions must contain only the matching discussion's original findings")
    const cycleOneMessages = await promptRoot("TASK6_E2E_STATUS_CYCLE_ONE", { action: "status" })
    const cycleOneSummaries = discussionSummaries(cycleOneMessages)
    const cycleOneResults = new Map(cycleOneSummaries.filter((summary) => [alphaID, betaID].includes(String(summary.id)))
      .map((summary) => [String(summary.id), summary]))
    const bothAwaitEvaluation = statusOf(cycleOneResults.get(alphaID)) === "awaiting-evaluation"
      && statusOf(cycleOneResults.get(betaID)) === "awaiting-evaluation"
      && [alphaID, betaID].every((id) => {
        const result = cycleOneResults.get(id)?.result
        return isRecord(result) && result.status === "complete" && result.reason === "unanimous-stop"
          && result.rounds === 2 && result.consensus === false
      })
    const offAllowedBothExistingCyclesToFinish = offWasEffective && cycleOneComplete && bothAwaitEvaluation
    assert.equal(offAllowedBothExistingCyclesToFinish, true,
      `off blocks new starts but allows both existing cycles to finish (off=${offWasEffective}, rounds=${JSON.stringify(
        [alphaID, betaID].map((id) => cycleOnePrompts.filter((prompt) => prompt.discussionID === id)
          .map(({ cycle, round }) => `${cycle}.${round}`))
      )}, summaries=${JSON.stringify(cycleOneSummaries.map(({ id, status, result }) => ({ id, status, result })))}, off-command-keys=${JSON.stringify(Object.keys(offResponse))})`)

    stage = "evaluate and resume the original alpha panel"
    const evaluatedFirst = await promptRoot("TASK6_E2E_EVALUATE_ALPHA", {
      action: "evaluate", discussion_id: alphaID,
      evaluation: { cycle: 1, conclusion: "Continue only the alpha panel for changed evidence.", caveats: ["The workload estimate is not independently measured."],
        rationale: "A focused check of restart recovery can resolve the stated uncertainty.", next: "continue" },
    })
    assert.ok(discussionSummaries(evaluatedFirst).some((summary) => summary.id === alphaID && statusOf(summary) === "paused"))

    const resumedMessages = await promptRoot("TASK6_E2E_RESUME_ALPHA", { action: "resume", discussion_id: alphaID, feedback: ALPHA_FEEDBACK })
    assert.ok(discussionSummaries(resumedMessages).some((summary) => summary.id === alphaID && summary.cycle === 2))
    await waitFor("resumed alpha prompts", async () => observations.participantPrompts.filter((prompt) => prompt.discussionID === alphaID
      && prompt.cycle === 2 && prompt.round === 1).length === 3 ? true : undefined)
    const resumedPrompts = observations.participantPrompts.filter((prompt) => prompt.discussionID === alphaID && prompt.cycle === 2)
    const resumedPanelRetainedAllSessionIDsAndFocusedFeedback = resumedPrompts.length === 3
      && JSON.stringify(resumedPrompts.map((prompt) => prompt.sessionID).sort()) === JSON.stringify(alphaSessions)
      && resumedPrompts.every((prompt) => prompt.text.includes(ALPHA_FEEDBACK)
        && containsOnlyDiscussion(prompt, ALPHA, "TASK6_BETA_"))
      && new Set(resumedPrompts.map((prompt) => prompt.discussionID)).size === 1
    assert.equal(resumedPanelRetainedAllSessionIDsAndFocusedFeedback, true,
      "resumption must use the same three native session IDs, original brief, and specific feedback")

    await waitFor("resumed alpha cycle reaches evaluation", async () => {
      const latest = observations.participantPrompts.filter((prompt) => prompt.discussionID === alphaID && prompt.cycle === 2)
      if (latest.length !== 3 || latest.some((prompt) => prompt.round !== 1)) return undefined
      const busy = await nativeStatus(client, projectDirectory, alphaSessions[0])
      return busy === "idle" ? true : undefined
    })
    stage = "cancel the independent beta discussion"
    const cancelledMessages = await promptRoot("TASK6_E2E_CANCEL_BETA", {
      action: "cancel", discussion_id: betaID, reason: "explicit-stop",
    })
    const summariesAfterCancel = discussionSummaries(cancelledMessages)
    const cancelledOtherDiscussionWithoutAffectingResume = summariesAfterCancel.some((summary) => summary.id === betaID
      && statusOf(summary) === "cancelled")
      && observations.participantPrompts.filter((prompt) => prompt.discussionID === betaID && prompt.cycle > 1).length === 0
      && observations.participantPrompts.filter((prompt) => prompt.discussionID === alphaID && prompt.cycle === 2).length === 3
    assert.equal(cancelledOtherDiscussionWithoutAffectingResume, true, "explicit cancellation must stop only the other discussion")

    const evaluatedSecond = await promptRoot("TASK6_E2E_EVALUATE_ALPHA_CYCLE_TWO", {
      action: "evaluate", discussion_id: alphaID,
      evaluation: { cycle: 2, conclusion: "Use bounded LRU for this workload, subject to the stated stale-window check.",
        caveats: ["Validate the load estimate before deployment."], rationale: "The focused follow-up addressed the restart trade-off.", next: "act" },
    })
    const mainAgentEvaluatedBothCycles = discussionSummaries(evaluatedFirst).some((summary) => summary.id === alphaID)
      && discussionSummaries(evaluatedSecond).some((summary) => summary.id === alphaID && statusOf(summary) === "resolved")

    stage = "main-agent transcript links and Markdown records"
    const reportMessages = await promptRoot("TASK6_E2E_REPORT_LINKS", { action: "status" })
    const transcriptPaths = pathsInToolResults(toolParts(reportMessages))
    const transcriptDirectory = join(projectDirectory, "docs", "debates")
    const alphaTranscriptPath = join(projectDirectory, "docs", "debates", `auto-${alphaID}.md`)
    const betaTranscriptPath = join(projectDirectory, "docs", "debates", `auto-${betaID}.md`)
    const [alphaTranscript, betaTranscript] = await Promise.all([readFile(alphaTranscriptPath, "utf8"), readFile(betaTranscriptPath, "utf8")])
    const transcriptEntries = await readdir(transcriptDirectory)
    const transcriptLinksWereReturnedAndRecordsWereSaved = observations.reportPaths.length === 2
      && transcriptPaths.length === 2
      && transcriptPaths.includes(`docs/debates/auto-${alphaID}.md`)
      && transcriptPaths.includes(`docs/debates/auto-${betaID}.md`)
      && reportMessages.some((message) => Array.isArray(message.parts) && message.parts.some((part) => isRecord(part)
        && part.type === "text" && typeof part.text === "string"
        && part.text.includes(`docs/debates/auto-${alphaID}.md`) && part.text.includes(`docs/debates/auto-${betaID}.md`)))
      && alphaTranscript.includes(ALPHA_FEEDBACK)
      && alphaTranscript.includes("Main-agent evaluation")
      && alphaTranscript.includes("Cycle 2")
      && alphaTranscript.includes("**Rounds completed:** 2")
      && alphaTranscript.includes("**Rounds completed:** 1")
      && alphaTranscript.includes("**Consensus:** No")
      && alphaTranscript.includes("resolved")
      && betaTranscript.includes("cancelled")
      && betaTranscript.includes("TASK6_BETA_DECISION")
      && !alphaTranscript.includes("TASK6_BETA_") && !betaTranscript.includes("TASK6_ALPHA_")
      && !transcriptEntries.some((entry) => entry === `auto-${alphaID}.html` || entry === `auto-${betaID}.html`)
      && (await realpath(transcriptDirectory)).startsWith(`${workspace}/`)
    assert.equal(transcriptLinksWereReturnedAndRecordsWereSaved, true,
      "the parent must return both actual Markdown transcript links and each append-only record must retain only its own discussion")

    stage = "reset conversation override"
    const resetResponse = await control("reset")
    const afterResetMessages = await promptRoot("TASK6_E2E_START_AFTER_RESET", {
      action: "start", brief: { ...BETA, question: "TASK6_RESET_SHOULD_RESTORE_DISABLED_DEFAULT: no new work." },
    })
    const startRejectedAfterReset = toolParts(afterResetMessages).some((part) => isRecord(part.state)
      && part.state.status === "error" && /automatic debate is disabled/iu.test(JSON.stringify(part.state)))
    const resetRestoredConfiguredDefault = startRejectedAfterReset && observations.participantPrompts.length === 15
    assert.equal(resetRestoredConfiguredDefault, true, "reset restores the configured disabled default")

    assert.deepEqual(observations.providerErrors, [], "the loopback fake provider must not report unhandled requests")
    assert.deepEqual(observations.parentToolCalls, ["TASK6_E2E_START_ALPHA", "TASK6_E2E_START_BETA", "TASK6_E2E_START_WHILE_OFF",
      "TASK6_E2E_STATUS_CYCLE_ONE", "TASK6_E2E_EVALUATE_ALPHA", "TASK6_E2E_RESUME_ALPHA", "TASK6_E2E_CANCEL_BETA",
      "TASK6_E2E_EVALUATE_ALPHA_CYCLE_TWO", "TASK6_E2E_REPORT_LINKS", "TASK6_E2E_START_AFTER_RESET"])
    assert.equal(observations.participantPrompts.length, 15)
    assert.equal(new Set(observations.participantPrompts.map((prompt) => prompt.sessionID)).size, 6)

    const observation: Task6Observation = {
      fullPluginWasLoaded,
      enabledByConversationCommand,
      twoDiscussionsWereIndependent,
      noCrossDiscussionMixup,
      unanimousStopWasNotConsensus: bothAwaitEvaluation,
      parentCompletedIndependentWorkWhileBothPanelsWereBusy,
      offAllowedBothExistingCyclesToFinish,
      resumedPanelRetainedAllSessionIDsAndFocusedFeedback,
      cancelledOtherDiscussionWithoutAffectingResume,
      mainAgentEvaluatedBothCycles,
      transcriptLinksWereReturnedAndRecordsWereSaved,
      resetRestoredConfiguredDefault,
      panelPromptCount: observations.participantPrompts.length,
      uniqueParticipantSessions: new Set(observations.participantPrompts.map((prompt) => prompt.sessionID)).size,
      transcriptPaths: [`docs/debates/auto-${alphaID}.md`, `docs/debates/auto-${betaID}.md`],
      discussionIDs: { alpha: alphaID, beta: betaID },
      participantSessionIDs: { alpha: alphaSessions, beta: betaSessions },
      providerRequests: [...observations.parentCalls.values()].reduce((total, count) => total + count, 0)
        + observations.participantPrompts.length,
    }
    result = { observation, version }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown native fixture failure"
    const lastRequests = nativeRequests.slice(-8).map(({ method, route, status }) => `${method} ${route}${status ? `=${status}` : ""}`).join(", ")
    const apiFailures = nativeApiFailures.slice(-4).join(" | ")
    const diagnostics = nativeDiagnostics.slice(-6).join(" | ")
    const fixtureEvents = await readFile(eventsPath, "utf8").catch(() => "")
    const fakeErrors = observations.providerErrors.slice(-4).join(" | ")
    const unrecognized = JSON.stringify(observations.unrecognizedRequests.slice(-4))
    throw new Error(`Task 6 native acceptance failed during ${stage}: ${message}`
      + `${lastRequests ? `; native HTTP=${lastRequests}` : ""}${apiFailures ? `; native errors=${apiFailures}` : ""}`
      + `${fakeErrors ? `; fake-provider=${fakeErrors}` : ""}${diagnostics ? `; native server=${diagnostics}` : ""}`
      + `${unrecognized !== "[]" ? `; unrecognised=${unrecognized}` : ""}`
      + `${fixtureEvents ? `; plugin-events=${fixtureEvents.replaceAll("\\n", " ").slice(-1000)}` : ""}`, { cause: error })
  } finally {
    firstRoundRelease.release()
    if (nativeProcess) await stopServer(nativeProcess)
    if (providerServerStarted) {
      provider.closeAllConnections()
      await new Promise<void>((resolvePromise) => provider.close(() => resolvePromise()))
    }
    await rm(workspace, { recursive: true, force: true })
    workspaceRemoved = true
    if (result) result.cleanup = { nativeProcessesExited: nativeProcesses.every((child) => child.exitCode !== null || child.signalCode !== null),
      isolatedWorkspaceRemoved: workspaceRemoved }
    if (result && options.evidencePath) {
      const evidence = {
        task: "Task 6 full-plugin native acceptance scenario",
        nativeOpenCodeVersion: result.version,
        nodeVersion: process.version,
        pluginEntry: "Imported repository index.ts createServer; actual native main-agent auto_debate tool calls",
        provider: "Loopback-only deterministic OpenAI-compatible fake; no real model calls or credentials",
        observation: result.observation,
        cleanup: { nativeProcessesExited: nativeProcesses.every((child) => child.exitCode !== null || child.signalCode !== null),
          isolatedWorkspaceRemoved: workspaceRemoved },
      }
      await writeFile(options.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    }
  }
}

export async function runAutomaticDebateNativeFixRegressions(options: { corrective?: boolean; evidencePath?: string } = {}): Promise<NativeFixResult> {
  if (options.evidencePath && dirname(resolve(options.evidencePath)) !== resolve(".superpowers/sdd/2026-10-09-automatic-debate")) {
    throw new Error("Corrective evidence must remain in its exclusive automatic-debate evidence directory")
  }
  const workspace = await mkdtemp(options.corrective ? "/tmp/opencode/corrective-pass-native-" : "/tmp/opencode/final-fix-full-plugin-")
  const projectDirectory = join(workspace, "project")
  const pluginDirectory = join(projectDirectory, ".opencode", "plugins")
  const paths = { home: join(workspace, "home"), xdgConfig: join(workspace, "xdg-config"), xdgData: join(workspace, "xdg-data"),
    xdgCache: join(workspace, "xdg-cache"), xdgState: join(workspace, "xdg-state"), temporary: join(workspace, "tmp"),
    events: join(workspace, "events.jsonl") }
  const providerPort = await freePort()
  const serverPort = await freePort()
  const providerURL = `http://127.0.0.1:${providerPort}`
  const ownerIDs = new Set<string>()
  const actions = new Map<string, ParentAction>()
  const observations = { parentCalls: new Map<string, number>(), parentToolCalls: [] as string[],
    participantPrompts: [] as ParticipantPrompt[], providerErrors: [] as string[],
    unrecognizedRequests: [] as { sessionID: string; promptPrefix: string; messageRoles: string[] }[], reportPaths: [] as string[] }
  let nativeProcess: ChildProcess | undefined
  let provider: ReturnType<typeof providerServer> | undefined
  let stage = "isolated enabled-YAML setup"
  let result: NativeFixResult | undefined
  const diagnostics: string[] = []
  const gate = () => {
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    return { promise, release }
  }
  const roundGates = new Map<string, ReturnType<typeof gate>>()
  let abortGate: { sessions: Set<string>; held?: string; entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined
  let corrective: NativeFixResult["corrective"]
  try {
    await Promise.all([projectDirectory, pluginDirectory, ...Object.values(paths).filter((path) => path !== paths.events),
      join(workspace, "managed-config")].map((path) => mkdir(path, { recursive: true })))
    const yamlPath = join(projectDirectory, "config.yaml")
    const yaml = `version: 2\nparticipants:\n  alpha:\n    model: probe/fake-model\n  beta:\n    model: probe/fake-model\n  gamma:\n    model: probe/fake-model\nsets:\n  default:\n    participants: [alpha, beta, gamma]\nauto_debate:\n  enabled: true\n  max_rounds: 3\n  persist_transcripts: true\n`
    await writeFile(yamlPath, yaml, { flag: "wx" })
    const pluginURL = new URL("../../index.ts", import.meta.url).href
    const participantsURL = new URL("../../src/participants.ts", import.meta.url).href
    await writeFile(join(pluginDirectory, "full-plugin.js"), `import { appendFileSync } from "node:fs";
import { createServer } from ${JSON.stringify(pluginURL)};
import { loadEffectiveRegistry } from ${JSON.stringify(participantsURL)};
const yaml = ${JSON.stringify(yamlPath)};
export default async function(input, options) {
  const record = (type) => appendFileSync(process.env.OPENCODE_DEBATE_PROBE_EVENTS, JSON.stringify({ type }) + "\\n");
  record("final-fix-plugin-entry");
  const hooks = await createServer(() => loadEffectiveRegistry({ packagedPath: yaml, userPath: yaml }))(input, options);
  record("final-fix-hooks-ready");
  const config = hooks.config;
  if (config) hooks.config = async (value) => { record("final-fix-config-start"); try { await config(value); } finally { record("final-fix-config-end"); } };
  const event = hooks.event;
  hooks.event = async (input) => {
    const e = input.event;
    if (e.type.startsWith("permission.")) appendFileSync(process.env.OPENCODE_DEBATE_PROBE_EVENTS, JSON.stringify(e) + "\\n");
    if (event) await event(input);
  };
  ${options.corrective ? `const abort = input.client.session.abort.bind(input.client.session);
  input.client.session.abort = async (request) => {
    const response = await fetch(${JSON.stringify(providerURL)} + "/corrective-abort?session=" + encodeURIComponent(request.path.id));
    if (!response.ok) throw new Error("Corrective native abort barrier failed");
    await response.json();
    return abort(request);
  };` : ""}
  return hooks;
}\n`, { flag: "wx" })
    await writeFile(join(projectDirectory, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json", model: "probe/fake-model", small_model: "probe/fake-model",
      autoupdate: false, share: "disabled", enabled_providers: ["probe"],
      provider: { probe: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `${providerURL}/v1`, apiKey: "not-a-real-credential" },
        models: { "fake-model": { name: "Final fix loopback fake", limit: { context: 32_000, output: 2_048 } } } } },
      agent: {
        "approval-main": { mode: "primary", permission: { "auto_*": { "*": "allow", start: "ask" } } },
        "denial-main": { mode: "primary", permission: { auto_debate: { "*": "allow", "start *": "deny" } } },
      },
    }), { flag: "wx" })
    const environment = isolatedEnvironment(paths)
    const binary = environment.OPENCODE_BIN ?? "opencode"
    execFileSync("git", ["init", "--quiet"], { cwd: projectDirectory, env: environment, timeout: 10_000 })
    const version = execFileSync(binary, ["--version"], { cwd: projectDirectory, env: environment, encoding: "utf8", timeout: 10_000 }).trim()
    assert.equal(version, "1.18.35")
    provider = providerServer({ providerURL, ownerID: () => undefined, ownerIDs, holdFirstRound: Promise.resolve(), actions, observations,
      holdParticipant: async (prompt) => {
        if (!options.corrective || prompt.cycle !== 1 || prompt.round !== 1 || !prompt.text.includes("TASK6_CORRECTIVE_ACTIVE")) return
        const held = gate()
        roundGates.set(prompt.sessionID, held)
        await held.promise
      },
      holdAbort: async (sessionID) => {
        const held = abortGate
        if (!held?.sessions.has(sessionID)) return
        if (!held.held) { held.held = sessionID; held.entered.release() }
        await held.release.promise
      },
    })
    await new Promise<void>((resolve, reject) => { provider!.once("error", reject); provider!.listen(providerPort, "127.0.0.1", resolve) })
    nativeProcess = await startServer(binary, projectDirectory, serverPort, environment, diagnostics, true)
    const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${serverPort}`, fetch: (request) => fetch(request,
      { signal: AbortSignal.any([request.signal, AbortSignal.timeout(WAIT_MS)]) }) })
    stage = "native project identity and isolated dependency/config initialisation"
    await waitFor("final fix native project identity", async () => {
      try {
        const project = responseData<RecordValue>(await client.project.current({ query: { directory: projectDirectory } }), "final fix project load")
        return typeof project.id === "string" && resolve(String(project.worktree)) === resolve(projectDirectory) ? project : undefined
      } catch { return undefined }
    }, 60_000)
    const root = async (agent = "build", permission: unknown[] = []) => {
      const value = responseData<RecordValue>(await client.session.create({ query: { directory: projectDirectory }, body: {
        title: `Final fix ${agent}`, agent, model: { providerID: "probe", id: "fake-model" }, permission,
      } } as never), "final fix root create")
      assert.equal(typeof value.id, "string")
      ownerIDs.add(String(value.id))
      return { id: String(value.id), agent }
    }
    const children = async (id: string) => responseData<RecordValue[]>(await client.session.children({ path: { id },
      query: { directory: projectDirectory } }), "final fix children")
    const dispatch = async (owner: { id: string; agent: string }, marker: string, action: ParentAction) => {
      actions.set(marker, action)
      const messageID = `msg_${randomUUID().replaceAll("-", "")}`
      assertNoError(await client.session.promptAsync({ path: { id: owner.id }, query: { directory: projectDirectory }, body: {
        messageID, agent: owner.agent, model: { providerID: "probe", modelID: "fake-model" }, parts: [{ type: "text", text: marker }],
      } }), "final fix native prompt")
      return messageID
    }
    const finished = async (owner: { id: string }, messageID: string) => waitFor("final fix native tool termination", async () => {
      if (await nativeStatus(client, projectDirectory, owner.id) !== "idle") return undefined
      const messages = await nativeMessages(client, projectDirectory, owner.id)
      return messages.some((message) => isRecord(message.info) && message.info.parentID === messageID
        && isRecord(message.info.time) && typeof message.info.time.completed === "number") ? messages : undefined
    })
    const invoke = async (owner: { id: string; agent: string }, marker: string, action: ParentAction) => finished(owner, await dispatch(owner, marker, action))
    const toolError = (messages: RecordValue[]) => {
      const part = toolParts(messages).at(-1)
      assert.ok(part && isRecord(part.state) && part.state.status === "error", "the actual native tool must terminate with an error")
      return String(part.state.error)
    }
    const journal = async (id: string) => {
      const store = (await children(id)).find((child) => child.title === "Automatic debate recovery checkpoints v1")
      assert.ok(store, "native first-use admission must persist its non-running checkpoint child")
      const messages = await nativeMessages(client, projectDirectory, String(store.id))
      return messages.map((message) => {
        const text = String((message.parts as RecordValue[])[0].text)
        return JSON.parse(JSON.parse(text.slice(text.indexOf("\n") + 1)).payload) as RecordValue
      }).sort((left, right) => Number(left.revision) - Number(right.revision))
    }
    const checkAdmission = async (id: string, messages: RecordValue[]) => {
      const first = (await journal(id))[0]
      const entries = (first.runtimeProof as RecordValue).entries as RecordValue[]
      const proof = entries[0]
      const part = toolParts(messages)[0]
      assert.deepEqual(proof, { kind: "owner-invocation-admitted", messageID: part.messageID, callID: part.callID, partID: part.id })
      assert.deepEqual((first.state as RecordValue).discussions, [], "current invocation is sealed before participant admission")
      return true
    }

    stage = "first config-enabled native status without on"
    const statusOwner = await root()
    assert.deepEqual(await children(statusOwner.id), [])
    const statusMessages = await invoke(statusOwner, "TASK6_E2E_FIX_FIRST_STATUS", { action: "status" })
    const firstStatus = resultsFromMessages(statusMessages).at(-1)!
    assert.equal(firstStatus.action, "status")
    assert.deepEqual(firstStatus.discussions, [])
    const statusProof = await checkAdmission(statusOwner.id, statusMessages)
    assert.equal(observations.participantPrompts.length, 0)

    stage = "first config-enabled native start without on"
    const startOwner = await root()
    assert.deepEqual(await children(startOwner.id), [])
    const startMessages = await invoke(startOwner, "TASK6_E2E_FIX_FIRST_START", { action: "start", brief: ALPHA })
    const firstID = startIDs(startMessages)[0]
    assert.ok(firstID, `first native start failed: ${JSON.stringify(toolParts(startMessages).map((part) => part.state))}`)
    const startProof = await checkAdmission(startOwner.id, startMessages)
    const complete = async (id: string) => waitFor("final fix saved complete cycle", async () => {
      const text = await readFile(join(projectDirectory, "docs", "debates", `auto-${id}.md`), "utf8").catch(() => "")
      return text.includes("**Status:** awaiting-evaluation") ? true : undefined
    })
    await complete(firstID)
    assert.equal(observations.participantPrompts.filter((prompt) => prompt.discussionID === firstID).length, 6)

    stage = "actual native patterned ask rejected before any child or dispatch"
    const approvalOwner = await root("approval-main")
    const promptCountBeforeApproval = observations.participantPrompts.length
    const approvalMessageID = await dispatch(approvalOwner, "TASK6_E2E_FIX_REJECT_APPROVAL", { action: "start", brief: BETA })
    const permissionRequest = await waitFor("native auto_debate permission.asked event", async () => {
      const lines = (await readFile(paths.events, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordValue)
      const event = lines.find((event) => event.type === "permission.asked" && isRecord(event.properties)
        && event.properties.sessionID === approvalOwner.id && event.properties.permission === "auto_debate")
      return event && isRecord(event.properties) ? event.properties : undefined
    })
    assert.deepEqual(permissionRequest.patterns, ["start"])
    assert.deepEqual(permissionRequest.always, ["start"])
    assert.ok(isRecord(permissionRequest.tool) && typeof permissionRequest.tool.messageID === "string" && typeof permissionRequest.tool.callID === "string")
    assert.deepEqual(await children(approvalOwner.id), [])
    assert.equal(observations.participantPrompts.length, promptCountBeforeApproval)
    assertNoError(await client.postSessionIdPermissionsPermissionId({ path: { id: approvalOwner.id, permissionID: String(permissionRequest.id) },
      query: { directory: projectDirectory }, body: { response: "reject" } }), "native rejection")
    const rejectionMessages = await finished(approvalOwner, approvalMessageID)
    const rejectedToolError = toolError(rejectionMessages)
    assert.match(rejectedToolError, /reject|permission|denied/i)
    assert.deepEqual(await children(approvalOwner.id), [])
    assert.equal(observations.participantPrompts.length, promptCountBeforeApproval)

    stage = "native action-pattern denial and session wildcard denial"
    const deniedToolErrors: string[] = []
    for (const [index, deniedOwner] of [await root("denial-main"), await root("build", [
      { permission: "auto_*", pattern: "*", action: "allow" },
      { permission: "auto_?ebate", pattern: "start *", action: "deny" },
    ])].entries()) {
      const messages = await invoke(deniedOwner, `TASK6_E2E_FIX_DENIED_${index === 0 ? "AGENT" : "SESSION"}`, { action: "start", brief: BETA })
      const error = toolError(messages)
      assert.match(error, /denied|permission/i)
      deniedToolErrors.push(error)
      assert.deepEqual(await children(deniedOwner.id), [])
      assert.equal(observations.participantPrompts.length, promptCountBeforeApproval)
    }

    if (options.corrective) {
      stage = "same-conversation native refusal then approved first start"
      const messageID = await dispatch(approvalOwner, "TASK6_E2E_CORRECTIVE_APPROVE_REUSE", { action: "start", brief: BETA })
      const approvedPermissionRequest = await waitFor("second same-owner native permission request", async () => {
        const events = (await readFile(paths.events, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordValue)
        const event = events.find((event) => event.type === "permission.asked" && isRecord(event.properties)
          && event.properties.sessionID === approvalOwner.id && event.properties.permission === "auto_debate"
          && event.properties.id !== permissionRequest.id)
        return event && isRecord(event.properties) ? event.properties : undefined
      })
      assert.deepEqual(approvedPermissionRequest.patterns, ["start"])
      assert.deepEqual(await children(approvalOwner.id), [], "retained refusal proof creates no child before subsequent approval")
      assert.equal(observations.participantPrompts.length, promptCountBeforeApproval)
      assertNoError(await client.postSessionIdPermissionsPermissionId({ path: { id: approvalOwner.id, permissionID: String(approvedPermissionRequest.id) },
        query: { directory: projectDirectory }, body: { response: "once" } }), "native subsequent approval")
      const approvedMessages = await finished(approvalOwner, messageID)
      const approvedDiscussionID = startIDs(approvedMessages)[0]
      assert.ok(approvedDiscussionID, `approved reuse failed: ${JSON.stringify(toolParts(approvedMessages).map((part) => part.state))}`)
      await complete(approvedDiscussionID)
      assert.equal(observations.participantPrompts.filter((prompt) => prompt.discussionID === approvedDiscussionID).length, 6)
      assert.equal((await children(approvalOwner.id)).length, 4, "one checkpoint and original three participants are admitted only after approval")
      corrective = { refusalThenApproved: true, approvalOwnerID: approvalOwner.id, approvedDiscussionID, approvedPermissionRequest, batches: [] }
    }

    stage = "sequential two-owned user stop all with other-owner scope"
    const pause = async (owner: { id: string; agent: string }, id: string, marker: string) => {
      const messages = await invoke(owner, marker, { action: "evaluate", discussion_id: id, evaluation: {
        cycle: 1, conclusion: "Retain for a focused follow-up", caveats: [], rationale: "The unresolved assumption needs verification", next: "continue",
      } })
      assert.equal(statusOf(discussionSummaries(messages).find((summary) => summary.id === id)), "paused")
    }
    await pause(startOwner, firstID, "TASK6_E2E_FIX_PAUSE_FIRST")
    const secondMessages = await invoke(startOwner, "TASK6_E2E_FIX_SECOND_OWNED", { action: "start", brief: BETA })
    const secondID = startIDs(secondMessages).find((id) => id !== firstID)!
    assert.ok(secondID)
    await complete(secondID)
    await pause(startOwner, secondID, "TASK6_E2E_FIX_PAUSE_SECOND")
    const foreignMessages = await invoke(statusOwner, "TASK6_E2E_FIX_FOREIGN_START", { action: "start", brief: ALPHA })
    const foreignID = startIDs(foreignMessages)[0]
    assert.ok(foreignID)
    await complete(foreignID)
    const ownedSessionIDs = observations.participantPrompts.filter((prompt) => [firstID, secondID].includes(prompt.discussionID))
      .map((prompt) => prompt.sessionID).filter((id, index, values) => values.indexOf(id) === index).sort()
    const foreignSessionIDs = [...new Set(observations.participantPrompts.filter((prompt) => prompt.discussionID === foreignID).map((prompt) => prompt.sessionID))]
    const foreignHistoryBefore = await Promise.all(foreignSessionIDs.map((id) => nativeMessages(client, projectDirectory, id)))
    responseData<RecordValue>(await client.session.command({ path: { id: startOwner.id }, query: { directory: projectDirectory },
      body: { command: "debate-auto", arguments: "stop all" } }), "native user stop all")
    const commandMessages = await nativeMessages(client, projectDirectory, startOwner.id)
    assert.ok(commandMessages.some((message) => isRecord(message.info) && message.info.role === "user"
      && Array.isArray(message.parts) && message.parts.some((part) => isRecord(part) && part.type === "text"
        && typeof part.text === "string" && part.text.includes(`${firstID}: cancelled`) && part.text.includes(`${secondID}: cancelled`))))
    const stoppedMessages = await invoke(startOwner, "TASK6_E2E_FIX_STOPPED_STATUS", { action: "status" })
    const summaries = discussionSummaries(stoppedMessages).filter((summary) => [firstID, secondID].includes(String(summary.id)))
    assert.equal(summaries.length, 2)
    assert.ok(summaries.every((summary) => summary.status === "cancelled" && isRecord(summary.cancellation)
      && summary.cancellation.confirmed === true && summary.unconfirmedCancellation === undefined))
    const head = (await journal(startOwner.id)).at(-1)!
    const entries = (head.runtimeProof as RecordValue).entries as RecordValue[]
    const confirmedStopSessionIDs = entries.filter((entry) => entry.kind === "participant-stop-confirmed").map((entry) => String(entry.sessionID)).sort()
    assert.deepEqual(confirmedStopSessionIDs, ownedSessionIDs, "cessation is receipt-proven, not an abort ACK or missing activity")
    assert.deepEqual(entries.filter((entry) => entry.kind === "participant-fenced").map((entry) => String(entry.sessionID)).sort(), ownedSessionIDs)
    const state = head.state as RecordValue
    assert.ok((state.discussions as RecordValue[]).every((discussion) => discussion.status === "cancelled" && discussion.generation === 1))
    for (const id of ownedSessionIDs) {
      const messages = await nativeMessages(client, projectDirectory, id)
      assert.ok(messages.filter((message) => isRecord(message.info) && message.info.role === "assistant").every((message) =>
        isRecord(message.info) && isRecord(message.info.time) && typeof message.info.time.completed === "number"))
    }
    const promptsAfterStop = observations.participantPrompts.length
    for (const [index, id] of [firstID, secondID].entries()) {
      const messages = await invoke(startOwner, `TASK6_E2E_FIX_RESUME_CANCELLED_${index === 0 ? "FIRST" : "SECOND"}`, {
        action: "resume", discussion_id: id, feedback: "Explicit user stop must win over this requested follow-up",
      })
      assert.match(toolError(messages), /cancelled/i)
      const transcript = await readFile(join(projectDirectory, "docs", "debates", `auto-${id}.md`), "utf8")
      assert.ok(transcript.includes("**Status:** cancelled") && transcript.includes("Main-agent evaluation"))
    }
    assert.equal(observations.participantPrompts.length, promptsAfterStop)
    const foreignStatus = await invoke(statusOwner, "TASK6_E2E_FIX_FOREIGN_STATUS", { action: "status", discussion_id: foreignID })
    assert.equal(statusOf(discussionSummaries(foreignStatus).find((summary) => summary.id === foreignID)), "awaiting-evaluation")
    assert.deepEqual(await Promise.all(foreignSessionIDs.map((id) => nativeMessages(client, projectDirectory, id))), foreignHistoryBefore)

    if (options.corrective) for (const mode of ["USER", "AGENT"] as const) {
      stage = `active ${mode.toLowerCase()} batch fences all generations while first-panel cessation is held`
      const activeOwner = await root()
      const ids: string[] = []
      for (const name of ["FIRST", "SECOND"]) {
        const messages = await invoke(activeOwner, `TASK6_E2E_CORRECTIVE_${mode}_START_${name}`, { action: "start", brief: {
          ...ALPHA, question: `TASK6_CORRECTIVE_ACTIVE_${mode}_${name}: stop the selected active panels`,
        } })
        const id = startIDs(messages).find((id) => !ids.includes(id))
        assert.ok(id)
        ids.push(id)
      }
      await waitFor("six already-dispatched held first-round calls", async () => observations.participantPrompts
        .filter((prompt) => ids.includes(prompt.discussionID)).length === 6 ? true : undefined)
      const before = (await journal(activeOwner.id)).at(-1)!
      const discussions = (before.state as RecordValue).discussions as RecordValue[]
      assert.ok(discussions.every((discussion) => discussion.status === "running" && discussion.generation === 0))
      const firstSessions = (discussions[0].panel as RecordValue[]).map((member) => String(member.sessionID))
      const secondSessions = (discussions[1].panel as RecordValue[]).map((member) => String(member.sessionID))
      assert.equal(firstSessions.length, 3)
      assert.equal(secondSessions.length, 3)
      abortGate = { sessions: new Set(firstSessions), entered: gate(), release: gate() }
      const held = abortGate
      const reason = mode === "USER" ? "explicit-stop" : "obsolete"
      let stopSettled = false
      const messageID = mode === "AGENT" ? await dispatch(activeOwner, "TASK6_E2E_CORRECTIVE_AGENT_CANCEL_ALL", {
        action: "cancel", discussion_id: "all", reason,
      }) : undefined
      const stopping = (mode === "USER" ? client.session.command({ path: { id: activeOwner.id }, query: { directory: projectDirectory },
        body: { command: "debate-auto", arguments: "stop all" } }) : finished(activeOwner, messageID!))
        .then((value) => { stopSettled = true; return value })
      void stopping.catch(() => undefined)
      try {
        await waitFor("held first-panel native abort request", async () => held.held ? true : undefined)
        const pending = (await journal(activeOwner.id)).at(-1)!
        const pendingDiscussions = (pending.state as RecordValue).discussions as RecordValue[]
        assert.ok(pendingDiscussions.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1
          && (discussion.results as RecordValue[]).at(-1)?.reason === reason), "every selected panel must be durably fenced before first cessation")
        assert.ok(pendingDiscussions.some((discussion) => (discussion.cancellation as RecordValue).pendingSessionIDs
          && ((discussion.cancellation as RecordValue).pendingSessionIDs as string[]).includes(held.held!)))
        assert.equal(stopSettled, false)
        for (const id of secondSessions) roundGates.get(id)!.release()
        await waitFor("other panel's native terminal first-round answers and durable startup closures", async () => {
          const rows = await Promise.all(secondSessions.map((id) => nativeMessages(client, projectDirectory, id)))
          if (!rows.every((messages) => messages.some((message) => isRecord(message.info) && message.info.role === "assistant"
            && isRecord(message.info.time) && typeof message.info.time.completed === "number"
            && Array.isArray(message.parts) && message.parts.some((part) => isRecord(part) && part.type === "text"
              && typeof part.text === "string" && part.text.includes("TASK6_NATIVE_TURN"))))) return undefined
          const entries = ((await journal(activeOwner.id)).at(-1)!.runtimeProof as RecordValue).entries as RecordValue[]
          return secondSessions.every((id) => entries.some((entry) => entry.kind === "participant-start-closed" && entry.sessionID === id))
            ? true : undefined
        })
        const whileHeld = (await journal(activeOwner.id)).at(-1)!
        const stillCancelled = (whileHeld.state as RecordValue).discussions as RecordValue[]
        assert.ok(stillCancelled.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1))
        assert.equal(observations.participantPrompts.filter((prompt) => ids.includes(prompt.discussionID)).length, 6,
          "no round two after the other panel's real native first-round completion")
        assert.equal(stopSettled, false, "a local batch fence never implies held native cessation confirmation")
        const proof = (whileHeld.runtimeProof as RecordValue).entries as RecordValue[]
        assert.ok(!proof.some((entry) => entry.kind === "participant-stop-confirmed" && entry.sessionID === held.held))
        corrective!.batches.push({ mode, reason, discussionIDs: ids, heldSessionID: held.held,
          allFencedBeforeCessation: true, noNextRoundAfterTerminalAnswers: true, stopRemainedPending: true,
          pendingStates: pendingDiscussions.map(({ id, status, generation, cancellation }) => ({ id, status, generation, cancellation })),
          terminalAnswerSessionIDs: secondSessions })
      } finally {
        held.release.release()
        for (const id of firstSessions) roundGates.get(id)!.release()
        const output = await stopping
        if (mode === "USER") responseData(output, "corrective native user batch completion")
      }
      const settled = (await journal(activeOwner.id)).at(-1)!
      const settledDiscussions = (settled.state as RecordValue).discussions as RecordValue[]
      assert.ok(settledDiscussions.every((discussion) => discussion.status === "cancelled" && discussion.generation === 1
        && isRecord(discussion.cancellation) && (discussion.cancellation.pendingSessionIDs as string[]).length === 0
        && (discussion.cancellation.errors as string[]).length === 0 && (discussion.results as RecordValue[]).at(-1)?.reason === reason))
      const entries = (settled.runtimeProof as RecordValue).entries as RecordValue[]
      const confirmed = entries.filter((entry) => entry.kind === "participant-stop-confirmed").map((entry) => String(entry.sessionID)).sort()
      assert.deepEqual(confirmed, [...firstSessions, ...secondSessions].sort(), "all six cessations require durable verified receipts")
      corrective!.batches.at(-1)!.confirmedStopSessionIDs = confirmed
      for (const id of ids) {
        const transcript = await readFile(join(projectDirectory, "docs", "debates", `auto-${id}.md`), "utf8")
        assert.ok(transcript.includes("**Status:** cancelled") && transcript.includes(reason))
      }
      assert.equal(observations.participantPrompts.filter((prompt) => ids.includes(prompt.discussionID)).length, 6)
      assert.deepEqual(await Promise.all(foreignSessionIDs.map((id) => nativeMessages(client, projectDirectory, id))), foreignHistoryBefore)
      corrective!.batches.at(-1)!.otherOwnerUntouched = true
      abortGate = undefined
    }
    assert.equal(await readFile(yamlPath, "utf8"), yaml)
    assert.deepEqual(observations.providerErrors, [])
    result = { version, configEnabledFirstStart: true, configEnabledFirstStatus: true,
      currentInvocationProofPersisted: statusProof && startProof, nativeAskRejectedBeforeAnyChildOrDispatch: true,
      agentPatternedDenyPreventedDispatch: true, sessionWildcardPatternedDenyPreventedDispatch: true,
      userStopAllCancelledTwoOwnedDiscussions: true, userStopAllPreservedOtherOwner: true, stopAllHadDurableCessationProof: true,
      cancelledPanelsRejectedFurtherResume: true, yamlUnchanged: true, permissionRequest, rejectedToolError, deniedToolErrors,
      ownedDiscussionIDs: [firstID, secondID], ownedParticipantSessionIDs: ownedSessionIDs, confirmedStopSessionIDs,
      providerPanelPrompts: observations.participantPrompts.length,
      ...(corrective ? { corrective } : {}),
      cleanup: { nativeProcessesExited: false, isolatedWorkspaceRemoved: false } }
    return result
  } catch (error) {
    const events = await readFile(paths.events, "utf8").catch(() => "")
    const bootLogs: string[] = []
    for (const directory of [join(paths.xdgData, "opencode", "log"), join(paths.xdgState, "opencode", "log")]) {
      for (const name of await readdir(directory).catch(() => [])) {
        if (name.endsWith(".log")) bootLogs.push((await readFile(join(directory, name), "utf8")).slice(-6000))
      }
    }
    throw new Error(`Final fix native regressions failed during ${stage}: ${error instanceof Error ? error.message : String(error)}; native=${diagnostics.join(" | ")}; plugin-events=${events.slice(-1500)}; boot-logs=${bootLogs.join(" | ")}`,
      { cause: error })
  } finally {
    abortGate?.release.release()
    for (const held of roundGates.values()) held.release()
    if (nativeProcess) await stopServer(nativeProcess)
    if (provider) { provider.closeAllConnections(); await new Promise<void>((resolve) => provider!.close(() => resolve())) }
    await rm(workspace, { recursive: true, force: true })
    if (result) result.cleanup = { nativeProcessesExited: !!nativeProcess && (nativeProcess.exitCode !== null || nativeProcess.signalCode !== null),
      isolatedWorkspaceRemoved: true }
    if (result && options.evidencePath) await writeFile(options.evidencePath, `${JSON.stringify({
      task: "User-approved R1/R2 corrective pass: retained refusal/approval and active native batch stop",
      nativeOpenCodeVersion: result.version, nodeVersion: process.version, provider: "Loopback-only deterministic fake; no real model calls or credentials",
      observation: result,
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  }
}

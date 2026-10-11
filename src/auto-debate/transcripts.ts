import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Brief, CycleResult, Discussion, Evaluation, TranscriptCheckpointResult, Turn } from "./types.ts"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const STATUSES = ["running", "awaiting-evaluation", "paused", "resolved", "cancelled", "interrupted"] as const
const RESULT_STATUSES = ["complete", "partial", "cancelled", "interrupted"] as const
const RESULT_REASONS = ["unanimous-stop", "round-limit", "participant-failure", "explicit-stop", "obsolete", "shutdown"] as const
const EVALUATION_NEXT = ["act", "investigate", "continue", "report-unresolved"] as const
const directoryOpenFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fileWriteFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const fileAppendFlags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW

type StatIdentity = { dev: number; ino: number }
type TranscriptDirectories = {
  projectDirectory: string
  projectFD: number
  docsFD: number
  debatesFD: number
}
type UnknownRecord = Record<string, unknown>
type TranscriptEvent =
  | { kind: "brief"; brief: Brief }
  | { kind: "panel-heading" }
  | { kind: "panel"; index: number; agent: string; description: string }
  | { kind: "turn"; turn: Turn }
  | { kind: "followup"; cycle: number; index: number; feedback: string }
  | { kind: "cycle-result"; cycle: number; rounds: number; status: CycleResult["status"];
      reason: CycleResult["reason"]; consensus: boolean }
  | { kind: "evaluation"; evaluation: Evaluation }
  | { kind: "outcome"; status: Discussion["status"]; cycle: number; result?: CycleResult["status"];
      resultReason?: CycleResult["reason"]; roundsCompleted?: number; roundsWithTurns: number;
      evaluationRecorded: boolean; stateDigest: string }
type TranscriptLog = { events: TranscriptEvent[]; nextSequence: number }
type OpenTranscript = { descriptor: number; identity: StatIdentity; content: Buffer; log: TranscriptLog }

const discussionLocks = new Map<string, Promise<void>>()

function fail(message: string): never {
  throw new Error(`Automatic transcript ${message}`)
}

class TranscriptPathUnavailableError extends Error {
  constructor(message: string) {
    super(`Automatic transcript ${message}`)
    this.name = "TranscriptPathUnavailableError"
  }
}

function failPathUnavailable(message: string): never {
  throw new TranscriptPathUnavailableError(`destination path is unavailable: ${message}`)
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function isOneOf<T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
  return typeof value === "string" && choices.includes(value)
}

function assertAbsoluteProjectPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !isAbsolute(value) || value.split(sep).includes("..")) {
    fail("owner directory must be an absolute path without traversal components")
  }
}

function assertTurn(value: unknown, maxRounds: number): asserts value is Turn {
  if (!isRecord(value) || !nonEmptyString(value.participant)
    || !safeInteger(value.cycle, 1) || !safeInteger(value.round, 1) || value.round > maxRounds
    || typeof value.text !== "string"
    || value.consensus !== undefined && typeof value.consensus !== "boolean"
    || value.stop !== undefined && typeof value.stop !== "boolean") {
    fail("contains an invalid canonical turn")
  }
}

function assertEvaluation(value: unknown): asserts value is Evaluation {
  if (!isRecord(value) || !safeInteger(value.cycle, 1)
    || typeof value.conclusion !== "string"
    || !Array.isArray(value.caveats) || !value.caveats.every((item) => typeof item === "string")
    || typeof value.rationale !== "string"
    || !isOneOf(value.next, EVALUATION_NEXT)
    || value.feedback !== undefined && typeof value.feedback !== "string") {
    fail("contains an invalid main-agent evaluation")
  }
}

function assertDiscussion(value: Discussion): void {
  if (!isRecord(value)) fail("discussion fields are invalid or incomplete")
  if (typeof value.id !== "string" || !UUID_V4.test(value.id)) {
    fail("discussion ID must be a generated version-4 UUID")
  }
  if (!isRecord(value.owner) || !nonEmptyString(value.owner.sessionID) || !nonEmptyString(value.owner.agent)
    || !isRecord(value.config) || typeof value.config.persistTranscripts !== "boolean"
    || !safeInteger(value.config.maxRounds, 1)
    || !isRecord(value.brief) || !nonEmptyString(value.brief.question) || !nonEmptyString(value.brief.objective)
    || !Array.isArray(value.brief.facts) || !value.brief.facts.every((item) => typeof item === "string")
    || !Array.isArray(value.brief.assumptions) || !value.brief.assumptions.every((item) => typeof item === "string")
    || !Array.isArray(value.brief.constraints) || !value.brief.constraints.every((item) => typeof item === "string")
    || !Array.isArray(value.brief.alternatives) || !value.brief.alternatives.every((item) => typeof item === "string")
    || typeof value.brief.uncertainty !== "string" || !nonEmptyString(value.brief.neededOutcome)
    || !Array.isArray(value.panel)
    || !value.panel.every((member) => isRecord(member) && isRecord(member.participant)
      && nonEmptyString(member.participant.agent) && typeof member.participant.description === "string")
    || !isOneOf(value.status, STATUSES) || !safeInteger(value.cycle, 1)
    || !Array.isArray(value.results) || !Array.isArray(value.evaluations)
    || !Array.isArray(value.pendingTurns) || !Array.isArray(value.followups)) {
    fail("discussion fields are invalid or incomplete")
  }
  assertAbsoluteProjectPath(value.owner.directory)

  const resultCycles = new Set<number>()
  for (const result of value.results) {
    if (!isRecord(result) || !safeInteger(result.cycle, 1) || resultCycles.has(result.cycle)
      || result.cycle > value.cycle
      || !safeInteger(result.rounds, 0) || result.rounds > value.config.maxRounds
      || !isOneOf(result.status, RESULT_STATUSES) || !isOneOf(result.reason, RESULT_REASONS)
      || !Array.isArray(result.turns) || !Array.isArray(result.failures) || typeof result.consensus !== "boolean") {
      fail("contains an invalid cycle result")
    }
    resultCycles.add(result.cycle)
    for (const turn of result.turns) {
      assertTurn(turn, value.config.maxRounds)
      if (turn.cycle !== result.cycle) fail("cycle result contains a turn from another cycle")
    }
  }
  const evaluationCycles = new Set<number>()
  for (const evaluation of value.evaluations) {
    assertEvaluation(evaluation)
    if (evaluationCycles.has(evaluation.cycle) || evaluation.cycle > value.cycle) {
      fail("contains duplicate or future cycle evaluations")
    }
    evaluationCycles.add(evaluation.cycle)
  }
  for (const turn of value.pendingTurns) {
    assertTurn(turn, value.config.maxRounds)
    if (turn.cycle > value.cycle) fail("contains a pending turn from a future cycle")
  }
  for (const followup of value.followups) {
    if (!isRecord(followup) || !safeInteger(followup.cycle, 1) || followup.cycle > value.cycle
      || typeof followup.feedback !== "string") {
      fail("contains an invalid main-agent follow-up")
    }
  }
}

function ownerFingerprint(discussion: Discussion): string {
  return createHash("sha256")
    .update(JSON.stringify([discussion.owner.sessionID, discussion.owner.agent, resolve(discussion.owner.directory)]))
    .digest("hex")
}

function ownershipMarker(discussion: Discussion): string {
  return `<!-- opencode-debate-auto-transcript:v2 id=${discussion.id} owner=${ownerFingerprint(discussion)} -->`
}

function fenced(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  const body = value.endsWith("\n") ? value : `${value}\n`
  return `${fence}text\n${body}${fence}`
}

function contentBlock(label: string, value: string): string {
  return `**${label}:**\n\n${fenced(value)}`
}

function briefSection(title: string, values: readonly string[]): string {
  if (values.length === 0) return `### ${title}\n\nNone recorded.`
  return [`### ${title}`, ...values.map((value, index) => contentBlock(`${title.slice(0, -1)} ${index + 1}`, value))].join("\n\n")
}

function sortTurns(turns: readonly Turn[], panelOrder: ReadonlyMap<string, number>): Turn[] {
  return [...turns].sort((left, right) => left.round - right.round
    || (panelOrder.get(left.participant) ?? Number.MAX_SAFE_INTEGER)
      - (panelOrder.get(right.participant) ?? Number.MAX_SAFE_INTEGER)
    || left.participant.localeCompare(right.participant))
}

function transcriptHeader(discussion: Discussion): string {
  return `# Automatic debate\n\n**Discussion:** ${discussion.id}\n**Maximum rounds per cycle:** ${discussion.config.maxRounds}\n\n${ownershipMarker(discussion)}\n\n`
}

function turnKey(turn: Turn): string {
  return JSON.stringify([turn.cycle, turn.round, turn.participant])
}

function canonicalTurn(turn: Turn): Turn {
  return {
    participant: turn.participant,
    cycle: turn.cycle,
    round: turn.round,
    text: turn.text,
    ...(turn.consensus === undefined ? {} : { consensus: turn.consensus }),
    ...(turn.stop === undefined ? {} : { stop: turn.stop }),
  }
}

function canonicalEvaluation(evaluation: Evaluation): Evaluation {
  return {
    cycle: evaluation.cycle,
    conclusion: evaluation.conclusion,
    caveats: [...evaluation.caveats],
    rationale: evaluation.rationale,
    next: evaluation.next,
    ...(evaluation.feedback === undefined ? {} : { feedback: evaluation.feedback }),
  }
}

function eventKey(event: TranscriptEvent): string {
  switch (event.kind) {
    case "brief": return "brief"
    case "panel-heading": return "panel-heading"
    case "panel": return `panel:${event.index}`
    case "turn": return `turn:${turnKey(event.turn)}`
    case "followup": return `followup:${event.cycle}:${event.index}`
    case "cycle-result": return `cycle-result:${event.cycle}`
    case "evaluation": return `evaluation:${event.evaluation.cycle}`
    case "outcome": return `outcome:${event.stateDigest}`
  }
}

function eventCycle(event: TranscriptEvent): number | undefined {
  switch (event.kind) {
    case "brief":
    case "panel-heading":
    case "panel": return undefined
    case "turn": return event.turn.cycle
    case "followup":
    case "cycle-result":
    case "outcome": return event.cycle
    case "evaluation": return event.evaluation.cycle
  }
}

function eventDigest(event: TranscriptEvent): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex")
}

function transcriptEvents(discussion: Discussion): TranscriptEvent[] {
  const events: TranscriptEvent[] = [{ kind: "brief", brief: {
    question: discussion.brief.question,
    objective: discussion.brief.objective,
    facts: [...discussion.brief.facts],
    assumptions: [...discussion.brief.assumptions],
    constraints: [...discussion.brief.constraints],
    alternatives: [...discussion.brief.alternatives],
    uncertainty: discussion.brief.uncertainty,
    neededOutcome: discussion.brief.neededOutcome,
  } }]
  events.push({ kind: "panel-heading" })
  for (const [index, member] of discussion.panel.entries()) {
    events.push({ kind: "panel", index, agent: member.participant.agent, description: member.participant.description })
  }

  const panelOrder = new Map(discussion.panel.map((member, index) => [member.participant.agent, index]))
  const turnsByKey = new Map<string, Turn>()
  for (const result of discussion.results) for (const turn of result.turns) turnsByKey.set(turnKey(turn), canonicalTurn(turn))
  for (const turn of discussion.pendingTurns) {
    const key = turnKey(turn)
    const canonical = canonicalTurn(turn)
    const previous = turnsByKey.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(canonical)) fail("contains conflicting canonical turns for one participant slot")
    turnsByKey.set(key, canonical)
  }
  const turns = [...turnsByKey.values()]
  for (let cycle = 1; cycle <= discussion.cycle; cycle++) {
    for (const [index, followup] of discussion.followups.filter((item) => item.cycle === cycle).entries()) {
      events.push({ kind: "followup", cycle, index, feedback: followup.feedback })
    }
    for (const turn of sortTurns(turns.filter((item) => item.cycle === cycle), panelOrder)) {
      events.push({ kind: "turn", turn: canonicalTurn(turn) })
    }
    const result = discussion.results.find((item) => item.cycle === cycle)
    if (result) events.push({ kind: "cycle-result", cycle, rounds: result.rounds, status: result.status,
      reason: result.reason, consensus: result.consensus })
    const evaluation = discussion.evaluations.find((item) => item.cycle === cycle)
    if (evaluation) events.push({ kind: "evaluation", evaluation: canonicalEvaluation(evaluation) })
  }

  const currentResult = discussion.results.find((item) => item.cycle === discussion.cycle)
  const currentTurns = turns.filter((turn) => turn.cycle === discussion.cycle)
  const digest = stateDigest(events, discussion.status, discussion.cycle)
  events.push({ kind: "outcome", status: discussion.status, cycle: discussion.cycle,
    ...(currentResult === undefined ? {} : { result: currentResult.status, resultReason: currentResult.reason,
      roundsCompleted: currentResult.rounds }),
    roundsWithTurns: new Set(currentTurns.map((turn) => turn.round)).size,
    evaluationRecorded: discussion.evaluations.some((item) => item.cycle === discussion.cycle), stateDigest: digest })
  return events
}

function renderEvent(event: TranscriptEvent): string {
  switch (event.kind) {
    case "brief":
      return [
        "## Decision brief",
        contentBlock("Question", event.brief.question),
        contentBlock("Objective", event.brief.objective),
        briefSection("Facts", event.brief.facts),
        briefSection("Assumptions", event.brief.assumptions),
        briefSection("Constraints", event.brief.constraints),
        briefSection("Alternatives", event.brief.alternatives),
        contentBlock("Uncertainty", event.brief.uncertainty),
        contentBlock("Needed outcome", event.brief.neededOutcome),
      ].join("\n\n")
    case "panel-heading":
      return "## Panel"
    case "panel":
      return [
        `### Member ${event.index + 1}`,
        contentBlock("Participant", event.agent),
        contentBlock("Description", event.description),
      ].join("\n\n")
    case "turn":
      return [
        `## Cycle ${event.turn.cycle}`,
        `### Round ${event.turn.round}`,
        "#### Submission",
        contentBlock("Participant", event.turn.participant),
        `**Flags:** consensus=${event.turn.consensus === undefined ? "not supplied" : String(event.turn.consensus)}; stop=${event.turn.stop === undefined ? "not supplied" : String(event.turn.stop)}`,
        contentBlock("Canonical turn", event.turn.text),
      ].join("\n\n")
    case "followup":
      return [
        `## Cycle ${event.cycle}`,
        `### Main-agent follow-up ${event.index + 1}`,
        contentBlock("Feedback", event.feedback),
      ].join("\n\n")
    case "cycle-result":
      return [
        `## Cycle ${event.cycle}`,
        `**Cycle result:** ${event.status[0].toUpperCase()}${event.status.slice(1)} — ${event.reason}`,
        `**Rounds completed:** ${event.rounds}`,
        `**Consensus:** ${event.consensus ? "Yes" : "No"}`,
      ].join("\n\n")
    case "evaluation":
      return [
        `## Cycle ${event.evaluation.cycle}`,
        "### Main-agent evaluation",
        `**Next action:** ${event.evaluation.next}`,
        contentBlock("Conclusion", event.evaluation.conclusion),
        contentBlock("Rationale", event.evaluation.rationale),
        briefSection("Caveats", event.evaluation.caveats),
        ...(event.evaluation.feedback === undefined ? [] : [contentBlock("Evaluation feedback", event.evaluation.feedback)]),
      ].join("\n\n")
    case "outcome": {
      const currentResult = event.result
        ? `${event.result[0].toUpperCase()}${event.result.slice(1)} — ${event.resultReason}`
        : event.roundsWithTurns > 0
          ? "Partial — checkpointed turns; cycle result is not final."
          : event.status === "running"
            ? "Pending — no cycle result has been saved yet."
            : "No result record was saved for this cycle."
      const state = event.status === "awaiting-evaluation" && !event.evaluationRecorded
        ? "Main-agent evaluation is pending."
        : event.status === "paused"
          ? "An explicit main-agent follow-up is required before continuation."
          : event.status === "resolved"
            ? "The discussion is resolved.": event.status === "cancelled"
              ? "Scheduling is cancelled; saved findings remain above.": event.status === "interrupted"
                ? "Execution was interrupted; saved findings remain above.": "The current cycle is still in progress."
      return [
        "## Current outcome",
        `**Status:** ${event.status}`,
        `**Lifecycle status:** ${event.status}`,
        `**Current cycle:** ${event.cycle}`,
        `**Current cycle result:** ${currentResult}`,
        `**Rounds with saved turns:** ${event.roundsWithTurns}`,
        `**Evaluation:** ${event.evaluationRecorded ? "recorded" : "pending or not recorded"}`,
        state,
      ].join("\n\n")
    }
  }
}

export function renderTranscript(discussion: Discussion): string {
  assertDiscussion(discussion)
  return `${transcriptHeader(discussion)}${transcriptEvents(discussion).map(renderEvent).join("\n\n")}\n`
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined
}

function syncDirectory(descriptor: number): void {
  try { fsyncSync(descriptor) } catch (error) {
    if (!["EBADF", "EINVAL", "ENOTSUP"].includes(errorCode(error) ?? "")) throw error
  }
}

function identity(stat: { dev: number; ino: number }): StatIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameIdentity(left: StatIdentity, right: StatIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function descriptorPath(descriptor: number, name?: string): string {
  const base = `/proc/self/fd/${descriptor}`
  return name === undefined ? base : `${base}/${name}`
}

function openProjectDirectory(directory: string): number {
  if (process.platform !== "linux") fail("requires Linux descriptor-relative directory checks")
  try {
    lstatSync("/proc/self/fd")
  } catch {
    fail("requires /proc/self/fd for symlink-safe transcript storage")
  }
  const absolute = resolve(directory)
  const components = absolute.split(sep).filter(Boolean)
  let current = openSync(sep, directoryOpenFlags)
  try {
    for (const component of components) {
      let next: number
      try {
        next = openSync(descriptorPath(current, component), directoryOpenFlags)
      } catch (error) {
        const code = errorCode(error)
        if (code === "ENOENT") fail("project directory does not exist")
        fail("project path contains a symlink or non-directory component")
      }
      closeSync(current)
      current = next
    }
    return current
  } catch (error) {
    try { closeSync(current) } catch { /* Already closed or unavailable. */ }
    throw error
  }
}

function openChildDirectory(parentFD: number, name: string, label: string, create: boolean): number {
  const path = descriptorPath(parentFD, name)
  try {
    return openSync(path, directoryOpenFlags)
  } catch (error) {
    if (!create || errorCode(error) !== "ENOENT") {
      fail(`${label} directory must exist and must not be a symlink or non-directory`)
    }
  }
  try {
    mkdirSync(path, { mode: 0o755 })
  } catch (error) {
    if (errorCode(error) !== "EEXIST") fail(`could not create ${label} directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return openSync(path, directoryOpenFlags)
  } catch {
    fail(`${label} directory could not be opened safely after creation`)
  }
}

function closeDirectories(directories: TranscriptDirectories): void {
  for (const descriptor of [directories.debatesFD, directories.docsFD, directories.projectFD]) {
    try { closeSync(descriptor) } catch { /* Keep the original filesystem error. */ }
  }
}

function openTranscriptDirectories(projectDirectory: string): TranscriptDirectories {
  const projectFD = openProjectDirectory(projectDirectory)
  let docsFD: number | undefined
  let debatesFD: number | undefined
  try {
    docsFD = openChildDirectory(projectFD, "docs", "docs", true)
    debatesFD = openChildDirectory(docsFD, "debates", "debates", true)
    return { projectDirectory: resolve(projectDirectory), projectFD, docsFD, debatesFD }
  } catch (error) {
    if (debatesFD !== undefined) closeSync(debatesFD)
    if (docsFD !== undefined) closeSync(docsFD)
    closeSync(projectFD)
    throw error
  }
}

function verifyCanonicalDirectories(directories: TranscriptDirectories): void {
  let projectFD: number
  try { projectFD = openProjectDirectory(directories.projectDirectory) } catch (error) {
    failPathUnavailable(error instanceof Error ? error.message : "canonical project directory could not be verified")
  }
  let docsFD: number | undefined
  let debatesFD: number | undefined
  try {
    docsFD = openChildDirectory(projectFD, "docs", "docs", false)
    debatesFD = openChildDirectory(docsFD, "debates", "debates", false)
    if (!sameIdentity(identity(fstatSync(projectFD)), identity(fstatSync(directories.projectFD)))
      || !sameIdentity(identity(fstatSync(docsFD)), identity(fstatSync(directories.docsFD)))
      || !sameIdentity(identity(fstatSync(debatesFD)), identity(fstatSync(directories.debatesFD)))) {
      failPathUnavailable("canonical project/docs/debates directory changed during publication")
    }
  } catch (error) {
    if (error instanceof TranscriptPathUnavailableError) throw error
    failPathUnavailable(error instanceof Error ? error.message : "canonical transcript directory could not be verified")
  } finally {
    if (debatesFD !== undefined) closeSync(debatesFD)
    if (docsFD !== undefined) closeSync(docsFD)
    closeSync(projectFD)
  }
}

function regularFileAt(path: string, label: string): { identity: StatIdentity; mode: number } | undefined {
  try {
    const value = lstatSync(path)
    if (value.isSymbolicLink()) failPathUnavailable(`${label} must not be a symlink`)
    if (!value.isFile()) failPathUnavailable(`${label} must be a regular file`)
    return { identity: identity(value), mode: value.mode & 0o777 }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

function exactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function assertBrief(value: unknown): asserts value is Brief {
  if (!isRecord(value) || !exactKeys(value, ["question", "objective", "facts", "assumptions", "constraints",
    "alternatives", "uncertainty", "neededOutcome"])
    || !nonEmptyString(value.question) || !nonEmptyString(value.objective)
    || !Array.isArray(value.facts) || !value.facts.every((item) => typeof item === "string")
    || !Array.isArray(value.assumptions) || !value.assumptions.every((item) => typeof item === "string")
    || !Array.isArray(value.constraints) || !value.constraints.every((item) => typeof item === "string")
    || !Array.isArray(value.alternatives) || !value.alternatives.every((item) => typeof item === "string")
    || typeof value.uncertainty !== "string" || !nonEmptyString(value.neededOutcome)) {
    fail("frame contains an invalid decision brief")
  }
}

function assertFrameTurn(value: unknown, maxRounds: number): asserts value is Turn {
  assertTurn(value, maxRounds)
  if (!isRecord(value)) fail("frame turn is not a record")
  const keys = ["participant", "cycle", "round", "text",
    ...(value.consensus === undefined ? [] : ["consensus"]),
    ...(value.stop === undefined ? [] : ["stop"])]
  if (!exactKeys(value, keys)) fail("frame turn contains unselected fields")
}

function assertFrameEvaluation(value: unknown): asserts value is Evaluation {
  assertEvaluation(value)
  if (!isRecord(value)) fail("frame evaluation is not a record")
  const keys = ["cycle", "conclusion", "caveats", "rationale", "next",
    ...(value.feedback === undefined ? [] : ["feedback"])]
  if (!exactKeys(value, keys)) fail("frame evaluation contains unselected fields")
}

function validateTranscriptEvent(value: unknown, discussion: Discussion): TranscriptEvent {
  if (!isRecord(value) || typeof value.kind !== "string") fail("frame event is invalid")
  switch (value.kind) {
    case "brief":
      if (!exactKeys(value, ["kind", "brief"])) fail("brief frame event has unexpected fields")
      assertBrief(value.brief)
      return value as unknown as TranscriptEvent
    case "panel-heading":
      if (!exactKeys(value, ["kind"])) fail("panel-heading frame event has unexpected fields")
      return value as unknown as TranscriptEvent
    case "panel":
      if (!exactKeys(value, ["kind", "index", "agent", "description"])
        || !safeInteger(value.index, 0) || !nonEmptyString(value.agent) || typeof value.description !== "string") {
        fail("panel frame event is invalid")
      }
      return value as unknown as TranscriptEvent
    case "turn":
      if (!exactKeys(value, ["kind", "turn"])) fail("turn frame event has unexpected fields")
      assertFrameTurn(value.turn, discussion.config.maxRounds)
      if (value.turn.cycle > discussion.cycle) fail("turn frame event is from a future cycle")
      return value as unknown as TranscriptEvent
    case "followup":
      if (!exactKeys(value, ["kind", "cycle", "index", "feedback"])
        || !safeInteger(value.cycle, 1) || value.cycle > discussion.cycle
        || !safeInteger(value.index, 0) || typeof value.feedback !== "string") {
        fail("follow-up frame event is invalid")
      }
      return value as unknown as TranscriptEvent
    case "cycle-result":
      if (!exactKeys(value, ["kind", "cycle", "rounds", "status", "reason", "consensus"])
        || !safeInteger(value.cycle, 1) || value.cycle > discussion.cycle
        || !safeInteger(value.rounds, 0) || value.rounds > discussion.config.maxRounds
        || !isOneOf(value.status, RESULT_STATUSES) || !isOneOf(value.reason, RESULT_REASONS)
        || typeof value.consensus !== "boolean") {
        fail("cycle-result frame event is invalid")
      }
      return value as unknown as TranscriptEvent
    case "evaluation":
      if (!exactKeys(value, ["kind", "evaluation"])) fail("evaluation frame event has unexpected fields")
      assertFrameEvaluation(value.evaluation)
      if (value.evaluation.cycle > discussion.cycle) fail("evaluation frame event is from a future cycle")
      return value as unknown as TranscriptEvent
    case "outcome": {
      const hasResult = value.result !== undefined
      const keys = hasResult
        ? ["kind", "status", "cycle", "result", "resultReason", "roundsCompleted", "roundsWithTurns", "evaluationRecorded", "stateDigest"]
        : ["kind", "status", "cycle", "roundsWithTurns", "evaluationRecorded", "stateDigest"]
      if (!exactKeys(value, keys) || !isOneOf(value.status, STATUSES)
        || !safeInteger(value.cycle, 1) || value.cycle > discussion.cycle
        || hasResult && (!isOneOf(value.result, RESULT_STATUSES) || !isOneOf(value.resultReason, RESULT_REASONS)
          || !safeInteger(value.roundsCompleted, 0) || value.roundsCompleted > discussion.config.maxRounds)
        || !safeInteger(value.roundsWithTurns, 0) || typeof value.evaluationRecorded !== "boolean"
        || typeof value.stateDigest !== "string" || !/^[a-f0-9]{64}$/u.test(value.stateDigest)) {
        fail("outcome frame event is invalid")
      }
      return value as unknown as TranscriptEvent
    }
    default:
      fail("frame contains an unknown event kind")
  }
}

function semanticEvents(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  return events.filter((event) => event.kind !== "outcome")
}

function stateDigest(events: readonly TranscriptEvent[], status: Discussion["status"], cycle: number): string {
  const orderedEvents = semanticEvents(events).map((event) => [eventKey(event), eventDigest(event)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  return createHash("sha256").update(JSON.stringify({
    events: orderedEvents, status, cycle,
  })).digest("hex")
}

function validateOutcomeHistory(events: readonly TranscriptEvent[], outcome: Extract<TranscriptEvent, { kind: "outcome" }>): void {
  const semantic = semanticEvents(events)
  if (outcome.stateDigest !== stateDigest(semantic, outcome.status, outcome.cycle)) {
    fail("outcome frame digest does not match its event history")
  }
  const currentResult = [...semantic].reverse().find((event) => event.kind === "cycle-result" && event.cycle === outcome.cycle)
  const currentTurns = semantic.filter((event) => event.kind === "turn" && event.turn.cycle === outcome.cycle)
  const currentEvaluation = semantic.some((event) => event.kind === "evaluation" && event.evaluation.cycle === outcome.cycle)
  if (new Set(currentTurns.flatMap((event) => event.kind === "turn" ? [event.turn.round] : [])).size !== outcome.roundsWithTurns
    || currentEvaluation !== outcome.evaluationRecorded
    || currentResult?.kind !== (outcome.result === undefined ? undefined : "cycle-result")
    || currentResult?.kind === "cycle-result" && (currentResult.status !== outcome.result
      || currentResult.reason !== outcome.resultReason || currentResult.rounds !== outcome.roundsCompleted)) {
    fail("outcome frame summary does not match its verified event history")
  }
}

function encodeFrame(event: TranscriptEvent, sequence: number): Buffer {
  const encodedEvent = Buffer.from(JSON.stringify(event), "utf8").toString("base64")
  const payload = Buffer.from(`<!-- opencode-debate-event:v2 ${encodedEvent} -->\n${renderEvent(event)}\n\n`, "utf8")
  const digest = createHash("sha256").update(payload).digest("hex")
  const header = Buffer.from(`<!-- opencode-debate-frame:v2 seq=${sequence} length=${payload.length} sha256=${digest} -->\n`, "ascii")
  const footer = Buffer.from(`<!-- opencode-debate-frame-end:v2 seq=${sequence} sha256=${digest} -->\n`, "ascii")
  return Buffer.concat([header, payload, footer])
}

function parseFramePayload(payload: Buffer, discussion: Discussion, previousEvents: readonly TranscriptEvent[]): TranscriptEvent {
  const newline = payload.indexOf(0x0a)
  if (newline < 0) fail("frame payload has no event record")
  const eventLine = payload.subarray(0, newline).toString("ascii")
  const match = /^<!-- opencode-debate-event:v2 ([A-Za-z0-9+/]+={0,2}) -->$/u.exec(eventLine)
  if (!match) fail("frame payload has an invalid event record")
  const encoded = match[1]
  const eventBytes = Buffer.from(encoded, "base64")
  if (eventBytes.toString("base64") !== encoded) fail("frame event encoding is invalid")
  let raw: unknown
  try { raw = JSON.parse(eventBytes.toString("utf8")) as unknown } catch { fail("frame event JSON is invalid") }
  const event = validateTranscriptEvent(raw, discussion)
  const body = payload.subarray(newline + 1)
  try { new TextDecoder("utf-8", { fatal: true }).decode(body) } catch {
    fail("frame Markdown is not valid UTF-8")
  }
  if (!body.equals(Buffer.from(`${renderEvent(event)}\n\n`, "utf8"))) {
    fail("frame Markdown does not match its validated event")
  }
  if (event.kind === "outcome") validateOutcomeHistory(previousEvents, event)
  return event
}

function parseTranscriptContent(content: Buffer, discussion: Discussion): TranscriptLog {
  const header = Buffer.from(transcriptHeader(discussion), "utf8")
  if (content.length < header.length || !content.subarray(0, header.length).equals(header)) {
    fail("destination owner marker or framed transcript header does not match this discussion")
  }
  let offset = header.length
  let sequence = 1
  const events: TranscriptEvent[] = []
  const keys = new Set<string>()
  let latestCycle = 0
  while (offset < content.length) {
    const lineEnd = content.indexOf(0x0a, offset)
    if (lineEnd < 0) fail("transcript ends with an incomplete frame header")
    const line = content.subarray(offset, lineEnd).toString("ascii")
    const match = /^<!-- opencode-debate-frame:v2 seq=(\d+) length=(\d+) sha256=([a-f0-9]{64}) -->$/u.exec(line)
    if (!match) fail("transcript contains an invalid or incomplete frame header")
    const currentSequence = Number(match[1])
    const length = Number(match[2])
    const expectedDigest = match[3]
    if (!Number.isSafeInteger(currentSequence) || currentSequence !== sequence
      || !Number.isSafeInteger(length) || length < 1) fail("transcript frame sequence or length is invalid")
    const payloadStart = lineEnd + 1
    const payloadEnd = payloadStart + length
    if (payloadEnd > content.length) fail("transcript ends with an incomplete frame payload")
    const payload = content.subarray(payloadStart, payloadEnd)
    const actualDigest = createHash("sha256").update(payload).digest("hex")
    if (actualDigest !== expectedDigest) fail("transcript frame digest is invalid")
    const footerEnd = content.indexOf(0x0a, payloadEnd)
    if (footerEnd < 0) fail("transcript ends with an incomplete frame footer")
    const footer = content.subarray(payloadEnd, footerEnd).toString("ascii")
    if (footer !== `<!-- opencode-debate-frame-end:v2 seq=${sequence} sha256=${expectedDigest} -->`) {
      fail("transcript frame footer does not match its header")
    }
    const event = parseFramePayload(payload, discussion, events)
    const cycle = eventCycle(event)
    if (cycle !== undefined && cycle < latestCycle) fail("transcript frame cycles are not in chronological order")
    if (cycle !== undefined) latestCycle = cycle
    const key = eventKey(event)
    if (keys.has(key)) fail("transcript contains a duplicate event frame")
    keys.add(key)
    events.push(event)
    sequence++
    offset = footerEnd + 1
  }
  if (events.length < 3 || events[0].kind !== "brief" || events[1].kind !== "panel-heading"
    || events.at(-1)?.kind !== "outcome") {
    fail("transcript does not end at a complete verified outcome frame")
  }
  return { events, nextSequence: sequence }
}

function openOwnedTranscript(path: string, discussion: Discussion): OpenTranscript | undefined {
  let current: ReturnType<typeof regularFileAt>
  try { current = regularFileAt(path, "destination") } catch (error) {
    if (error instanceof TranscriptPathUnavailableError) throw error
    failPathUnavailable(error instanceof Error ? error.message : "destination could not be inspected")
  }
  if (!current) return undefined
  if (current.mode !== 0o600) failPathUnavailable("destination permissions are not the required owner-only 0600 mode")
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, fileAppendFlags)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || !sameIdentity(current.identity, identity(opened))) {
      failPathUnavailable("pathname changed while its descriptor was opened")
    }
    const content = readFileSync(descriptor)
    const log = parseTranscriptContent(content, discussion)
    return { descriptor, identity: current.identity, content, log }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error instanceof TranscriptPathUnavailableError) throw error
    if (errorCode(error) === "ELOOP") failPathUnavailable("destination must not be a symlink")
    if (error instanceof Error && error.message.startsWith("Automatic transcript")) {
      failPathUnavailable(error.message)
    }
    failPathUnavailable(error instanceof Error ? error.message : "owned destination could not be opened and verified")
  }
}

function appendableEvents(discussion: Discussion, existing: TranscriptLog): TranscriptEvent[] {
  const current = transcriptEvents(discussion)
  const currentSemantic = semanticEvents(current)
  const currentByKey = new Map(currentSemantic.map((event) => [eventKey(event), event]))
  const storedSemantic = semanticEvents(existing.events)
  const storedKeys = new Set<string>()
  for (const event of storedSemantic) {
    const key = eventKey(event)
    const currentEvent = currentByKey.get(key)
    if (!currentEvent || eventDigest(currentEvent) !== eventDigest(event)) {
      fail("current discussion omits or changes a previously framed finding")
    }
    storedKeys.add(key)
  }
  const additions = currentSemantic.filter((event) => !storedKeys.has(eventKey(event)))
  const outcome = current.at(-1)
  if (!outcome || outcome.kind !== "outcome") fail("current discussion has no outcome frame")
  const previousOutcome = [...existing.events].reverse().find((event) => event.kind === "outcome")
  return [...additions, ...(previousOutcome && eventDigest(previousOutcome) === eventDigest(outcome) ? [] : [outcome])]
}

function verifyDestinationIdentity(path: string, expected: StatIdentity, stage: string): void {
  let current: ReturnType<typeof regularFileAt>
  try { current = regularFileAt(path, "destination") } catch (error) {
    if (error instanceof TranscriptPathUnavailableError) throw error
    failPathUnavailable(error instanceof Error ? error.message : `could not verify pathname ${stage}`)
  }
  if (!current || !sameIdentity(current.identity, expected)) {
    failPathUnavailable(`pathname no longer identifies the opened record ${stage}`)
  }
}

function writeNewTranscript(path: string, content: Buffer): StatIdentity {
  let descriptor: number | undefined
  let createdIdentity: StatIdentity | undefined
  let operationError: unknown
  try {
    descriptor = openSync(path, fileWriteFlags, 0o600)
    fchmodSync(descriptor, 0o600)
    const initial = fstatSync(descriptor)
    if (!initial.isFile()) fail("exclusive destination is not a regular file")
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    createdIdentity = identity(fstatSync(descriptor))
  } catch (error) {
    operationError = error
  }
  if (descriptor !== undefined) {
    try { closeSync(descriptor) } catch (error) {
      operationError = operationError === undefined
        ? error
        : new Error(`${operationError instanceof Error ? operationError.message : String(operationError)}; close failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (operationError !== undefined) {
    if (errorCode(operationError) === "EEXIST") {
      throw new TranscriptPathUnavailableError("Automatic transcript destination already exists without a verified framed record; refusing collision")
    }
    throw new TranscriptPathUnavailableError(operationError instanceof Error
      ? `Automatic transcript exclusive first write was not verified: ${operationError.message}`
      : "Automatic transcript exclusive first write was not verified")
  }
  if (!createdIdentity) failPathUnavailable("exclusive first write did not yield a regular-file identity")
  return createdIdentity
}

function writeAll(descriptor: number, data: Buffer): void {
  let offset = 0
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset)
    if (written <= 0) fail("append returned a short write")
    offset += written
  }
}

function appendEvents(path: string, discussion: Discussion, directories: TranscriptDirectories,
  existing: OpenTranscript, events: readonly TranscriptEvent[]): void {
  if (events.length === 0) {
    verifyCanonicalDirectories(directories)
    verifyDestinationIdentity(path, existing.identity, "before returning the retained path")
    return
  }
  const append = Buffer.concat(events.map((event, index) => encodeFrame(event, existing.log.nextSequence + index)))
  parseTranscriptContent(Buffer.concat([existing.content, append]), discussion)
  verifyCanonicalDirectories(directories)
  verifyDestinationIdentity(path, existing.identity, "before appending the next verified frame")
  let writingStarted = false
  try {
    writingStarted = true
    writeAll(existing.descriptor, append)
    fsyncSync(existing.descriptor)
  } catch (error) {
    if (writingStarted) {
      try { verifyDestinationIdentity(path, existing.identity, "after an append failure") }
      catch (pathError) { throw pathError }
    }
    failPathUnavailable(error instanceof Error ? `append was not verified: ${error.message}` : "append was not verified")
  }
  verifyCanonicalDirectories(directories)
  verifyDestinationIdentity(path, existing.identity, "after appending verified frames")
}

async function withDiscussionLock<T>(key: string, operation: () => T): Promise<T> {
  const previous = discussionLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise })
  discussionLocks.set(key, current)
  await previous
  try {
    return operation()
  } finally {
    release()
    if (discussionLocks.get(key) === current) discussionLocks.delete(key)
  }
}

function savedPath(projectDirectory: string, destination: string): string {
  return relative(projectDirectory, destination).split(sep).join("/")
}

export async function saveTranscript(discussion: Discussion): Promise<string | undefined> {
  if (isRecord(discussion) && isRecord(discussion.config) && discussion.config.persistTranscripts === false) return undefined
  const snapshot = structuredClone(discussion)
  assertDiscussion(snapshot)
  if (!snapshot.config.persistTranscripts) return undefined
  const projectDirectory = resolve(snapshot.owner.directory)
  const filename = `auto-${snapshot.id}.md`
  const lockKey = JSON.stringify([projectDirectory, snapshot.id])
  return withDiscussionLock(lockKey, () => {
    const events = transcriptEvents(snapshot)
    let directories: TranscriptDirectories
    try { directories = openTranscriptDirectories(projectDirectory) } catch (error) {
      if (snapshot.transcriptPath !== undefined) {
        failPathUnavailable(error instanceof Error ? `owned transcript directory could not be verified: ${error.message}`
          : "owned transcript directory could not be verified")
      }
      throw error
    }
    const destination = descriptorPath(directories.debatesFD, filename)
    try {
      verifyCanonicalDirectories(directories)
      const existingPath = regularFileAt(destination, "destination")
      if (existingPath) {
        const existing = openOwnedTranscript(destination, snapshot)
        if (!existing) failPathUnavailable("owned destination disappeared before it could be opened")
        try {
          appendEvents(destination, snapshot, directories, existing, appendableEvents(snapshot, existing.log))
        } finally {
          closeSync(existing.descriptor)
        }
      } else {
        const initial = Buffer.concat([
          Buffer.from(transcriptHeader(snapshot), "utf8"),
          ...events.map((event, index) => encodeFrame(event, index + 1)),
        ])
        parseTranscriptContent(initial, snapshot)
        try {
          const createdIdentity = writeNewTranscript(destination, initial)
          syncDirectory(directories.debatesFD)
          verifyCanonicalDirectories(directories)
          verifyDestinationIdentity(destination, createdIdentity, "after its exclusive first write")
          const created = openOwnedTranscript(destination, snapshot)
          if (!created || !sameIdentity(created.identity, createdIdentity)) {
            if (created) closeSync(created.descriptor)
            failPathUnavailable("exclusive first write could not be verified as the owned framed record")
          }
          try {
            verifyDestinationIdentity(destination, createdIdentity, "after verifying its first frames")
          } finally {
            try { closeSync(created.descriptor) } catch (error) {
              verifyDestinationIdentity(destination, createdIdentity, "after closing the verification descriptor")
              failPathUnavailable(error instanceof Error ? `could not close the first-record verification descriptor: ${error.message}`
                : "could not close the first-record verification descriptor")
            }
          }
        } catch (error) {
          if (error instanceof TranscriptPathUnavailableError) throw error
          failPathUnavailable(error instanceof Error ? `exclusive first record was not verified: ${error.message}`
            : "exclusive first record was not verified")
        }
      }
      return savedPath(projectDirectory, join(projectDirectory, "docs", "debates", filename))
    } finally {
      closeDirectories(directories)
    }
  })
}

export async function checkpointTranscript(discussion: Discussion): Promise<TranscriptCheckpointResult> {
  try {
    const path = await saveTranscript(discussion)
    if (path !== undefined) discussion.transcriptPath = path
    delete discussion.transcriptError
  } catch (error) {
    if (error instanceof TranscriptPathUnavailableError) delete discussion.transcriptPath
    const detail = error instanceof Error ? error.message : "unknown filesystem failure"
    discussion.transcriptError = `Transcript unavailable: ${detail.replace(/\s+/gu, " ").slice(0, 400)}`
  }
  return { transcriptPath: discussion.transcriptPath, transcriptError: discussion.transcriptError }
}

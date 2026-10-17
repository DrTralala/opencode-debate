export type MiniDebateExtensionOption = {
  label: string
  description: string
}

export type MiniDebateExtensionQuestion = {
  question: string
  header: string
  options: MiniDebateExtensionOption[]
  multiple: false
  custom: false
}

export type MiniDebateTaskEnvelope =
  | { state: "running"; childSessionID: string }
  | { state: "completed"; childSessionID: string; result: string }
  | { state: "error"; childSessionID: string; error: string }

export type MiniDebateChildIdentity = {
  childSessionID?: string
  parentSessionID?: string
}

const ENVELOPE_RE = /^<task id="([^"]+)" state="(running|completed|error)">([\s\S]*)<\/task>$/u
const QUESTION_FIELDS = ["question", "header", "options", "multiple", "custom"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function metadataString(metadata: unknown, key: string): string | undefined {
  if (!isRecord(metadata)) return undefined
  const value = metadata[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function parseTaskEnvelope(output: string): MiniDebateTaskEnvelope | undefined {
  const match = ENVELOPE_RE.exec(output.trim())
  if (match === null) return undefined
  const [, childSessionID, state, body] = match
  if (state === "running") return { state, childSessionID }
  if (state === "completed") {
    const result = /<task_result>([\s\S]*?)<\/task_result>/u.exec(body)
    return result === null ? undefined : { state, childSessionID, result: result[1].trim() }
  }
  const error = /<task_error>([\s\S]*?)<\/task_error>/u.exec(body)
  return { state: "error", childSessionID, error: error === null ? "" : error[1].trim() }
}

export function taskChildIdentity(output: string, ...metadata: unknown[]): MiniDebateChildIdentity {
  const envelope = parseTaskEnvelope(output)
  let childSessionID = envelope?.childSessionID
  let parentSessionID: string | undefined
  for (const value of metadata) {
    const metadataChild = metadataString(value, "sessionId") ?? metadataString(value, "sessionID")
    const metadataParent = metadataString(value, "parentSessionId") ?? metadataString(value, "parentID")
    if (metadataChild !== undefined) {
      if (childSessionID !== undefined && childSessionID !== metadataChild) {
        throw new Error(
          `Mini-debate task child session conflict (envelope=${childSessionID}, metadata=${metadataChild})`,
        )
      }
      childSessionID = metadataChild
    }
    if (metadataParent !== undefined) {
      if (parentSessionID !== undefined && parentSessionID !== metadataParent) {
        throw new Error(
          `Mini-debate task parent session conflict (received=${parentSessionID}, metadata=${metadataParent})`,
        )
      }
      parentSessionID = metadataParent
    }
  }
  return {
    ...(childSessionID === undefined ? {} : { childSessionID }),
    ...(parentSessionID === undefined ? {} : { parentSessionID }),
  }
}

export function buildExtensionQuestion(input: {
  invocationId: string
  round: number
  limit: number
  rounds: number
}): MiniDebateExtensionQuestion {
  const requested = input.rounds === 1 ? "round" : "rounds"
  const limit = input.limit === 1 ? "round" : "rounds"
  return {
    question:
      `Mini-debate ${input.invocationId} reached its limit of ${input.limit} ${limit} after round ${input.round}. `
      + `Grant ${input.rounds} additional ${requested}?`,
    header: "Mini-debate extension",
    options: [
      { label: "Yes", description: `Run ${input.rounds} additional ${requested}.` },
      { label: "No", description: "Stop and synthesise now." },
    ],
    multiple: false,
    custom: false,
  }
}

export function matchesExtensionQuestion(value: unknown, expected: MiniDebateExtensionQuestion): boolean {
  if (!isRecord(value)) return false
  if (
    Object.keys(value).length !== QUESTION_FIELDS.length
    || !QUESTION_FIELDS.every((field) => Object.hasOwn(value, field))
  ) {
    return false
  }
  if (value.question !== expected.question || value.header !== expected.header) return false
  if (value.multiple !== false || value.custom !== false) return false
  if (!Array.isArray(value.options) || value.options.length !== expected.options.length) return false
  return value.options.every((option, index) => {
    const wanted = expected.options[index]
    return isRecord(option) && option.label === wanted.label && option.description === wanted.description
  })
}

export function isExtensionApproval(answers: unknown): boolean {
  return Array.isArray(answers)
    && answers.length === 1
    && Array.isArray(answers[0])
    && answers[0].length === 1
    && answers[0][0] === "Yes"
}

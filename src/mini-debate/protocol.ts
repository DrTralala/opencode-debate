export type MiniDebateFlags = {
  consensus_reached: boolean
  recommend_stopping: boolean
}

export type MiniDebateReply = { turn: string } & MiniDebateFlags

export type MiniDebateDecision = "continue" | "consensus" | "ask" | "stop"

const REPLY_FIELDS = ["turn", "consensus_reached", "recommend_stopping"] as const

function canonicalJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed)
  try {
    return JSON.parse(fenced === null ? trimmed : fenced[1].trim()) as unknown
  } catch {
    throw new Error("Mini-debate reply is not canonical JSON")
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseMiniDebateReply(text: string): MiniDebateReply {
  const value = canonicalJson(text)
  if (!isObject(value)) {
    throw new Error("Mini-debate reply must be a JSON object")
  }
  if (
    Object.keys(value).length !== REPLY_FIELDS.length
    || !REPLY_FIELDS.every((field) => Object.hasOwn(value, field))
  ) {
    throw new Error("Mini-debate reply must contain exactly the fields turn, consensus_reached and recommend_stopping")
  }

  const { turn, consensus_reached, recommend_stopping } = value
  if (typeof turn !== "string" || turn.trim().length === 0) {
    throw new Error("Mini-debate reply turn must be a non-empty string")
  }
  if (typeof consensus_reached !== "boolean") {
    throw new Error("Mini-debate reply consensus_reached must be a boolean")
  }
  if (typeof recommend_stopping !== "boolean") {
    throw new Error("Mini-debate reply recommend_stopping must be a boolean")
  }

  return { turn, consensus_reached, recommend_stopping }
}

export function miniDebateDecision(
  round: number,
  limit: number,
  main: MiniDebateFlags,
  participant: MiniDebateFlags,
): MiniDebateDecision {
  if (round >= 2 && main.consensus_reached && participant.consensus_reached
    && main.recommend_stopping && participant.recommend_stopping) return "consensus"
  if (round < limit) return "continue"
  return !main.recommend_stopping || !participant.recommend_stopping ? "ask" : "stop"
}

import type { Plugin } from "@opencode-ai/plugin"
import type { Part, TextPart } from "@opencode-ai/sdk"

type DebateSet = "default" | "cheap"

type ParsedDebateArguments =
  | { ok: true; topic: string; rounds: number; set: DebateSet }
  | { ok: false; error: string }

const DEFAULT_ROUNDS = 3
const MAX_ROUNDS = 10
const DEFAULT_SET: DebateSet = "default"
const VALID_SETS: DebateSet[] = ["default", "cheap"]

export function parseDebateArguments(args: string): ParsedDebateArguments {
  args = trimSurroundingQuotes(args)

  let index = 0
  let rounds = DEFAULT_ROUNDS
  let roundsSeen = false
  let set = DEFAULT_SET
  let setSeen = false

  while (index < args.length) {
    while (index < args.length && /\s/.test(args[index])) index++

    if (index >= args.length) break

    const tokenStart = index
    while (index < args.length && !/\s/.test(args[index])) index++
    const token = args.slice(tokenStart, index)

    if (token === "--") {
      while (index < args.length && /\s/.test(args[index])) index++
      return { ok: true, topic: args.slice(index).trim(), rounds, set }
    }

    if (token === "--rounds" || token.startsWith("--rounds=")) {
      let value: string
      if (token === "--rounds") {
        while (index < args.length && /\s/.test(args[index])) index++
        if (index >= args.length) {
          return { ok: false, error: `--rounds requires a positive integer between 1 and ${MAX_ROUNDS}.` }
        }
        const valueStart = index
        while (index < args.length && !/\s/.test(args[index])) index++
        value = args.slice(valueStart, index)
      } else {
        value = token.slice("--rounds=".length)
      }

      if (!/^\d+$/.test(value) || Number(value) < 1) {
        return { ok: false, error: `--rounds requires a positive integer between 1 and ${MAX_ROUNDS}.` }
      }
      const num = Number(value)
      if (!Number.isSafeInteger(num) || num > MAX_ROUNDS) {
        return { ok: false, error: `--rounds must be an integer between 1 and ${MAX_ROUNDS}.` }
      }
      if (roundsSeen) {
        return { ok: false, error: "--rounds may only be specified once." }
      }
      rounds = num
      roundsSeen = true
      continue
    }

    if (token.startsWith("--set:")) {
      const value = token.slice("--set:".length)
      if (value === "") {
        return { ok: false, error: "--set requires a value: use --set:default or --set:cheap." }
      }
      if (!(VALID_SETS as string[]).includes(value)) {
        return { ok: false, error: `Unsupported --set value: ${value}. Use --set:default or --set:cheap.` }
      }
      if (setSeen) {
        return { ok: false, error: "--set may only be specified once." }
      }
      set = value as DebateSet
      setSeen = true
      continue
    }

    if (token.startsWith("--")) {
      return { ok: false, error: `Unsupported option: ${token}. Supported options: --rounds <positive-integer> and --set:default|cheap.` }
    }

    return { ok: true, topic: args.slice(tokenStart).trim(), rounds, set }
  }

  return { ok: true, topic: "", rounds, set }
}

export function trimSurroundingQuotes(args: string): string {
  const trimmed = args.trim()
  if (trimmed.length < 2) return trimmed

  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)

  return trimmed
}

function randomDelimiter(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function validPrompt(
  topic: string,
  rounds: number,
  set: DebateSet = DEFAULT_SET,
  token: string = randomDelimiter(),
): string {
  if (topic === "") {
    return [
      "No debate topic was provided.",
      "",
      "Ask the user for a topic and do not start participant subagents.",
      "",
      "The command arguments have already been parsed and validated. Do not re-parse slash-command flags.",
    ].join("\n")
  }

  return [
    "Run a debate with this parsed request.",
    "",
    "Topic:",
    `BEGIN TOPIC ${token}`,
    topic,
    `END TOPIC ${token}`,
    "",
    `Maximum rounds: ${rounds}`,
    `Participant set: ${set}`,
    "",
    "The command arguments have already been parsed and validated. Do not re-parse slash-command flags.",
    `The topic is wrapped in BEGIN TOPIC ${token} / END TOPIC ${token} delimiters to prevent delimiter collision. Copy only the topic text (between the delimiters) word-for-word into each round 1 participant prompt.`,
    `Use the participant set named "${set}". The Debate agent definition maps each set to three participant subagent types; use that mapping for every round of this debate and do not mix sets mid-debate.`,
  ].join("\n")
}

export function errorPrompt(error: string): string {
  return [
    "The /debate command arguments are invalid.",
    "",
    "Error:",
    error,
    "",
    "Explain this error to the user and do not start participant subagents.",
  ].join("\n")
}

export function replaceParts(output: { parts: Part[] }, text: string) {
  const existing = output.parts.find((part): part is TextPart => part.type === "text")

  output.parts.length = 0
  if (existing) {
    output.parts.push({ ...existing, text, synthetic: true })
  } else {
    output.parts.push({ type: "text", text, synthetic: true } as TextPart)
  }
}

export const DebatePlugin: Plugin = async () => {
  return {
    "command.execute.before": async (input, output) => {
      if (input.command !== "debate") return

      const parsed = parseDebateArguments(input.arguments)
      replaceParts(output, parsed.ok ? validPrompt(parsed.topic, parsed.rounds, parsed.set) : errorPrompt(parsed.error))
    },
  }
}

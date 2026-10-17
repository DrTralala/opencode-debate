import { trimSurroundingQuotes } from "../debate.ts"
import type { DebateParticipant, DebateRegistry } from "../participants.ts"

export type ParsedMiniDebateArguments =
  | { ok: true; topic: string; rounds: number; participant: DebateParticipant }
  | { ok: false; error: string }

const DEFAULT_ROUNDS = 3
const MAX_ROUNDS = 10

function participantUsage(participants: readonly DebateParticipant[]): string {
  const choices = participants.map(({ agent }) => `--participant:${agent}`)
  if (choices.length === 0) return "--participant:<name>"
  if (choices.length === 1) return choices[0]
  return `${choices.slice(0, -1).join(", ")} or ${choices.at(-1)}`
}

function topicRequired(): ParsedMiniDebateArguments {
  return {
    ok: false,
    error: "A topic is required: use /mini-debate [--participant:<name>] [--rounds <1-10>] <topic>.",
  }
}

export function parseMiniDebateArguments(
  args: string,
  registry: DebateRegistry,
): ParsedMiniDebateArguments {
  args = trimSurroundingQuotes(args)

  const usage = participantUsage(registry.participants)
  let index = 0
  let rounds = registry.miniDebate?.maxRounds ?? DEFAULT_ROUNDS
  let roundsSeen = false
  let participantID = registry.miniDebate?.participant ?? registry.sets[registry.defaultSet]?.[0]
  let participantSeen = false

  const resolve = (topic: string): ParsedMiniDebateArguments => {
    const participant = registry.participants.find((item) => item.agent === participantID)
    if (participant === undefined) {
      return {
        ok: false,
        error: `Unknown participant: ${participantID ?? "(none configured)"}. Use ${usage}.`,
      }
    }
    return { ok: true, topic, rounds, participant }
  }

  while (index < args.length) {
    while (index < args.length && /\s/.test(args[index])) index++

    if (index >= args.length) break

    const tokenStart = index
    while (index < args.length && !/\s/.test(args[index])) index++
    const token = args.slice(tokenStart, index)

    if (token === "--") {
      while (index < args.length && /\s/.test(args[index])) index++
      const topic = args.slice(index).trim()
      return topic === "" ? topicRequired() : resolve(topic)
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

    if (token.startsWith("--participant:")) {
      const value = token.slice("--participant:".length)
      if (value === "") {
        return { ok: false, error: `--participant requires a value: use ${usage}.` }
      }
      if (!registry.participants.some((item) => item.agent === value)) {
        return { ok: false, error: `Unsupported --participant value: ${value}. Use ${usage}.` }
      }
      if (participantSeen) {
        return { ok: false, error: "--participant may only be specified once." }
      }
      participantID = value
      participantSeen = true
      continue
    }

    if (token.startsWith("--")) {
      return {
        ok: false,
        error: `Unsupported option: ${token}. Supported options: --rounds <positive-integer> and ${usage}.`,
      }
    }

    return resolve(args.slice(tokenStart).trim())
  }

  return topicRequired()
}

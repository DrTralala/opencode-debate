import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseDocument } from "yaml"

export type DebateSet = string
export type DebateParticipantAgent = string

export type DebateParticipant = Readonly<{
  agent: DebateParticipantAgent
  description: string
  model: string
  variant?: string
}>

export type DebateParticipantSets = Readonly<Record<string, readonly string[]>>

export type DebateRegistry = Readonly<{
  participants: readonly DebateParticipant[]
  sets: DebateParticipantSets
}>

type ParticipantConfigEntry = {
  description?: string
  model?: string
  variant?: string
}

export type ParticipantConfig = {
  version: 1
  participants: Record<string, ParticipantConfigEntry>
  sets: Record<string, string[]>
}

export type ParticipantConfigKind = "defaults" | "overlay"

export class DebateConfigError extends Error {
  readonly configPath: string
  readonly fieldPath: string

  constructor(configPath: string, fieldPath: string, reason: string) {
    const absolutePath = resolve(configPath)
    super(`Invalid opencode-debate config at ${absolutePath} (${fieldPath}): ${reason}`)
    this.name = "DebateConfigError"
    this.configPath = absolutePath
    this.fieldPath = fieldPath
  }
}

const TOP_LEVEL_FIELDS = new Set(["version", "participants", "sets"])
const PARTICIPANT_FIELDS = new Set(["description", "model", "variant"])
const PACKAGED_CONFIG_PATH = fileURLToPath(new URL("../config.yaml", import.meta.url))

function isMapping(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(configPath: string, fieldPath: string, reason: string): never {
  throw new DebateConfigError(configPath, fieldPath, reason)
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  configPath: string,
  fieldPath: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(configPath, fieldPath === "$" ? key : `${fieldPath}.${key}`, "unknown field")
  }
}

function optionalNonEmptyString(
  value: unknown,
  configPath: string,
  fieldPath: string,
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim() === "") {
    invalid(configPath, fieldPath, "expected a non-empty string")
  }
  return value
}

function validateEffectiveConfig(config: ParticipantConfig, configPath: string): void {
  if (!Object.hasOwn(config.sets, "default")) invalid(configPath, "sets.default", "a default set is required")

  for (const [agent, participant] of Object.entries(config.participants)) {
    if (participant.model === undefined) {
      invalid(configPath, `participants.${agent}.model`, "expected a non-empty string")
    }
  }

  for (const [setName, participants] of Object.entries(config.sets)) {
    for (let index = 0; index < participants.length; index++) {
      const agent = participants[index]
      if (!Object.hasOwn(config.participants, agent)) {
        invalid(configPath, `sets.${setName}[${index}]`, `unknown participant: ${agent}`)
      }
    }
  }
}

export function parseParticipantConfig(
  source: string,
  configPath: string,
  kind: ParticipantConfigKind,
): ParticipantConfig {
  let value: unknown
  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
    })
    if (document.errors.length > 0) {
      invalid(configPath, "$", `YAML parse error: ${document.errors[0].message}`)
    }
    value = document.toJS()
  } catch (error) {
    if (error instanceof DebateConfigError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    invalid(configPath, "$", `YAML parse error: ${reason}`)
  }

  if (!isMapping(value)) invalid(configPath, "$", "expected a mapping")
  assertKnownFields(value, TOP_LEVEL_FIELDS, configPath, "$")

  if (value.version !== 1) invalid(configPath, "version", "unsupported version; expected 1")

  const rawParticipants = value.participants === undefined && kind === "overlay" ? {} : value.participants
  if (!isMapping(rawParticipants)) invalid(configPath, "participants", "expected a mapping")

  const participants: Record<string, ParticipantConfigEntry> = {}
  for (const [agent, rawParticipant] of Object.entries(rawParticipants)) {
    if (!isMapping(rawParticipant)) invalid(configPath, `participants.${agent}`, "expected a mapping")
    assertKnownFields(rawParticipant, PARTICIPANT_FIELDS, configPath, `participants.${agent}`)

    const description = optionalNonEmptyString(
      rawParticipant.description,
      configPath,
      `participants.${agent}.description`,
    )
    const model = optionalNonEmptyString(rawParticipant.model, configPath, `participants.${agent}.model`)
    const variant = optionalNonEmptyString(rawParticipant.variant, configPath, `participants.${agent}.variant`)

    participants[agent] = {
      ...(description === undefined ? {} : { description }),
      ...(model === undefined ? {} : { model }),
      ...(variant === undefined ? {} : { variant }),
    }
  }

  const rawSets = value.sets === undefined && kind === "overlay" ? {} : value.sets
  if (!isMapping(rawSets)) invalid(configPath, "sets", "expected a mapping")

  const sets: Record<string, string[]> = {}
  for (const [setName, rawSet] of Object.entries(rawSets)) {
    if (!Array.isArray(rawSet) || rawSet.length !== 3) {
      invalid(configPath, `sets.${setName}`, "expected exactly three participant IDs")
    }

    const members = rawSet.map((member, index) => {
      if (typeof member !== "string" || member.trim() === "") {
        invalid(configPath, `sets.${setName}[${index}]`, "expected a non-empty string")
      }
      return member
    })
    if (new Set(members).size !== members.length) {
      invalid(configPath, `sets.${setName}`, "expected three distinct participant IDs")
    }
    sets[setName] = members
  }

  const config: ParticipantConfig = { version: 1, participants, sets }
  if (kind === "defaults") validateEffectiveConfig(config, configPath)
  return config
}

function normaliseRegistry(config: ParticipantConfig, configPath: string): DebateRegistry {
  validateEffectiveConfig(config, configPath)

  const participants = Object.entries(config.participants).map(([agent, participant]) => Object.freeze({
    agent,
    description: participant.description ?? `Neutral debate participant using ${participant.model}`,
    model: participant.model!,
    ...(participant.variant === undefined ? {} : { variant: participant.variant }),
  }))

  const sets = Object.fromEntries(
    Object.entries(config.sets).map(([name, members]) => [name, Object.freeze([...members])]),
  )

  return Object.freeze({
    participants: Object.freeze(participants),
    sets: Object.freeze(sets),
  })
}

export function loadPackagedRegistry(configPath: string = PACKAGED_CONFIG_PATH): DebateRegistry {
  const config = parseParticipantConfig(readFileSync(configPath, "utf8"), configPath, "defaults")
  return normaliseRegistry(config, configPath)
}

export function resolveUserConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const base = env.XDG_CONFIG_HOME === undefined || env.XDG_CONFIG_HOME === ""
    ? join(home, ".config")
    : env.XDG_CONFIG_HOME
  return resolve(base, "opencode", "opencode-debate", "config.yaml")
}

export function loadEffectiveRegistry(options: {
  packagedPath?: string
  userPath?: string
} = {}): DebateRegistry {
  const packagedPath = options.packagedPath ?? PACKAGED_CONFIG_PATH
  const packaged = parseParticipantConfig(readFileSync(packagedPath, "utf8"), packagedPath, "defaults")
  const userPath = options.userPath ?? resolveUserConfigPath()

  if (!existsSync(userPath)) return normaliseRegistry(packaged, packagedPath)

  const overlay = parseParticipantConfig(readFileSync(userPath, "utf8"), userPath, "overlay")
  const participants = { ...packaged.participants }
  for (const [agent, participant] of Object.entries(overlay.participants)) {
    participants[agent] = { ...participants[agent], ...participant }
  }

  return normaliseRegistry({
    version: 1,
    participants,
    sets: { ...packaged.sets, ...overlay.sets },
  }, userPath)
}

const PACKAGED_REGISTRY = loadPackagedRegistry()

export const DEBATE_PARTICIPANTS = PACKAGED_REGISTRY.participants
export const DEBATE_PARTICIPANT_SETS = PACKAGED_REGISTRY.sets

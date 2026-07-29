import { randomUUID } from "node:crypto"
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isMap, isScalar, parseDocument } from "yaml"

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
  defaultSet: DebateSet
}>

export type ParticipantConfigEntry = {
  description?: string
  model: string
  variant?: string
}

export type ParticipantSetConfig = {
  participants: [string, string, string]
  default?: "yes"
}

export type ParticipantConfig = {
  version: 2
  participants: Record<string, ParticipantConfigEntry>
  sets: Record<string, ParticipantSetConfig>
  defaultSet: string
}

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

export type DebateConfigFileOperation = "read" | "create"

export class DebateConfigFileError extends Error {
  readonly configPath: string
  readonly operation: DebateConfigFileOperation

  constructor(configPath: string, operation: DebateConfigFileOperation, cause: unknown) {
    const absolutePath = resolve(configPath)
    const reason = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to ${operation} opencode-debate configuration at ${absolutePath}: ${reason}`, { cause })
    this.name = "DebateConfigFileError"
    this.configPath = absolutePath
    this.operation = operation
  }
}

export type ParticipantConfigPaths = {
  packagedPath?: string
  userPath?: string
}

const TOP_LEVEL_FIELDS = new Set(["version", "participants", "sets"])
const PARTICIPANT_FIELDS = new Set(["description", "model", "variant"])
const SET_FIELDS = new Set(["participants", "default"])
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

function readConfigSource(configPath: string): string {
  try {
    return readFileSync(configPath, "utf8")
  } catch (error) {
    throw new DebateConfigFileError(configPath, "read", error)
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

export function parseParticipantConfig(source: string, configPath: string): ParticipantConfig {
  let document: ReturnType<typeof parseDocument>
  let value: unknown
  try {
    document = parseDocument(source, {
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
  if (value.version !== 2) invalid(configPath, "version", "unsupported version; expected 2")

  const rawParticipants = value.participants
  if (!isMapping(rawParticipants)) invalid(configPath, "participants", "expected a mapping")

  const participantsConfig: Record<string, ParticipantConfigEntry> = Object.create(null)
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
    if (model === undefined) {
      invalid(configPath, `participants.${agent}.model`, "expected a non-empty string")
    }

    participantsConfig[agent] = {
      model,
      ...(description === undefined ? {} : { description }),
      ...(variant === undefined ? {} : { variant }),
    }
  }

  const rawSets = value.sets
  if (!isMapping(rawSets)) invalid(configPath, "sets", "expected a mapping")
  const setsNode = document.get("sets", true)
  const setOrder = isMap(setsNode)
    ? setsNode.items.map(({ key }, index) => {
        const setName = isScalar(key) ? key.value : undefined
        if (typeof setName !== "string" || setName.length === 0) {
          invalid(configPath, `sets[${index}]`, "expected a non-empty string key")
        }
        return setName
      })
    : []
  if (setOrder.length === 0) invalid(configPath, "sets", "expected at least one set")

  const sets: Record<string, ParticipantSetConfig> = Object.create(null)
  let markedDefault: string | undefined
  for (const setName of setOrder) {
    const fieldPath = `sets.${setName}`
    const rawSet = rawSets[setName]
    if (!isMapping(rawSet)) invalid(configPath, fieldPath, "expected a mapping")
    assertKnownFields(rawSet, SET_FIELDS, configPath, fieldPath)

    const rawMembers = rawSet.participants
    if (!Array.isArray(rawMembers) || rawMembers.length !== 3) {
      invalid(configPath, `${fieldPath}.participants`, "expected exactly three participant IDs")
    }
    const members = rawMembers.map((value, index) => {
      const member = optionalNonEmptyString(value, configPath, `${fieldPath}.participants[${index}]`)
      if (member === undefined) {
        invalid(configPath, `${fieldPath}.participants[${index}]`, "expected a non-empty string")
      }
      return member
    })
    if (new Set(members).size !== 3) {
      invalid(configPath, `${fieldPath}.participants`, "expected three distinct participant IDs")
    }
    for (const [index, participant] of members.entries()) {
      if (!Object.hasOwn(participantsConfig, participant)) {
        invalid(
          configPath,
          `${fieldPath}.participants[${index}]`,
          `unknown participant: ${participant}`,
        )
      }
    }

    const parsedSet: ParticipantSetConfig = {
      participants: members as [string, string, string],
    }
    if (Object.hasOwn(rawSet, "default")) {
      if (markedDefault !== undefined) {
        invalid(
          configPath,
          `${fieldPath}.default`,
          `only one set may specify default; already specified by sets.${markedDefault}.default`,
        )
      }
      if (rawSet.default !== "yes") {
        invalid(configPath, `${fieldPath}.default`, "expected the string yes")
      }
      parsedSet.default = "yes"
      markedDefault = setName
    }
    sets[setName] = parsedSet
  }

  return {
    version: 2,
    participants: participantsConfig,
    sets,
    defaultSet: markedDefault ?? setOrder[0],
  }
}

function normaliseRegistry(config: ParticipantConfig): DebateRegistry {
  const participants = Object.entries(config.participants).map(([agent, participant]) => Object.freeze({
    agent,
    description: participant.description ?? `Neutral debate participant using ${participant.model}`,
    model: participant.model,
    ...(participant.variant === undefined ? {} : { variant: participant.variant }),
  }))
  const sets = Object.fromEntries(
    Object.entries(config.sets).map(([name, set]) => [name, Object.freeze([...set.participants])]),
  )
  return Object.freeze({
    participants: Object.freeze(participants),
    sets: Object.freeze(sets),
    defaultSet: config.defaultSet,
  })
}

export function loadPackagedRegistry(configPath: string = PACKAGED_CONFIG_PATH): DebateRegistry {
  const absolutePath = resolve(configPath)
  return normaliseRegistry(parseParticipantConfig(readConfigSource(absolutePath), absolutePath))
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

export function ensureUserConfig(packagedPath: string, userPath: string): void {
  const absolutePackagedPath = resolve(packagedPath)
  const absoluteUserPath = resolve(userPath)
  const source = readConfigSource(absolutePackagedPath)
  parseParticipantConfig(source, absolutePackagedPath)
  if (existsSync(absoluteUserPath)) return

  const directory = dirname(absoluteUserPath)
  const temporaryPath = join(
    directory,
    `.${basename(absoluteUserPath)}.${process.pid}.${randomUUID()}.tmp`,
  )
  let operationError: unknown
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporaryPath, source, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    })
    try {
      linkSync(temporaryPath, absoluteUserPath)
    } catch (error) {
      if (!hasCode(error, "EEXIST")) operationError = error
    }
  } catch (error) {
    operationError = error
  }

  try {
    unlinkSync(temporaryPath)
  } catch (error) {
    if (!hasCode(error, "ENOENT") && operationError === undefined) operationError = error
  }
  if (operationError !== undefined) {
    throw new DebateConfigFileError(absoluteUserPath, "create", operationError)
  }
}

export function loadEffectiveRegistry(options: ParticipantConfigPaths = {}): DebateRegistry {
  const packagedPath = resolve(options.packagedPath ?? PACKAGED_CONFIG_PATH)
  const userPath = resolve(options.userPath ?? resolveUserConfigPath())
  ensureUserConfig(packagedPath, userPath)
  return normaliseRegistry(parseParticipantConfig(readConfigSource(userPath), userPath))
}

export const DEBATE_REGISTRY = loadPackagedRegistry()
export const DEBATE_PARTICIPANTS = DEBATE_REGISTRY.participants
export const DEBATE_PARTICIPANT_SETS = DEBATE_REGISTRY.sets

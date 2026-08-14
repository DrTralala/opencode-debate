import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tool, type Config, type Plugin, type ToolDefinition } from "@opencode-ai/plugin"
import {
  PERSIST_DEBATE_TRANSCRIPT_TOOL,
  createTranscriptPersistenceTool,
} from "./transcript-persistence.ts"

export type DebateResponseSchema = "round1" | "round2"

export const FORMAT_DEBATE_RESPONSE_TOOL = "format_debate_response"

export type RunResponseFormatterOptions = {
  moduleUrl?: string
  env?: NodeJS.ProcessEnv
}

type PermissionAction = "allow" | "ask" | "deny"
type PermissionConfiguration = PermissionAction | Record<string, unknown>
const COORDINATOR_ONLY_TOOLS = [
  FORMAT_DEBATE_RESPONSE_TOOL,
  PERSIST_DEBATE_TRANSCRIPT_TOOL,
] as const

export function responseFormatterScriptPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../scripts/format_response.py", moduleUrl))
}

export function runResponseFormatter(
  response: string,
  schema: DebateResponseSchema,
  options: RunResponseFormatterOptions = {},
): string {
  const result = spawnSync(
    "python3",
    [responseFormatterScriptPath(options.moduleUrl), "--schema", schema],
    {
      encoding: "utf8",
      input: response,
      shell: false,
      ...(options.env === undefined ? {} : { env: options.env }),
    },
  )

  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      throw new Error("Unable to run debate response formatter: python3 was not found on PATH")
    }
    throw new Error(`Unable to run debate response formatter: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const diagnostic = result.stderr.trim()
    throw new Error(
      diagnostic || `Debate response formatter exited with status ${result.status ?? "unknown"}`,
    )
  }
  return result.stdout.trimEnd()
}

export function createResponseFormatterTool(moduleUrl: string = import.meta.url): ToolDefinition {
  return tool({
    description: "Validate and canonicalise a debate participant response.",
    args: {
      response: tool.schema.string().describe("Participant response text to validate and canonicalise."),
      schema: tool.schema.enum(["round1", "round2"]).describe("Debate response schema to enforce."),
    },
    async execute({ response, schema }) {
      return runResponseFormatter(response, schema, { moduleUrl })
    },
  })
}

function withCoordinatorToolPermissions(
  permission: PermissionConfiguration | undefined,
  action: PermissionAction,
): Record<string, unknown> {
  const normalised = typeof permission === "object" && permission !== null
    ? permission
    : permission === undefined
      ? {}
      : { "*": permission }
  return Object.fromEntries([
    ...Object.entries(normalised).filter(([key]) => !COORDINATOR_ONLY_TOOLS.includes(key as typeof COORDINATOR_ONLY_TOOLS[number])),
    ...COORDINATOR_ONLY_TOOLS.map((toolName) => [toolName, action] as const),
  ])
}

function configureCoordinatorToolPermissions(config: Config): void {
  config.permission = withCoordinatorToolPermissions(
    config.permission as PermissionConfiguration | undefined,
    "deny",
  ) as typeof config.permission

  for (const [agentName, agentConfig] of Object.entries(config.agent ?? {})) {
    if (agentConfig === undefined) continue
    agentConfig.permission = withCoordinatorToolPermissions(
      agentConfig.permission as PermissionConfiguration | undefined,
      agentName === "debate" ? "allow" : "deny",
    ) as typeof agentConfig.permission
  }
}

export const ResponseFormatterPlugin: Plugin = async () => ({
  tool: {
    [FORMAT_DEBATE_RESPONSE_TOOL]: createResponseFormatterTool(),
    [PERSIST_DEBATE_TRANSCRIPT_TOOL]: createTranscriptPersistenceTool(),
  },
  config: async (config) => {
    configureCoordinatorToolPermissions(config)
  },
})

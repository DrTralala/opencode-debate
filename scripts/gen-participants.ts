import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DEBATE_PARTICIPANTS, type DebateParticipant } from "../src/participants.ts"

type GenerateOptions = {
  root?: string
  body?: string
  participants?: readonly DebateParticipant[]
}

type CheckResult = {
  changed: string[]
}

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BODY_PATH = "scripts/debate-participant-body.md"
const AGENT_DIR = ".opencode/agents"
const COORDINATOR_PATH = `${AGENT_DIR}/debate.md`

export function renderParticipantAgent(participant: DebateParticipant, body: string): string {
  return [
    "---",
    `description: ${participant.description}`,
    "mode: subagent",
    "hidden: true",
    `model: ${participant.model}`,
    ...(participant.variant === undefined ? [] : [`variant: ${participant.variant}`]),
    "permission:",
    '  "*": "deny"',
    "  read:",
    '    "*": "allow"',
    '    "*.env": "deny"',
    '    "*.env.*": "deny"',
    '    "*.env.example": "allow"',
    "  grep: allow",
    "  glob: allow",
    "  lsp: allow",
    "  webfetch: allow",
    "  websearch: allow",
    "  external_directory: deny",
    "  bash: deny",
    "  edit: deny",
    "  question: deny",
    "  task: deny",
    "  skill: deny",
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n")
}

export function renderCoordinatorAgent(
  source: string,
  participants: readonly DebateParticipant[],
): string {
  const lines = source.split("\n")
  if (lines[0] !== "---") throw new Error("Coordinator agent must begin with YAML frontmatter")

  const frontmatterEnd = lines.indexOf("---", 1)
  if (frontmatterEnd === -1) throw new Error("Coordinator agent YAML frontmatter is not closed")

  const taskLines: number[] = []
  for (let index = 1; index < frontmatterEnd; index++) {
    if (lines[index] === "  task:") taskLines.push(index)
  }
  if (taskLines.length !== 1) {
    throw new Error(`Coordinator agent must contain exactly one permission task block; found ${taskLines.length}`)
  }

  const taskLine = taskLines[0]
  let taskEnd = taskLine + 1
  while (taskEnd < frontmatterEnd && lines[taskEnd].startsWith("    ")) taskEnd++

  const permissions = [
    '    "*": "deny"',
    ...participants.map(({ agent }) => `    "${agent}": "allow"`),
  ]
  return [...lines.slice(0, taskLine + 1), ...permissions, ...lines.slice(taskEnd)].join("\n")
}

export function checkParticipantAgents(options: GenerateOptions = {}): CheckResult {
  const root = options.root ?? DEFAULT_ROOT
  const body = options.body ?? readFileSync(join(root, BODY_PATH), "utf8")
  const participants = options.participants ?? DEBATE_PARTICIPANTS
  const changed: string[] = []

  for (const participant of participants) {
    const relativePath = `${AGENT_DIR}/${participant.agent}.md`
    const absolutePath = join(root, relativePath)
    const expected = renderParticipantAgent(participant, body)
    const actual = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : ""
    if (actual !== expected) changed.push(relativePath)
  }

  const coordinatorPath = join(root, COORDINATOR_PATH)
  if (!existsSync(coordinatorPath)) {
    changed.push(COORDINATOR_PATH)
  } else {
    const actual = readFileSync(coordinatorPath, "utf8")
    const expected = renderCoordinatorAgent(actual, participants)
    if (actual !== expected) changed.push(COORDINATOR_PATH)
  }

  return { changed }
}

export function writeParticipantAgents(options: GenerateOptions = {}): void {
  const root = options.root ?? DEFAULT_ROOT
  const body = options.body ?? readFileSync(join(root, BODY_PATH), "utf8")
  const participants = options.participants ?? DEBATE_PARTICIPANTS

  for (const participant of participants) {
    const absolutePath = join(root, AGENT_DIR, `${participant.agent}.md`)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, renderParticipantAgent(participant, body))
  }

  const coordinatorPath = join(root, COORDINATOR_PATH)
  if (!existsSync(coordinatorPath)) {
    throw new Error(`Coordinator agent file not found: ${coordinatorPath}`)
  }
  const coordinator = readFileSync(coordinatorPath, "utf8")
  writeFileSync(coordinatorPath, renderCoordinatorAgent(coordinator, participants))
}

function main(argv: string[]): number {
  if (argv.includes("--check")) {
    const result = checkParticipantAgents()
    if (result.changed.length === 0) return 0

    console.error("Generated participant agents are stale:")
    for (const file of result.changed) console.error(`- ${file}`)
    console.error("Run: node scripts/gen-participants.ts")
    return 1
  }

  writeParticipantAgents()
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}

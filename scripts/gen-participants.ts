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

export function renderParticipantAgent(participant: DebateParticipant, body: string): string {
  return [
    "---",
    `description: ${participant.description}`,
    "mode: subagent",
    `model: ${participant.model}`,
    `variant: ${participant.variant}`,
    "permission:",
    "  edit: deny",
    "  task: deny",
    "  question: deny",
    "  bash:",
    '    "*": "deny"',
    '    "cat *": "allow"',
    '    "grep *": "allow"',
    '    "rg *": "allow"',
    '    "ls": "allow"',
    '    "ls *": "allow"',
    '    "find *": "allow"',
    '    "head *": "allow"',
    '    "tail *": "allow"',
    '    "wc *": "allow"',
    '    "pwd": "allow"',
    '    "echo *": "allow"',
    '    "git status": "allow"',
    '    "git status *": "allow"',
    '    "git diff *": "allow"',
    '    "git log *": "allow"',
    '    "git show *": "allow"',
    '    "git blame *": "allow"',
    '    "node --version": "allow"',
    '    "node -v": "allow"',
    '    "npm --version": "allow"',
    '    "npm -v": "allow"',
    "---",
    "",
    body.trimEnd(),
    "",
  ].join("\n")
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

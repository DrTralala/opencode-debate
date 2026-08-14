import { spawnSync } from "node:child_process"
import { lstatSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { tool, type ToolDefinition } from "@opencode-ai/plugin"

export const PERSIST_DEBATE_TRANSCRIPT_TOOL = "persist_debate_transcript"
const DATE_PLACEHOLDER = "<timestamp>"
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type TranscriptPersistenceOptions = {
  directory?: string
  now?: () => Date
  moduleUrl?: string
  pythonExecutable?: string
  publisherPythonExecutable?: string
  publicationBarrier?: string
  generationBarrier?: string
  postPublicationBarrier?: string
}

export type TranscriptPersistenceResult = {
  markdownPath: string
  htmlPath?: string
  generationError?: string
}

function persistenceScriptPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../scripts/generate_html.py", moduleUrl))
}

function publicationScriptPath(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../scripts/publish_transcript.py", moduleUrl))
}

function utcDate(now: () => Date): string {
  const value = now()
  if (Number.isNaN(value.getTime())) throw new Error("Current date is invalid")
  return value.toISOString().slice(0, 10)
}

function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error("slug must be lowercase kebab-case using letters, numbers, and single hyphens")
  }
}

function replaceDatePlaceholder(markdown: string, date: string): string {
  const placeholder = new RegExp(`^\\*\\*Date:\\*\\* ${DATE_PLACEHOLDER}$`, "gm")
  const matches = [...markdown.matchAll(placeholder)]
  if (matches.length !== 1) {
    throw new Error(`Markdown must contain exactly one **Date:** ${DATE_PLACEHOLDER} date placeholder`)
  }
  const match = matches[0]
  return `${markdown.slice(0, match.index)}**Date:** ${date}${markdown.slice(match.index + match[0].length)}`
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

function assertNoSymlinkComponents(path: string, label: string): void {
  const absolutePath = resolve(path)
  const components = absolutePath.split(sep).filter(Boolean)
  let current = isAbsolute(absolutePath) ? sep : ""
  for (const component of components) {
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} path components must not be symlinks: ${current}`)
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue
      throw error
    }
  }
}

function assertDirectory(path: string, label: string): boolean {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path must not be a symlink: ${path}`)
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} path must be a directory: ${path}`)
    }
    return true
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false
    throw error
  }
}

function verifyTranscriptDirectory(directory: string): string {
  const projectDirectory = resolve(directory)
  assertNoSymlinkComponents(projectDirectory, "Project")
  if (!assertDirectory(projectDirectory, "Project")) {
    throw new Error(`Project directory does not exist: ${projectDirectory}`)
  }

  const docsDirectory = join(projectDirectory, "docs")
  const transcriptDirectory = join(docsDirectory, "debates")
  assertNoSymlinkComponents(docsDirectory, "Transcript")
  assertNoSymlinkComponents(transcriptDirectory, "Transcript")
  assertDirectory(docsDirectory, "docs")
  assertDirectory(transcriptDirectory, "Transcript")
  return projectDirectory
}

function runPython(
  scriptPath: string,
  args: string[],
  input: string,
  directory: string,
  options: TranscriptPersistenceOptions,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(options.pythonExecutable ?? "python3", [scriptPath, ...args], {
    cwd: directory,
    encoding: "utf8",
    input,
    shell: false,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error === undefined ? {} : { error: result.error }),
  }
}

function conciseError(result: ReturnType<typeof runPython>): string {
  if (result.error) {
    if ("code" in result.error && result.error.code === "ENOENT") {
      return "python3 was not found on PATH"
    }
    return result.error.message
  }
  const detail = result.stderr.trim() || result.stdout.trim()
  return detail.replace(/^generate_html:\s*/, "").replace(/\s+/g, " ")
    || `generator exited with status ${result.status ?? "unknown"}`
}

function validateMarkdown(
  markdown: string,
  directory: string,
  options: TranscriptPersistenceOptions,
  args: string[],
): void {
  const result = runPython(
    persistenceScriptPath(options.moduleUrl),
    ["--validate-stdin", ...args],
    markdown,
    directory,
    options,
  )
  if (result.error || result.status !== 0) {
    throw new Error(`Invalid canonical Markdown: ${conciseError(result)}`)
  }
}

function publishMarkdown(
  projectDirectory: string,
  date: string,
  slug: string,
  markdown: string,
  options: TranscriptPersistenceOptions,
): { markdownPath: string; publicationToken: string } {
  const result = runPython(
    publicationScriptPath(options.moduleUrl),
    [
      "--project",
      projectDirectory,
      "--date",
      date,
      "--slug",
      slug,
      ...(options.publicationBarrier === undefined
        ? []
        : ["--barrier", options.publicationBarrier]),
    ],
    markdown,
    projectDirectory,
    {
      ...options,
      pythonExecutable: options.publisherPythonExecutable ?? "python3",
    },
  )
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to publish Markdown transcript: ${conciseError(result)}`)
  }
  try {
    const parsed = JSON.parse(result.stdout)
    if (
      !parsed
      || typeof parsed.filename !== "string"
      || typeof parsed.publicationToken !== "string"
    ) throw new Error("invalid publisher output")
    return {
      markdownPath: join(projectDirectory, "docs", "debates", parsed.filename),
      publicationToken: parsed.publicationToken,
    }
  } catch (error) {
    throw new Error(`Unable to publish Markdown transcript: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function persistDebateTranscript(
  markdown: string,
  slug: string,
  options: TranscriptPersistenceOptions = {},
): TranscriptPersistenceResult {
  const directory = options.directory ?? process.cwd()
  validateSlug(slug)
  const projectDirectory = verifyTranscriptDirectory(directory)
  const date = utcDate(options.now ?? (() => new Date()))
  try {
    validateMarkdown(markdown, projectDirectory, options, ["--date-placeholder"])
  } catch (error) {
    if (error instanceof Error && /Missing required metadata: Date/.test(error.message)) {
      throw new Error("Invalid canonical Markdown: Date placeholder must be the top-level Date metadata field")
    }
    throw error
  }
  const datedMarkdown = replaceDatePlaceholder(
    markdown,
    date,
  )
  validateMarkdown(
    datedMarkdown,
    projectDirectory,
    options,
    ["--date-only", date],
  )

  const publication = publishMarkdown(
    projectDirectory,
    date,
    slug,
    datedMarkdown,
    options,
  )

  const generated = runPython(
    persistenceScriptPath(options.moduleUrl),
    [
      publication.markdownPath,
      "--publication-token",
      publication.publicationToken,
      ...(options.generationBarrier === undefined
        ? []
        : ["--generation-barrier", options.generationBarrier]),
      ...(options.postPublicationBarrier === undefined
        ? []
        : ["--post-publication-barrier", options.postPublicationBarrier]),
    ],
    "",
    projectDirectory,
    options,
  )
  if (generated.error || generated.status !== 0) {
    return {
      markdownPath: publication.markdownPath,
      generationError: conciseError(generated),
    }
  }
  return {
    markdownPath: publication.markdownPath,
    htmlPath: publication.markdownPath.replace(/\.md$/, ".html"),
  }
}

function displayPath(path: string, directory: string): string {
  return relative(directory, path).replaceAll("\\", "/")
}

export function createTranscriptPersistenceTool(
  options: TranscriptPersistenceOptions = {},
): ToolDefinition {
  return tool({
    description: "Persist a validated debate transcript and generate its sibling HTML file.",
    args: {
      markdown: tool.schema.string().describe("Canonical Markdown transcript with a <timestamp> date placeholder."),
      slug: tool.schema.string().describe("Lowercase kebab-case transcript slug."),
    },
    async execute({ markdown, slug }, context) {
      const directory = options.directory ?? context.directory
      const result = persistDebateTranscript(markdown, slug, { ...options, directory })
      const lines = [`Markdown: ${displayPath(result.markdownPath, directory)}`]
      if (result.htmlPath) {
        lines.push(`HTML: ${displayPath(result.htmlPath, directory)}`)
      } else {
        lines.push(`HTML generation failed: ${result.generationError}`)
      }
      return lines.join("\n")
    },
  })
}

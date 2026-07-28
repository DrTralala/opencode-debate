#!/usr/bin/env node
import process from "node:process"
import { pathToFileURL } from "node:url"
import { marked } from "marked"
import sanitizeHtml from "sanitize-html"

const SANITIZE_OPTIONS = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr", "blockquote",
    "ul", "ol", "li",
    "pre", "code", "strong", "em", "del", "a",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  allowedAttributes: {
    a: ["href", "title"],
    ol: ["start"],
    th: ["align"],
    td: ["align"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowProtocolRelative: false,
  disallowedTagsMode: "escape",
}

export function renderMarkdown(markdown) {
  if (typeof markdown !== "string") {
    throw new TypeError("Markdown items must be strings")
  }
  const rendered = marked.parse(markdown, { async: false, gfm: true })
  if (typeof rendered !== "string") {
    throw new TypeError("Markdown parser returned a non-string result")
  }
  return sanitizeHtml(rendered, SANITIZE_OPTIONS)
}

export function renderItems(payload) {
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.items)) {
    throw new TypeError("Input must be an object with an items array")
  }
  if (!payload.items.every((item) => typeof item === "string")) {
    throw new TypeError("Input items must be strings")
  }
  return { html: payload.items.map(renderMarkdown) }
}

async function main() {
  let input = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) input += chunk
  const payload = JSON.parse(input)
  process.stdout.write(JSON.stringify(renderItems(payload)))
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`render_markdown: ${message}\n`)
    process.exitCode = 1
  })
}

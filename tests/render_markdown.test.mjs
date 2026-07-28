import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const helperUrl = new URL("../scripts/render_markdown.mjs", import.meta.url)
const helperPath = fileURLToPath(helperUrl)

test("renders normal debate Markdown", async () => {
  const { renderMarkdown } = await import(helperUrl)
  const html = renderMarkdown(`## Verdict

**Ship it** with:

- tests
- documentation

| Check | Result |
|---|---|
| CI | Pass |

\`inline\` and:

\`\`\`js
const ready = true
\`\`\`
`)

  assert.match(html, /<h2>Verdict<\/h2>/)
  assert.match(html, /<strong>Ship it<\/strong>/)
  assert.match(html, /<ul>/)
  assert.match(html, /<table>/)
  assert.match(html, /<code>inline<\/code>/)
  assert.match(html, /<pre><code/)
})

test("removes executable and embedded HTML", async () => {
  const { renderMarkdown } = await import(helperUrl)
  const html = renderMarkdown(`<script>alert(1)</script>

<img src=x onerror="alert(2)">

<strong onclick="alert(3)">bold</strong>

[unsafe](javascript:alert(4))

[safe](https://example.com "Example")`)

  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /<img/i)
  assert.doesNotMatch(html, /onclick=/i)
  assert.doesNotMatch(html, /href="javascript:/i)
  assert.match(html, /href="https:\/\/example\.com"/)
})

test("validates the batch payload", async () => {
  const { renderItems } = await import(helperUrl)
  assert.equal(renderItems({ items: ["**one**", "two"] }).html.length, 2)
  assert.throws(() => renderItems(null), /items/)
  assert.throws(() => renderItems({ items: [1] }), /strings/)
})

test("CLI returns JSON and rejects invalid input", () => {
  const good = spawnSync(process.execPath, [helperPath], {
    input: JSON.stringify({ items: ["**safe**"] }),
    encoding: "utf8",
  })
  assert.equal(good.status, 0, good.stderr)
  const output = JSON.parse(good.stdout)
  assert.equal(output.html.length, 1)
  assert.match(output.html[0], /<strong>safe<\/strong>/)

  const bad = spawnSync(process.execPath, [helperPath], {
    input: "not-json",
    encoding: "utf8",
  })
  assert.notEqual(bad.status, 0)
  assert.equal(bad.stdout, "")
  assert.match(bad.stderr, /render_markdown:/)
})

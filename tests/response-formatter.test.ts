import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import {
  FORMAT_DEBATE_RESPONSE_TOOL,
  ResponseFormatterPlugin,
  responseFormatterScriptPath,
  runResponseFormatter,
} from "../src/response-formatter.ts"
import { createServer } from "../index.ts"
import type { DebateRegistry } from "../src/participants.ts"

const TEST_REGISTRY: DebateRegistry = {
  participants: [
    { agent: "one", description: "One", model: "provider/one" },
    { agent: "two", description: "Two", model: "provider/two" },
    { agent: "three", description: "Three", model: "provider/three" },
  ],
  sets: { default: ["one", "two", "three"] },
  defaultSet: "default",
}

function finalMatchingAction(
  permission: Record<string, string>,
  toolName: string,
): string | undefined {
  let action: string | undefined
  for (const [pattern, candidate] of Object.entries(permission)) {
    if (pattern === "*" || pattern === toolName) action = candidate
  }
  return action
}

async function applyRuntimeConfig(config: any): Promise<any> {
  const hooks = await createServer(() => TEST_REGISTRY)({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const configHook = hooks.config
  assert.ok(configHook)
  await configHook(config)
  return config
}

test("formatter script resolves relative to the installed package module", () => {
  assert.equal(
    responseFormatterScriptPath("file:///opt/opencode-debate/src/response-formatter.ts"),
    "/opt/opencode-debate/scripts/format_response.py",
  )
})

test("formatter wrapper sends the response through stdin and returns canonical JSON", () => {
  assert.equal(
    runResponseFormatter('prefix {"turn":"line 1\\nline 2"} suffix', "round1"),
    '{"turn": "line 1\\nline 2"}',
  )
})

test("formatter wrapper propagates strict formatter diagnostics", () => {
  assert.throws(
    () => runResponseFormatter('{"turn":""}', "round1"),
    /format_response: turn must be a non-empty string/,
  )
})

test("formatter wrapper reports when python3 is unavailable", (t) => {
  const emptyPath = mkdtempSync(join(tmpdir(), "debate-no-python-"))
  t.after(() => rmSync(emptyPath, { recursive: true, force: true }))

  assert.throws(
    () => runResponseFormatter('{"turn":"valid"}', "round1", {
      env: { ...process.env, PATH: emptyPath },
    }),
    /python3.*PATH/i,
  )
})

test("formatter wrapper invokes python3 directly without a shell", (t) => {
  const root = mkdtempSync(join(tmpdir(), "debate-no-shell-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, "bin")
  const marker = join(root, "shell-injected")
  mkdirSync(bin)
  const fakePython = join(bin, "python3")
  writeFileSync(fakePython, "#!/bin/sh\nprintf '%s\\n' '{\"turn\": \"safe\"}'\n")
  chmodSync(fakePython, 0o755)
  const dangerousModuleUrl = pathToFileURL(
    join(root, "plugin;touch${IFS}$FORMATTER_MARKER;#", "src", "response-formatter.ts"),
  ).href

  const output = runResponseFormatter('{"turn":"safe"}', "round1", {
    moduleUrl: dangerousModuleUrl,
    env: {
      ...process.env,
      PATH: bin,
      FORMATTER_MARKER: marker,
    },
  })

  assert.equal(output, '{"turn": "safe"}')
  assert.equal(existsSync(marker), false)
})

test("response formatter plugin registers an executable custom tool", async () => {
  const hooks = await ResponseFormatterPlugin({} as never)
  const formatter = hooks.tool?.[FORMAT_DEBATE_RESPONSE_TOOL]
  assert.ok(formatter)

  assert.equal(
    await formatter.execute({ response: '{"turn":"plugin"}', schema: "round1" }, {} as never),
    '{"turn": "plugin"}',
  )
})

test("project-local plugin bridge satisfies the OpenCode v1.17.13 file-plugin loader", () => {
  const pluginUrl = new URL("../.opencode/plugin/debate.ts", import.meta.url).href
  const script = [
    `const bridge = await import(${JSON.stringify(pluginUrl)})`,
    "const seen = new Set()",
    "const plugins = []",
    "for (const entry of Object.values(bridge)) {",
    "  if (seen.has(entry)) continue",
    "  seen.add(entry)",
    "  const plugin = typeof entry === 'function'",
    "    ? entry",
    "    : entry && typeof entry === 'object' && typeof entry.server === 'function'",
    "      ? entry.server",
    "      : undefined",
    "  if (!plugin) throw new TypeError('Plugin export is not a function')",
    "  plugins.push(plugin)",
    "}",
    "const hooks = []",
    "for (const plugin of plugins) hooks.push(await plugin({}))",
    "if (!hooks.some((candidate) => candidate['command.execute.before'])) process.exit(1)",
    "if (!hooks.some((candidate) => candidate.tool?.format_debate_response)) process.exit(1)",
  ].join("\n")
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  )

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test("installed plugin server registers the response formatter tool", async () => {
  const hooks = await createServer(() => TEST_REGISTRY)({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const formatter = hooks.tool?.[FORMAT_DEBATE_RESPONSE_TOOL]
  assert.ok(formatter)

  assert.equal(
    await formatter.execute({ response: '{"turn":"server"}', schema: "round1" }, {} as never),
    '{"turn": "server"}',
  )
})

test("runtime permissions allow only the debate coordinator to format responses", async () => {
  const hooks = await createServer(() => TEST_REGISTRY)({
    client: { app: { log: async () => ({ data: true }) } },
    directory: "/tmp/project",
    worktree: "/tmp/project",
  } as never)
  const configHook = hooks.config
  assert.ok(configHook)
  const config: any = {
    permission: {
      read: "allow",
      [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
    },
    agent: {
      build: {
        permission: {
          edit: "allow",
          [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
        },
      },
      reviewer: { permission: "allow" },
    },
  }

  await configHook(config)

  assert.equal(config.permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  assert.equal(config.agent.build.permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  assert.equal(config.agent.reviewer.permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  assert.equal(config.agent.debate.permission[FORMAT_DEBATE_RESPONSE_TOOL], "allow")
  for (const participant of TEST_REGISTRY.participants) {
    assert.equal(config.agent[participant.agent].permission[FORMAT_DEBATE_RESPONSE_TOOL], "deny")
  }
})

test("global formatter denial is the final matching permission after a wildcard allow", async () => {
  const config = await applyRuntimeConfig({
    permission: {
      [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
      "*": "allow",
    },
  })

  assert.equal(
    finalMatchingAction(config.permission, FORMAT_DEBATE_RESPONSE_TOOL),
    "deny",
  )
})

test("non-coordinator formatter denial is the final matching permission after a wildcard allow", async () => {
  const config = await applyRuntimeConfig({
    agent: {
      build: {
        permission: {
          [FORMAT_DEBATE_RESPONSE_TOOL]: "allow",
          "*": "allow",
        },
      },
    },
  })

  assert.equal(
    finalMatchingAction(config.agent.build.permission, FORMAT_DEBATE_RESPONSE_TOOL),
    "deny",
  )
})

test("coordinator formatter allow remains the final matching permission", async () => {
  const config = await applyRuntimeConfig({})

  assert.equal(
    finalMatchingAction(config.agent.debate.permission, FORMAT_DEBATE_RESPONSE_TOOL),
    "allow",
  )
})

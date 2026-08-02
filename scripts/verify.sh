#!/usr/bin/env sh
set -eu

# Static repository contract checks plus Python and Node behavioural suites and
# TypeScript typechecking. Run with: sh scripts/verify.sh (after `npm install`).

fail() {
  printf '%s\n' "verify: $*" >&2
  exit 1
}

assert_tracked() {
  git ls-files --error-unmatch "$1" >/dev/null 2>&1 || fail "required tracked file missing: $1"
}

assert_not_tracked() {
  [ -z "$(git ls-files -- "$1")" ] || fail "local-only artefact is tracked: $1"
}

assert_present() {
  [ -f "$1" ] || fail "required file missing: $1"
}

assert_contains() {
  file=$1
  pattern=$2
  grep -Fq -- "$pattern" "$file" || fail "$file does not contain: $pattern"
}

assert_not_contains() {
  file=$1
  pattern=$2
  ! grep -Fq -- "$pattern" "$file" || fail "$file should not contain: $pattern"
}

assert_line() {
  file=$1
  line=$2
  grep -Fxq -- "$line" "$file" || fail "$file does not contain exact line: $line"
}

assert_not_line() {
  file=$1
  line=$2
  ! grep -Fxq -- "$line" "$file" || fail "$file should not contain exact line: $line"
}

# Required files.
assert_tracked ".opencode/commands/debate.md"
assert_tracked ".opencode/plugin/debate.ts"
assert_tracked "index.ts"
assert_present "config.yaml"
assert_tracked "LICENSE"
assert_tracked "tests/debate.test.ts"
assert_present "tests/participants.test.ts"
assert_tracked "tests/test_generate_html.py"
assert_tracked "tests/test_format_response.py"
assert_tracked ".opencode/agents/debate.md"
assert_tracked ".opencode/agents/debate-openai.md"
assert_tracked ".opencode/agents/debate-glm.md"
assert_tracked ".opencode/agents/debate-kimi.md"
assert_tracked ".opencode/agents/debate-anthropic.md"
assert_tracked ".opencode/agents/debate-qwen.md"
assert_tracked ".github/workflows/verify.yml"
assert_tracked ".github/workflows/publish.yml"
assert_tracked ".gitignore"
assert_tracked "package.json"
assert_tracked "package-lock.json"
assert_tracked "tsconfig.json"
assert_tracked "src/participants.ts"
assert_tracked "src/response-formatter.ts"
assert_tracked "scripts/debate-participant-body.md"
assert_tracked "scripts/gen-participants.ts"
assert_tracked "scripts/generate_html.py"
assert_tracked "scripts/format_response.py"
assert_tracked "scripts/render_markdown.mjs"
assert_tracked "scripts/check_package.mjs"
assert_tracked "scripts/verify.sh"
assert_tracked "README.md"
assert_tracked "tests/render_markdown.test.mjs"
assert_tracked "tests/check_package.test.mjs"
assert_tracked "tests/response-formatter.test.ts"
assert_tracked "tests/publish_workflow.test.mjs"

# npm publication metadata.
assert_not_contains "package.json" '"private"'
assert_contains "package.json" '"author": "DrTralala <drtralala@outlook.com>"'
assert_contains "package.json" '"files": ['
assert_contains "package.json" '"config.yaml"'
assert_contains "package.json" '"yaml": "2.9.0"'
assert_contains "package.json" '"scripts/generate_html.py"'
assert_contains "package.json" '"scripts/format_response.py"'
assert_contains "package.json" '"publishConfig": {'
assert_contains "package.json" '"access": "public"'
assert_contains "README.md" '"opencode-debate@latest"'
assert_contains "README.md" '"opencode-debate@2.1.0"'
assert_not_contains "README.md" 'git+https://github.com/DrTralala/opencode-debate.git'
assert_not_contains "README.md" 'this package is not published to npm'
assert_contains "README.md" 'https://github.com/DrTralala/opencode-debate/tree/v2.1.0'
assert_contains "README.md" 'img.shields.io/badge/version-v2.1.0-blue.svg?style=flat-square'
assert_contains "README.md" 'Python 3.9 or later'
assert_contains "README.md" 'docs/debates/'
assert_contains "README.md" 'GPT-5.6 Sol, `xhigh`'
assert_contains "README.md" '${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-debate/config.yaml'
assert_contains "README.md" 'atomically creates it as an exact copy'
assert_contains "README.md" 'complete, authoritative version 2 configuration'
assert_contains "README.md" 'first set in YAML source order'
assert_contains "README.md" 'quit and restart OpenCode'
assert_contains "README.md" 'exact participant name manually with `@name`'
assert_not_contains "README.md" 'Participant fields merge by participant ID'
assert_not_contains "README.md" 'missing user file silently uses packaged defaults'
assert_not_contains "README.md" 'GPT-5.6 Sol Pro'
assert_not_contains "package.json" 'Trevor Leong <drtralala@outlook.com>'

# Local-only artefacts must not be tracked.
assert_not_tracked ".opencode/package.json"
assert_not_tracked ".opencode/package-lock.json"
assert_not_tracked ".opencode/node_modules"
assert_not_tracked "node_modules"
assert_not_tracked "docs"

# .gitignore covers local dependencies, transcripts, credentials, and Python caches.
assert_contains ".gitignore" "node_modules/"
assert_contains ".gitignore" ".opencode/package.json"
assert_line ".gitignore" "docs/"
assert_not_line ".gitignore" "docs/debates/"
assert_line ".gitignore" ".env"
assert_line ".gitignore" ".env.*"
assert_line ".gitignore" "!.env.example"
assert_line ".gitignore" "__pycache__/"

# README badges describe only services and requirements this repository uses.
assert_contains "README.md" '[![CI]('
assert_contains "README.md" 'actions/workflows/verify.yml/badge.svg'
assert_contains "README.md" '](./LICENSE)'
assert_contains "README.md" 'img.shields.io/badge/License-MIT-blue.svg?style=flat-square'
assert_contains "README.md" '](https://nodejs.org/)'
assert_contains "README.md" 'img.shields.io/badge/Node-%3E%3D24.15.0-339933.svg?style=flat-square'
assert_not_contains "README.md" 'img.shields.io/npm'

# npm publishing is release-only and uses GitHub OIDC without a persistent token.
assert_contains ".github/workflows/publish.yml" "release:"
assert_contains ".github/workflows/publish.yml" "types: [published]"
assert_contains ".github/workflows/publish.yml" "id-token: write"
assert_contains ".github/workflows/publish.yml" "contents: read"
assert_contains ".github/workflows/publish.yml" "npm publish"
assert_not_contains ".github/workflows/publish.yml" "NPM_TOKEN"
assert_not_contains ".github/workflows/publish.yml" "NODE_AUTH_TOKEN"

# Command routes to the debate agent; plugin hooks the command lifecycle.
assert_contains ".opencode/commands/debate.md" "agent: debate"
assert_contains ".opencode/plugin/debate.ts" "../../src/debate.ts"
assert_contains "src/debate.ts" "command.execute.before"
assert_contains "src/debate.ts" "DebatePlugin"

# Coordinator agent structural contract.
assert_contains ".opencode/agents/debate.md" "mode: primary"
assert_contains ".opencode/agents/debate.md" "hidden: true"
assert_contains ".opencode/agents/debate.md" '  "*": "deny"'
assert_contains ".opencode/agents/debate.md" "external_directory: deny"
assert_not_contains ".opencode/agents/debate.md" '"*": "ask"'
assert_contains ".opencode/agents/debate.md" "date -u +%Y-%m-%dT%H-%M-%SZ"
assert_contains ".opencode/agents/debate.md" "python3 scripts/generate_html.py --latest"
assert_contains ".opencode/agents/debate.md" "docs/debates/"
assert_contains ".opencode/agents/debate.md" "JSON bundle"
assert_contains ".opencode/agents/debate.md" "turn_response"
assert_contains ".opencode/agents/debate.md" "participant_number"
assert_contains ".opencode/agents/debate.md" "Do not repeat the topic"
assert_contains ".opencode/agents/debate.md" "If the maximum round count is 1"
assert_contains ".opencode/agents/debate.md" "max_rounds"
assert_contains ".opencode/agents/debate.md" "Do not run additional research"
assert_contains ".opencode/agents/debate.md" "Transcript persistence"
assert_contains ".opencode/agents/debate.md" "question: allow"
assert_contains ".opencode/agents/debate.md" "Extension decision"
assert_contains ".opencode/agents/debate.md" "effective_max_rounds"
assert_contains ".opencode/agents/debate.md" "1 more round"
assert_contains ".opencode/agents/debate.md" "3 more rounds"
assert_contains ".opencode/agents/debate.md" "Stop and synthesise now"
assert_contains ".opencode/agents/debate.md" "Write only canonical Markdown"
assert_contains ".opencode/agents/debate.md" "Do not author, edit, or repair HTML directly"
assert_contains ".opencode/agents/debate.md" "**consensus_reached:** <true|false>"
assert_contains ".opencode/agents/debate.md" "**recommend_stopping:** <true|false>"
assert_contains ".opencode/agents/debate.md" "Participant set"
assert_contains ".opencode/agents/debate.md" "debate-qwen"
assert_contains ".opencode/agents/debate.md" "After every participant response"
assert_contains ".opencode/agents/debate.md" 'format_debate_response'
assert_contains ".opencode/agents/debate.md" 'schema `round1` for round 1 and `round2` for later rounds'
assert_contains ".opencode/agents/debate.md" "before storing or forwarding"
assert_contains ".opencode/agents/debate.md" "Use only the canonical JSON returned by the formatter"
assert_contains ".opencode/agents/debate.md" "syntax-preserving repair"
assert_contains ".opencode/agents/debate.md" "For semantic/schema errors, send the exact diagnostic to the resumed participant"
assert_contains ".opencode/agents/debate.md" "exact diagnostic"
assert_contains ".opencode/agents/debate.md" "Repeat until formatting is successful"
assert_contains ".opencode/agents/debate.md" 'Record each failed formatting attempt under `## JSON Parsing Problems`'
assert_contains ".opencode/agents/debate.md" "Never infer a missing status"
assert_contains ".opencode/agents/debate.md" "Formatting failures are not participant task failures"
assert_contains ".opencode/agents/debate.md" 'In `ask` mode, use the current Question flow'
assert_contains ".opencode/agents/debate.md" 'In `discretion` mode, always make the three-way choice among Question, one autonomous extra round, or synthesis'
assert_contains ".opencode/agents/debate.md" 'Treat three false `consensus_reached` values as guidance, not a hard trigger.'
assert_contains ".opencode/agents/debate.md" "Re-evaluate after each extension"
assert_contains ".opencode/agents/debate.md" "no hard extension cap"
assert_contains ".opencode/agents/debate.md" "Retain the request topic token"
assert_contains ".opencode/agents/debate.md" '**Topic:** <!-- BEGIN TOPIC <token> -->'
assert_contains ".opencode/agents/debate.md" "<topic copied verbatim>"
assert_contains ".opencode/agents/debate.md" '<!-- END TOPIC <token> -->'
assert_not_contains ".opencode/agents/debate.md" "strip any markdown code fence, then extract the substring"
assert_not_contains ".opencode/agents/debate.md" 'treat both statuses for that participant as `false`'
assert_not_contains ".opencode/agents/debate.md" "bash: allow"

# Participant agents: mode, model+variant present (canonical source), hardened
# permissions, non-editing body. Model IDs are intentionally not hard-coded here.
for agent in debate-openai debate-glm debate-kimi debate-anthropic debate-qwen; do
  assert_contains ".opencode/agents/$agent.md" "mode: subagent"
  assert_contains ".opencode/agents/$agent.md" "hidden: true"
  assert_contains ".opencode/agents/$agent.md" "model:"
  assert_contains ".opencode/agents/$agent.md" "variant:"
  assert_contains ".opencode/agents/$agent.md" '  "*": "deny"'
  assert_contains ".opencode/agents/$agent.md" '    "*": "allow"'
  assert_contains ".opencode/agents/$agent.md" '    "*.env": "deny"'
  assert_contains ".opencode/agents/$agent.md" '    "*.env.*": "deny"'
  assert_contains ".opencode/agents/$agent.md" '    "*.env.example": "allow"'
  assert_contains ".opencode/agents/$agent.md" "grep: allow"
  assert_contains ".opencode/agents/$agent.md" "glob: allow"
  assert_contains ".opencode/agents/$agent.md" "lsp: allow"
  assert_contains ".opencode/agents/$agent.md" "webfetch: allow"
  assert_contains ".opencode/agents/$agent.md" "websearch: allow"
  assert_contains ".opencode/agents/$agent.md" "external_directory: deny"
  assert_contains ".opencode/agents/$agent.md" "bash: ask"
  assert_contains ".opencode/agents/$agent.md" "edit: deny"
  assert_contains ".opencode/agents/$agent.md" "task: deny"
  assert_contains ".opencode/agents/$agent.md" "question: deny"
  assert_contains ".opencode/agents/$agent.md" "skill: deny"
  assert_not_contains ".opencode/agents/$agent.md" '"find *"'
  assert_not_contains ".opencode/agents/$agent.md" '"echo *"'
  assert_not_contains ".opencode/agents/$agent.md" '"cat *"'
  assert_not_contains ".opencode/agents/$agent.md" '"git '
  assert_contains ".opencode/agents/$agent.md" "shell commands remain subject to OpenCode permission approval"
  assert_contains ".opencode/agents/$agent.md" 'Do not set `recommend_stopping: true` merely because the round limit has been reached.'
done

# Generated participant agents must stay in sync with the registry/template.
command -v node >/dev/null 2>&1 || fail "node is required to run the test suite"
node scripts/gen-participants.ts --check || fail "participant agents are stale; run 'node scripts/gen-participants.ts'"

# The plugin parses configured --set values and emits resolved participants.
assert_contains "src/debate.ts" "--set:"
assert_contains "src/debate.ts" "setUsage"
assert_contains "src/debate.ts" "Participant set"
assert_contains "src/debate.ts" "Resolved participants"
assert_not_contains "src/debate.ts" "DEFAULT_SET"
assert_line "config.yaml" "version: 2"
assert_contains "config.yaml" "  cheap:"

# Behavioural checks: Python and Node unit tests and TypeScript typechecking.
command -v python3 >/dev/null 2>&1 || fail "python3 is required to generate transcript HTML"
python3 -m unittest discover -s tests -p 'test_*.py' || fail "Python test suite failed"

test_output=$(node --test tests/*.test.ts tests/*.test.mjs 2>&1) || fail "test suite failed (run 'npm test' for details)"
printf '%s\n' "$test_output" | grep -Fq "MODULE_TYPELESS_PACKAGE_JSON" && fail "test suite emitted MODULE_TYPELESS_PACKAGE_JSON warning"

npm run pack:check || fail "npm package contents are incorrect"

if [ ! -x "node_modules/.bin/tsc" ]; then
  fail "typescript not installed; run 'npm install' before verifying"
fi
npm run typecheck || fail "typecheck failed"

printf '%s\n' "verify: ok"

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
assert_tracked "LICENSE"
assert_tracked "tests/debate.test.ts"
assert_tracked "tests/test_generate_html.py"
assert_tracked ".opencode/agents/debate.md"
assert_tracked ".opencode/agents/debate-openai.md"
assert_tracked ".opencode/agents/debate-glm.md"
assert_tracked ".opencode/agents/debate-kimi.md"
assert_tracked ".opencode/agents/debate-anthropic.md"
assert_tracked ".opencode/agents/debate-qwen.md"
assert_tracked ".github/workflows/verify.yml"
assert_tracked ".gitignore"
assert_tracked "package.json"
assert_tracked "package-lock.json"
assert_tracked "tsconfig.json"
assert_tracked "src/participants.ts"
assert_tracked "scripts/debate-participant-body.md"
assert_tracked "scripts/gen-participants.ts"
assert_tracked "scripts/generate_html.py"
assert_tracked "scripts/verify.sh"
assert_tracked "README.md"

# npm publication metadata.
assert_not_contains "package.json" '"private"'
assert_contains "package.json" '"author": "DrTralala <drtralala@outlook.com>"'
assert_contains "package.json" '"files": ['
assert_contains "package.json" '"scripts/generate_html.py"'
assert_contains "package.json" '"publishConfig": {'
assert_contains "package.json" '"access": "public"'
assert_contains "README.md" '"opencode-debate@latest"'
assert_contains "README.md" '"opencode-debate@0.1.5"'
assert_not_contains "README.md" 'git+https://github.com/DrTralala/opencode-debate.git'
assert_not_contains "README.md" 'this package is not published to npm'
assert_not_contains "README.md" 'tree/v0.1.5'

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
assert_contains "README.md" 'alt="CI"'
assert_contains "README.md" 'actions/workflows/verify.yml/badge.svg'
assert_contains "README.md" 'href="./LICENSE"'
assert_contains "README.md" 'img.shields.io/badge/License-MIT-blue.svg?style=flat-square'
assert_contains "README.md" 'href="https://nodejs.org/"'
assert_contains "README.md" 'img.shields.io/badge/Node-%3E%3D24-339933.svg?style=flat-square'
assert_not_contains "README.md" 'img.shields.io/npm'

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
assert_not_contains ".opencode/agents/debate.md" "bash: allow"

# Participant agents: mode, model+variant present (canonical source), hardened
# permissions, read-only body. Model IDs are intentionally not hard-coded here.
for agent in debate-openai debate-glm debate-kimi debate-anthropic debate-qwen; do
  assert_contains ".opencode/agents/$agent.md" "mode: subagent"
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
  assert_contains ".opencode/agents/$agent.md" "bash: deny"
  assert_contains ".opencode/agents/$agent.md" "edit: deny"
  assert_contains ".opencode/agents/$agent.md" "task: deny"
  assert_contains ".opencode/agents/$agent.md" "question: deny"
  assert_contains ".opencode/agents/$agent.md" "skill: deny"
  assert_not_contains ".opencode/agents/$agent.md" '"find *"'
  assert_not_contains ".opencode/agents/$agent.md" '"echo *"'
  assert_not_contains ".opencode/agents/$agent.md" '"cat *"'
  assert_not_contains ".opencode/agents/$agent.md" '"git '
  assert_contains ".opencode/agents/$agent.md" "do not access external directories, use a shell"
  assert_contains ".opencode/agents/$agent.md" 'Do not set `recommend_stopping: true` merely because the round limit has been reached.'
done

# Generated participant agents must stay in sync with the registry/template.
command -v node >/dev/null 2>&1 || fail "node is required to run the test suite"
node scripts/gen-participants.ts --check || fail "participant agents are stale; run 'node scripts/gen-participants.ts'"

# The plugin parses --set:default|cheap and emits resolved participants.
assert_contains "src/debate.ts" "--set:"
assert_contains "src/debate.ts" "Participant set"
assert_contains "src/debate.ts" "Resolved participants"
assert_contains "src/debate.ts" "cheap"

# Behavioural checks: Python and Node unit tests and TypeScript typechecking.
command -v python3 >/dev/null 2>&1 || fail "python3 is required to generate transcript HTML"
python3 -m unittest discover -s tests -p 'test_*.py' || fail "Python test suite failed"

test_output=$(node --test tests/*.test.ts 2>&1) || fail "test suite failed (run 'node --test tests/*.test.ts' for details)"
printf '%s\n' "$test_output" | grep -Fq "MODULE_TYPELESS_PACKAGE_JSON" && fail "test suite emitted MODULE_TYPELESS_PACKAGE_JSON warning"

if [ ! -x "node_modules/.bin/tsc" ]; then
  fail "typescript not installed; run 'npm install' before verifying"
fi
npm run typecheck || fail "typecheck failed"

printf '%s\n' "verify: ok"

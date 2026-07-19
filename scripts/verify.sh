#!/usr/bin/env sh
set -eu

# Static repository contract checks plus the behavioural suite (parser tests,
# TypeScript typecheck). Run with: sh scripts/verify.sh (after `npm install`).

fail() {
  printf '%s\n' "verify: $*" >&2
  exit 1
}

assert_tracked() {
  git ls-files --error-unmatch "$1" >/dev/null 2>&1 || [ -e "$1" ] || fail "required file missing: $1"
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

# Required files.
assert_tracked ".opencode/commands/debate.md"
assert_tracked ".opencode/plugin/debate.ts"
assert_tracked "tests/debate.test.ts"
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
assert_tracked "scripts/verify.sh"
assert_tracked "README.md"

# Local-only artefacts must not be tracked.
assert_not_tracked ".opencode/package.json"
assert_not_tracked ".opencode/package-lock.json"
assert_not_tracked ".opencode/node_modules"
assert_not_tracked "node_modules"

# .gitignore covers local node artefacts.
assert_contains ".gitignore" "node_modules/"
assert_contains ".gitignore" ".opencode/package.json"

# Command routes to the debate agent; plugin hooks the command lifecycle.
assert_contains ".opencode/commands/debate.md" "agent: debate"
assert_contains ".opencode/plugin/debate.ts" "../../src/debate.ts"
assert_contains "src/debate.ts" "command.execute.before"
assert_contains "src/debate.ts" "DebatePlugin"

# Coordinator agent structural contract.
assert_contains ".opencode/agents/debate.md" "mode: primary"
assert_contains ".opencode/agents/debate.md" "hidden: true"
assert_contains ".opencode/agents/debate.md" '"*": "ask"'
assert_contains ".opencode/agents/debate.md" "date -u +%Y-%m-%dT%H-%M-%SZ"
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
assert_contains ".opencode/agents/debate.md" ".html"
assert_contains ".opencode/agents/debate.md" "escape"
assert_contains ".opencode/agents/debate.md" "Participant set"
assert_contains ".opencode/agents/debate.md" "debate-qwen"
assert_not_contains ".opencode/agents/debate.md" "bash: allow"

# Participant agents: mode, model+variant present (canonical source), hardened
# permissions, read-only body. Model IDs are intentionally not hard-coded here.
for agent in debate-openai debate-glm debate-kimi debate-anthropic debate-qwen; do
  assert_contains ".opencode/agents/$agent.md" "mode: subagent"
  assert_contains ".opencode/agents/$agent.md" "model:"
  assert_contains ".opencode/agents/$agent.md" "variant:"
  assert_contains ".opencode/agents/$agent.md" "edit: deny"
  assert_contains ".opencode/agents/$agent.md" "task: deny"
  assert_contains ".opencode/agents/$agent.md" "question: deny"
  assert_contains ".opencode/agents/$agent.md" "read-only"
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

# Behavioural checks: parser unit tests and TypeScript typecheck.
test_output=$(node --test tests/*.test.ts 2>&1) || fail "test suite failed (run 'node --test tests/*.test.ts' for details)"
printf '%s\n' "$test_output" | grep -Fq "MODULE_TYPELESS_PACKAGE_JSON" && fail "test suite emitted MODULE_TYPELESS_PACKAGE_JSON warning"

if [ ! -x "node_modules/.bin/tsc" ]; then
  fail "typescript not installed; run 'npm install' before verifying"
fi
./node_modules/.bin/tsc --noEmit || fail "typecheck failed"

printf '%s\n' "verify: ok"

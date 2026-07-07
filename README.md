# OpenCode Debate Agent

This repo defines a project-level OpenCode `/debate` command. The command routes to a hidden Debate agent that coordinates three neutral participant subagents inside the current OpenCode session.

## Files

- `.opencode/commands/debate.md`: routes `/debate` to the project Debate agent.
- `.opencode/plugin/debate.ts`: OpenCode plugin entrypoint that re-exports the project implementation.
- `src/debate.ts`: parses and validates `/debate` command arguments and emits the resolved participant order before the agent runs.
- `tests/debate.test.ts`: behavioural unit tests for the argument parser, prompt generation, and part replacement.
- `.opencode/agents/debate.md`: authoritative behaviour definition for orchestration, participant subagents, transcript handling, early stopping, and final synthesis.
- `.opencode/agents/debate-openai.md`: neutral participant agent (default set); model ID and variant live in frontmatter.
- `.opencode/agents/debate-glm.md`: neutral participant agent (default and cheap sets); model ID and variant live in frontmatter.
- `.opencode/agents/debate-opus.md`: neutral participant agent (default set); model ID and variant live in frontmatter.
- `.opencode/agents/debate-deepseek.md`: neutral participant agent (cheap set); model ID and variant live in frontmatter.
- `.opencode/agents/debate-qwen.md`: neutral participant agent (cheap set); model ID and variant live in frontmatter.
- `src/participants.ts`: canonical participant registry and participant-set ordering.
- `scripts/debate-participant-body.md`: shared participant-agent prompt body.
- `scripts/gen-participants.ts`: renders `.opencode/agents/debate-*.md` from the registry and shared body.
- `docs/superpowers/specs/2026-07-05-debate-agent-design.md`: design rationale.
- `docs/superpowers/plans/2026-07-05-debate-agent.md`: original implementation plan.
- `scripts/verify.sh`: static repository contract checks plus the test suite and TypeScript typecheck.
- `package.json`, `package-lock.json`, `tsconfig.json`: dev-only toolchain (TypeScript and OpenCode SDK types) for local typechecking and CI.

## How It Works

1. Run `/debate <topic>` from this repo.
2. The slash command routes to the hidden `debate` agent.
3. `src/debate.ts`, loaded through `.opencode/plugin/debate.ts`, parses any leading `--rounds <number>` and `--set:default|cheap` flags and validates unsupported leading options.
4. The plugin replaces the command prompt with a canonical parsed request containing the topic, maximum round count, participant set, and resolved ordered participants.
5. The Debate agent coordinates subagents only; it does not re-parse slash-command flags.
6. In round 1, it starts three neutral participant subagents and gives each the same topic.
7. In later rounds, it calls each participant again with its `task_id` and gives each a fully self-contained prompt (the original topic, the participant's own previous turn, and the other participants' previous turns), so continuity does not depend on the runtime resuming prior context.
8. From round 2 onward, each participant reports whether consensus has been reached and whether it recommends stopping.
9. The Debate agent stops early only when all participants report consensus and all recommend stopping.
10. If the configured round limit is reached and at least one participant reports `recommend_stopping: false`, the Debate agent asks whether to run `1 more round`, `3 more rounds`, or `Stop and synthesise now`.
11. The Debate agent stores participant turns for continuity, writes a final synthesis in the current session, and persists Markdown and HTML transcripts under `docs/debates/`.

No separate OpenCode sessions are used for debate turns.

The Debate agent cannot edit files except debate transcripts under `docs/debates/`; all other edits (edit/write/apply_patch) are denied. Shell commands require approval (`bash: ask`), and the coordinator may only spawn the three debate participant subagents (`task` is denied for other subagent types). Its prompt forbids mutating the repository unless the user explicitly asks.

## Participant Agents

The `/debate` command supports two participant sets selected with `--set`:

- `default` set (used when `--set` is omitted):
  - `Participant 1`: `debate-glm` (GLM-5.2 from OpenCode Go).
  - `Participant 2`: `debate-opus` (Claude Opus 4.8 through OpenRouter).
  - `Participant 3`: `debate-openai` (OpenAI GPT-5.5).
- `cheap` set (`--set:cheap`):
  - `Participant 1`: `debate-glm` (GLM-5.2 from OpenCode Go).
  - `Participant 2`: `debate-qwen` (Qwen 3.7 Max from OpenCode Go).
  - `Participant 3`: `debate-deepseek` (Deepseek V4 Pro from OpenCode Go).

The canonical participant metadata and set ordering live in `src/participants.ts`. The concrete `.opencode/agents/debate-*.md` files are generated from that registry plus `scripts/debate-participant-body.md` so OpenCode can load self-contained agent definitions without requiring five manual prompt edits.

After changing participant metadata or the shared body, regenerate the checked-in agent files:

```sh
node scripts/gen-participants.ts
```

Participants may gather context with read-only tools for higher-quality answers, but do not edit files, run mutating commands, or spawn subagents. Participant `bash` is restricted to a read-only allowlist (file inspection commands such as `cat`, `grep`, `ls`, `git status`, `git diff`); all other shell commands are denied. Each round, participants return a JSON object (`turn`, plus `consensus_reached` and `recommend_stopping` from round 2). Participants treat `recommend_stopping: false` on the final configured round as a signal that the user may be offered additional rounds, not as an error or automatic stop.

## Usage

```text
/debate review this repository for maintainability improvements
/debate --rounds 5 compare two architecture options for this project
/debate --set:cheap compare two architecture options for this project
/debate --rounds 5 --set:cheap compare two architecture options for this project
```

Supported leading flags:

- `--rounds <number>`: maximum debate rounds. Defaults to `3` and must be an integer between 1 and 10. `--rounds=N` is also accepted. `--rounds` may only be specified once.
- `--set:default|cheap`: participant set. `default` uses `debate-glm`, `debate-opus`, and `debate-openai`; `cheap` uses `debate-glm`, `debate-qwen`, and `debate-deepseek`. Defaults to `default`. `--set` may only be specified once.
- `--` ends option parsing; all following text is treated as the topic (useful for topics that begin with `--`).
- Options are recognised only before the topic begins. After the first non-option token, all remaining text is part of the topic.

Invalid command arguments (unsupported options, out-of-range or malformed `--rounds`, duplicate `--rounds`) are normalised into an error prompt for the Debate agent. The agent explains the error and does not start participant subagents.

Restart OpenCode after changing project plugin files so the plugin is reloaded.

## Output

The Debate agent keeps participant turns out of the main session because they are available in the participant subagent sessions and persisted transcripts. The main session receives the final synthesis:

```markdown
## Final Synthesis
...
```

The agent writes both:

- `docs/debates/<UTC-ISO8601-timestamp>-<slug>.md`: Markdown archive for grep and diffs.
- `docs/debates/<UTC-ISO8601-timestamp>-<slug>.html`: self-contained HTML view using the table format from existing debate files, with rounds as rows, participants as columns, consensus/stop badges, parsing problems, extension notes, and the final summary.

## Verification

Run the repository checks before committing changes:

```sh
npm install
sh scripts/verify.sh
```

`scripts/verify.sh` runs three layers of checks:

1. Static contract checks: required files exist, local-only artefacts (`.opencode/package*.json`, `node_modules`) are not tracked, command routing and agent frontmatter are well-formed, and generated participant agents are up to date with the registry/template.
2. Behavioural unit tests: `node --test tests/*.test.ts` exercises the argument parser, prompt generation, part replacement, and participant generation.
3. TypeScript typecheck: `tsc --noEmit` typechecks `.opencode/plugin/debate.ts` against the installed `@opencode-ai/plugin` and `@opencode-ai/sdk` types.

Node.js >= 24 is required (native TypeScript support for running `.ts` tests directly).

## Limitations

- Participant roles are fixed as three neutral peers.
- Debate state lasts only for the current command execution, but a transcript is persisted under `docs/debates/` for review.
- `task_id` is treated as a hint that may resume a prior participant context; round 2+ prompts are fully self-contained so the debate is correct whether or not the runtime resumes prior context.
- Consensus and stop detection parse each round 2+ participant turn as JSON (`consensus_reached` and `recommend_stopping` boolean fields). The coordinator extracts the JSON object between the first `{` and last `}` and retries once on malformed output; if it still fails, the statuses are treated as `false`.
- If a participant task fails, times out, or returns empty output twice, the Debate agent stops and reports the partial result.

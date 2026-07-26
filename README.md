# OpenCode Debate

[![Verify](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml)

Run structured, multi-round debates in OpenCode with three neutral participant agents backed by different language models, followed by a final synthesis.

## Quick Start

Requirements:

- OpenCode
- Node.js 24 or later
- Access to the providers used by your selected participant set

```bash
git clone https://github.com/DrTralala/opencode-debate.git
cd opencode-debate
npm install
opencode
```

Then run:

```text
/debate compare two architecture options for this project
```

OpenCode loads the project command, coordinator, participant agents, and plugin when it starts in this repository. Restart OpenCode after changing or updating the plugin files.

## How It Works

1. `/debate` routes the request to a hidden coordinator agent.
2. The plugin parses leading options, validates the request, and resolves the ordered participant set.
3. Three neutral participant subagents answer the topic independently in round 1.
4. In later rounds, each participant resumes its session, receives the other participants' latest turns, and refines its position.
5. From round 2 onward, the debate stops early only when every participant reports consensus and recommends stopping. If the round limit is reached first, you can extend the debate or request synthesis.
6. The coordinator returns a final synthesis and writes Markdown and HTML transcripts under `docs/debates/`.

Participant turns stay in their subagent sessions and transcripts; the main session receives the final synthesis.

## Usage

```text
/debate review this repository for maintainability improvements
/debate --rounds 5 compare two architecture options
/debate --set:cheap compare two architecture options
/debate --rounds=5 --set:cheap compare two architecture options
```

Options are recognised only before the topic begins.

| Option | Description |
|---|---|
| `--rounds <number>` | Maximum rounds from 1 to 10. Defaults to 3. `--rounds=<number>` is also accepted. |
| `--set:<name>` | Participant set: `default` or `cheap`. Defaults to `default`. |
| `--` | End option parsing and treat all following text as the topic. |

Invalid options produce an error without starting participant subagents.

## Participant Sets

| Set | Participant 1 | Participant 2 | Participant 3 |
|---|---|---|---|
| `default` | `debate-kimi` (Kimi K3) | `debate-anthropic` (Claude Opus 5) | `debate-openai` (GPT-5.6 Sol Pro) |
| `cheap` | `debate-glm` (GLM-5.2) | `debate-qwen` (Qwen 3.7 Max) | `debate-kimi` (Kimi K3) |

Participant metadata and set ordering are defined in `src/participants.ts`.

## Transcripts

Each completed debate writes:

- `docs/debates/<timestamp>-<slug>.md`
- `docs/debates/<timestamp>-<slug>.html`

The transcript directory is local-only and ignored by Git.

## Verification

```bash
sh scripts/verify.sh
```

This runs repository contract checks, generated-agent drift detection, Node.js behavioural tests, warning checks, and TypeScript typechecking. The same script runs in GitHub Actions for every push and pull request.

## Project Structure

| Path | Purpose |
|---|---|
| `.opencode/commands/debate.md` | Routes `/debate` to the coordinator |
| `.opencode/agents/debate.md` | Defines orchestration, stopping, synthesis, and transcripts |
| `.opencode/agents/debate-*.md` | Generated participant definitions |
| `.opencode/plugin/debate.ts` | Loads the project plugin |
| `src/debate.ts` | Parses options and builds canonical debate requests |
| `src/participants.ts` | Defines participants and participant sets |
| `scripts/debate-participant-body.md` | Shared participant instructions |
| `scripts/gen-participants.ts` | Generates participant agent files |
| `scripts/verify.sh` | Runs local and CI validation |

# OpenCode Debate

<p align="center">
  <a href="https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml"><img alt="CI" src="https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml/badge.svg" /></a>
  <a href="https://github.com/DrTralala/opencode-debate/tree/v1.0.0"><img alt="Version: v1.0.0" src="https://img.shields.io/badge/version-v1.0.0-blue.svg?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js >=24.15.0" src="https://img.shields.io/badge/Node-%3E%3D24.15.0-339933.svg?style=flat-square" /></a>
</p>

Run structured, multi-round debates in OpenCode with three neutral participant agents backed by different language models, followed by a final synthesis.

## Requirements

- OpenCode 1.17.13 or later
- Node.js 24.15.0 or later
- Python 3.9 or later
- Access to the providers used by your selected participant set

## Install as an OpenCode Plugin

For project-only installation, add the npm package to `plugin` in the project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-debate@latest"
  ]
}
```

For installation across all projects, add the same `plugin` entry to your global OpenCode configuration at `~/.config/opencode/opencode.json`.

For a reproducible installation, pin the exact release:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-debate@1.0.0"
  ]
}
```

OpenCode installs and caches the npm package automatically. Do not run `npm install` in the consumer project. Restart OpenCode after changing the plugin specification, then run:

```text
/debate compare two architecture options for this project
```

The plugin entry point in `index.ts` registers `/debate`, the coordinator, and all participant agents at runtime. Consumer projects do not copy this repository's `.opencode/` files.

## Development Checkout

To run or modify the plugin from a checkout:

```bash
git clone https://github.com/DrTralala/opencode-debate.git
cd opencode-debate
npm ci
opencode
```

Restart OpenCode after changing plugin or agent files.

## How It Works

1. `/debate` routes the request to a hidden coordinator agent.
2. The plugin parses leading options, validates the request, and resolves the ordered participant set.
3. Three neutral participant subagents answer the topic independently in round 1.
4. In later rounds, each participant resumes its session, receives the other participants' latest turns, and refines its position.
5. From round 2 onward, the debate stops early only when every participant reports consensus and recommends stopping. If the round limit is reached first, you can extend the debate or request synthesis.
6. The coordinator returns a final synthesis, writes the canonical Markdown transcript, and invokes the Python generator for matching HTML.

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
| `default` | `debate-kimi` (Kimi K3) | `debate-anthropic` (Claude Opus 5) | `debate-openai` (GPT-5.6 Sol, `xhigh`) |
| `cheap` | `debate-glm` (GLM-5.2) | `debate-qwen` (Qwen 3.7 Max) | `debate-kimi` (Kimi K3) |

Participant metadata, provider model IDs, variants, and set ordering are defined in `src/participants.ts`. To override them, use a checkout or fork, edit that registry, run `node scripts/gen-participants.ts`, and restart OpenCode. Provider availability and supported variants can change independently of this repository.

## Privacy and Cost

- Debate topics, participant turns, and workspace context read by participants can be sent to several third-party model providers.
- Transcripts are stored locally under `docs/debates/` and can contain sensitive source code or repository context. Plugin consumers do not inherit this repository's ignore rules, so add `docs/debates/` to your own `.gitignore` before running debates.
- A debate invokes three models per round and may be extended beyond its configured limit. Multi-model, multi-round debates can incur substantial provider usage and cost.

## Transcripts

Each completed debate writes:

- `docs/debates/<timestamp>-<slug>.md`
- `docs/debates/<timestamp>-<slug>.html`

Markdown is canonical. `scripts/generate_html.py` validates it and atomically generates self-contained HTML. Participant turns, extension decisions, JSON parsing notes, and final synthesis render as sanitized Markdown; Consensus and Stop badges appear below each completed round. The transcript files still require normal local-data protection.

## Verification

```bash
sh scripts/verify.sh
```

This runs repository contract checks, generated-agent and prompt drift detection, Python HTML-generator tests, Node.js behavioural tests, warning checks, and TypeScript typechecking. The same script runs in GitHub Actions for every push and pull request.

## Project Structure

| Path | Purpose |
|---|---|
| `package.json` | npm package metadata, runtime dependencies, and release scripts |
| `index.ts` | npm plugin entry point and runtime agent registration |
| `.opencode/commands/debate.md` | Routes `/debate` to the project-local coordinator |
| `.opencode/agents/debate.md` | Defines project-local orchestration, stopping, synthesis, and transcripts |
| `.opencode/agents/debate-*.md` | Generated project-local participant definitions |
| `.opencode/plugin/debate.ts` | Loads the project-local plugin bridge |
| `src/debate.ts` | Parses options and builds canonical debate requests |
| `src/participants.ts` | Defines participants and participant sets |
| `scripts/debate-participant-body.md` | Shared participant instructions |
| `scripts/gen-participants.ts` | Generates participant agent files |
| `scripts/generate_html.py` | Parses Markdown transcripts and atomically generates HTML |
| `scripts/render_markdown.mjs` | Renders and sanitizes narrative Markdown for HTML transcripts |
| `scripts/check_package.mjs` | Verifies the exact npm package contents |
| `scripts/verify.sh` | Runs local and CI validation |
| `.github/workflows/verify.yml` | Verifies pushes and pull requests |
| `.github/workflows/publish.yml` | Publishes stable GitHub Releases to npm through OIDC |
| `tests/` | Python, TypeScript, JavaScript, package, and workflow regression tests |

## License

[MIT](LICENSE) © 2026 Trevor Leong

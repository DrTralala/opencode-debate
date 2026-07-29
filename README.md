# OpenCode Debate

<div align="center">

[![CI](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml)
[![Version: v1.1.0](https://img.shields.io/badge/version-v1.1.0-blue.svg?style=flat-square)](https://github.com/DrTralala/opencode-debate/tree/v1.1.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js >=24.15.0](https://img.shields.io/badge/Node-%3E%3D24.15.0-339933.svg?style=flat-square)](https://nodejs.org/)

</div>

Run structured, multi-round debates in OpenCode with three neutral participant agents backed by different language models, followed by a final synthesis.

## Requirements

- OpenCode 1.17.13 or later
- Node.js 24.15.0 or later
- Python 3.9 or later
- Access to the providers used by your selected participant set

## Installation

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
    "opencode-debate@1.1.0"
  ]
}
```

OpenCode installs and caches the npm package automatically. Do not run `npm install` in the consumer project. Restart OpenCode after changing the plugin specification, then run:

```text
/debate compare two architecture options for this project
```

The plugin entry point in `index.ts` registers `/debate`, the coordinator, and all participant agents at runtime. Consumer projects do not copy this repository's `.opencode/` files.

## Uninstallation

Remove the `opencode-debate` entry from the `plugin` array in your project or global OpenCode configuration. Optionally, delete the user configuration file at `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-debate/config.yaml`, then restart OpenCode.

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
/debate <topic>
/debate --rounds 5 <topic> # 5 rounds instead of 3
/debate --set:cheap <topic>
/debate --rounds=5 --set:cheap <topic>
```

Options are recognised only before the topic begins.

| Option | Description |
|---|---|
| `--rounds <number>` | Maximum rounds from 1 to 10. Defaults to 3. `--rounds=<number>` is also accepted. |
| `--set:<name>` | Configured participant set. The package includes `default` and `cheap`; defaults to `default`. |
| `--` | End option parsing and treat all following text as the topic. |

Invalid options produce an error without starting participant subagents.

## Participant Sets

| Set | Participant 1 | Participant 2 | Participant 3 |
|---|---|---|---|
| `default` | `debate-kimi` (Kimi K3) | `debate-anthropic` (Claude Opus 5) | `debate-openai` (GPT-5.6 Sol, `xhigh`) |
| `cheap` | `debate-glm` (GLM-5.2) | `debate-qwen` (Qwen 3.7 Max) | `debate-kimi` (Kimi K3) |

## Configuration

The packaged source of truth is [`config.yaml`](config.yaml). Maintainers can edit it, run `node scripts/gen-participants.ts`, and restart OpenCode to update the project-local agents.

Published npm installations also read one optional user overlay:

```text
${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-debate/config.yaml
```

When `XDG_CONFIG_HOME` is set, the path is `$XDG_CONFIG_HOME/opencode/opencode-debate/config.yaml`; otherwise it is `~/.config/opencode/opencode-debate/config.yaml`. There is no project-level participant override.

Every file starts with `version: 1`. To modify one field on an existing participant:

```yaml
version: 1
participants:
  debate-openai:
    variant: high
```

To add a participant and a set that uses it:

```yaml
version: 1
participants:
  debate-local:
    description: Neutral debate participant using a local model
    model: local/my-model
sets:
  local:
    - debate-local
    - debate-kimi
    - debate-openai
```

Then invoke it with `/debate --set:local <topic>`.

Participant fields merge by participant ID, so omitted fields retain packaged values. A new participant must provide a non-empty `model`; `description` and `variant` are optional. Without a description, the plugin uses `Neutral debate participant using <model>`. Without a variant, the plugin omits that field from the OpenCode agent configuration. Supplying a set replaces that complete set array; unmentioned participants and sets remain unchanged. Configuration cannot delete packaged entries.

Duplicate YAML keys, unknown fields, unsupported versions, incomplete participants, sets other than exactly three distinct IDs, and unknown participant references are errors. A missing user file silently uses packaged defaults. Any invalid user file is logged with its absolute path and field path, then plugin initialisation stops instead of silently using a potentially different provider or cost profile. Configuration is loaded once, so restart OpenCode after every change.

Provider availability and supported variants can change independently of this repository.

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
| `config.yaml` | Packaged participant metadata and participant-set ordering |
| `index.ts` | npm plugin entry point and runtime agent registration |
| `.opencode/commands/debate.md` | Routes `/debate` to the project-local coordinator |
| `.opencode/agents/debate.md` | Defines project-local orchestration, stopping, synthesis, and transcripts |
| `.opencode/agents/debate-*.md` | Generated project-local participant definitions |
| `.opencode/plugin/debate.ts` | Loads the project-local plugin bridge |
| `src/debate.ts` | Parses options and builds canonical debate requests |
| `src/participants.ts` | Loads, validates, merges, and normalises participant YAML |
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

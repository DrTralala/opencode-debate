# OpenCode Debate

<div align="center">

[![CI](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml)
[![Version: v3.1.0](https://img.shields.io/badge/version-v3.1.0-blue.svg?style=flat-square)](https://github.com/DrTralala/opencode-debate/tree/v3.1.0)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js >=24.15.0](https://img.shields.io/badge/Node-%3E%3D24.15.0-339933.svg?style=flat-square)](https://nodejs.org/)

</div>

Run structured, multi-round debates in OpenCode with three neutral participant agents backed by different language models, followed by a final synthesis.

## Requirements

- OpenCode 1.17.13 or later
- Node.js 24.15.0 or later
- Python 3.9 or later
- Linux with `/proc/self/fd` support for transcript persistence; other platforms fail closed
- Access to the providers used by your selected participant set

## Quick start

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

OpenCode installs and caches the npm package automatically. Do not run `npm install` in the consumer project. Restart OpenCode after changing the plugin specification.

Before use, review [Privacy and Cost](#privacy-and-cost) and add `docs/debates/` to your project's `.gitignore`. Topics and workspace context may be sent to third-party providers; each round invokes three models.

Run a debate:

```text
/debate compare two architecture options for this project
```

The plugin registers commands and agents automatically; consumer projects do not copy this repository's `.opencode/` files.

On success, the coordinator returns a final synthesis and prints the Markdown and HTML transcript paths under `docs/debates/`. If HTML generation fails, the Markdown transcript is retained and the failure is reported.

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

1. `/debate` validates the options and starts a hidden coordinator with the selected three-participant panel.
2. Participants answer independently in round 1, then review each other's responses in their existing sessions.
3. From round 2, unanimous consensus and stop recommendations end the debate early. Otherwise, the selected set's continuation mode governs extensions at the round limit.
4. The coordinator returns a synthesis and saves Markdown and HTML transcripts. Participant turns remain in child sessions and transcripts.

Responses are schema-validated before forwarding or storage; invalid responses are corrected and validation failures are recorded. Dispatch guards reject duplicate, wrong-agent, and wrong-round tasks. Formatting and persistence tools are restricted to the coordinator.

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
| `--set:<name>` | Configured participant set. The package includes `default` and `cheap`; omission uses the default selected by `config.yaml`. |
| `--` | End option parsing and treat all following text as the topic. |

Invalid options produce an error without starting participant subagents.

## Automatic Debates

Disabled by default. When enabled, a visible main agent can consult a three-participant panel for decisions with material uncertainty. It evaluates the findings before acting or requesting another cycle; consensus is not proof of correctness.

Add this optional block to your complete [user configuration](#configuration), then restart OpenCode:

```yaml
auto_debate:
  enabled: false
  set: default
  max_rounds: 3
  persist_transcripts: true
```

| Setting | Behaviour |
|---|---|
| `enabled` | Default for new conversations; session controls below override it. |
| `set` | Existing set name, such as `default` or `cheap`. Omission uses the configured default. Invalid names are rejected. New in v3.1.0; manual `/debate` selection and saved panels are unchanged. |
| `max_rounds` | Integer ≥3, per cycle. Unanimous stop votes can end a new discussion after round 2, or a follow-up after round 1. No overall cycle, time, or spending cap. |
| `persist_transcripts` | Save Markdown to `docs/debates/auto-<discussion-id>.md` (no HTML). Disabling it does not disable session or provider retention. |

Conversation controls take effect immediately without rewriting YAML:

| Command | Effect |
|---|---|
| `/debate-auto on` | Allow new discussions; does not start one itself. |
| `/debate-auto status` | Check current state and discussions. |
| `/debate-auto off` | Block new discussions; existing work and evaluated continuations can proceed. |
| `/debate-auto stop <discussion-id\|all>` | Cancel one or all discussions in this conversation; pending stops remain unconfirmed. |
| `/debate-auto reset` | Return to the configured enablement default. |

Participants cannot edit files or launch nested debates. Normal OpenCode permissions still apply; the tool's permission action patterns are `start`, `status`, `evaluate`, `resume`, and `cancel`.

State is checkpointed in a native child session. After restart, in-flight work is marked interrupted, not replayed. Resuming requires verified original sessions, a recorded evaluation, and focused feedback. If a background notification is missing, check status rather than assuming completion.

### Viewing participant sessions

Use **Ctrl+X, then Down** to enter a child, **Left / Right** or **Prev / Next** to cycle siblings, and **Up** or **Parent** to return. These are the [OpenCode 1.19.0 defaults](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/tui/src/config/keybind.ts); custom bindings may differ. Cycling includes other subagents and the checkpoint session. The `auto_debate` tool entry itself does not open a participant session.

## Mini Debates

Run a bounded debate with one neutral participant in the current session. The main agent stays active and debates directly; the plugin does not switch to the hidden three-participant coordinator.

```text
/mini-debate <topic>
/mini-debate --participant:debate-openai --rounds 5 <topic>
```

A topic is mandatory. `--participant:<name>` selects an existing participant and `--rounds <number>` sets a budget from 1 to 10; both override the configuration below.

Add this optional block to your complete [user configuration](#configuration), then restart OpenCode:

```yaml
mini_debate:
  participant: debate-kimi
  max_rounds: 3
```

| Setting | Behaviour |
|---|---|
| `participant` | Existing participant name. Omission uses the first member of the configured default set. It is independent of `auto_debate.set`. |
| `max_rounds` | Integer from 1 to 10, default 3. Command flags override it. |

Each completed participant response counts as one round. From round 2, the exchange stops early only when both the main agent and the participant report `consensus_reached` and `recommend_stopping` as `true`. At the reached round limit, at least one continuing recommendation opens a native question with finite extension choices; another round runs only after the user approves that question, and the participant resumes in the same child session. A one-round budget ends at its limit without claiming early consensus.

Each invocation uses one native `task` child session. The task entry stays clickable, and the child is reachable with **Ctrl+X, then Down**; mini-debate writes no separate transcript files. Native task permissions still apply: an explicit denial for a participant name is mirrored to its mini alias, while an explicit alias rule is preserved. Ordinary agents and users keep their usual ask/deny behaviour.

## Participant Sets

| Set | Participant 1 | Participant 2 | Participant 3 |
|---|---|---|---|
| `default` | `debate-kimi` (Kimi K3, `max`) | `debate-anthropic` (Claude Opus 5, `high`) | `debate-openai` (GPT-5.6 Sol, `xhigh`) |
| `cheap` | `debate-glm` (GLM-5.2, `max`) | `debate-qwen` (Qwen 3.7 Max, `max`) | `debate-kimi` (Kimi K3, `max`) |

## Configuration

Edit the user configuration at:

```text
${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-debate/config.yaml
```

If missing, the plugin atomically creates it as an exact copy of the packaged [`config.yaml`](config.yaml). Existing files are never merged or rewritten, including on upgrades; add new settings yourself. The user file is a complete, authoritative version 2 configuration, not a partial overlay. Version 1 files require migration.

Minimal example:

```yaml
version: 2
participants:
  alpha:
    model: provider/alpha
  beta:
    model: provider/beta
  gamma:
    model: provider/gamma
sets:
  primary:
    default: yes
    participants: [alpha, beta, gamma]
```

- **Participants:** require a non-empty `model`; `description` and `variant` are optional non-empty strings. Provider availability and variants may change independently.
- **Sets:** exactly three distinct declared participants. Mark at most one with `default: yes`; otherwise the first set in YAML source order is used. No literal `default` name is required.
- **Manual continuation:** `continuation: ask` (default) asks about extending when participants recommend it; `discretion` lets the coordinator ask, add one round, or synthesise. Questions offer 1 or 3 more rounds, stopping, or a custom count. Extensions have no hard cap.
- **Validation:** duplicate keys, unknown fields or references, and malformed entries stop initialisation with a file/field error; there is no silent fallback.
- **Reload:** quit and restart OpenCode after edits. Maintainers changing participant definitions also run `node scripts/gen-participants.ts`.

Only the hidden coordinator has Task access to manual debate participants. Hidden agents are not a security boundary: users can still invoke an exact participant name manually with `@name`.

## Privacy and Cost

- Debate topics, participant turns, and workspace context read by participants can be sent to several third-party model providers.
- Transcripts are stored locally under `docs/debates/` and can contain sensitive source code or repository context. Plugin consumers do not inherit this repository's ignore rules, so add `docs/debates/` to your own `.gitignore` before running debates.
- A debate invokes three models per round and may be extended beyond its configured limit. Multi-model, multi-round debates can incur substantial provider usage and cost.

## Transcripts

Each completed manual debate writes:

- `docs/debates/YYYY-MM-DD-<slug>.md`
- `docs/debates/YYYY-MM-DD-<slug>.html`

Markdown is canonical; HTML is generated from that same file with sanitised content. Publication is atomic, avoids overwriting existing transcripts, and fails closed on unsafe paths. If HTML generation fails, Markdown is retained. Regenerate HTML rather than editing it directly.

Automatic debates save Markdown only, under `docs/debates/auto-<discussion-id>.md`. Records contain submitted briefs, responses, evaluations, and outcomes—not private internal reasoning.

## Verification

```bash
sh scripts/verify.sh
```

This runs repository contract checks, generated-agent and prompt drift detection, Python response-formatter and HTML-generator tests, Node.js behavioural tests, warning checks, and TypeScript typechecking. The same script runs in GitHub Actions for every push and pull request.

## Project Structure

| Path | Purpose |
|---|---|
| `config.yaml` | Packaged participant and set definitions |
| `index.ts` | Plugin entry point and agent registration |
| `src/` | Configuration, manual debate, dispatch guards, and persistence |
| `src/auto-debate/` | Automatic discussion lifecycle and native-session integration |
| `.opencode/` | Project-local commands, coordinator, and generated participant agents |
| `scripts/` | Agent generation, response validation, transcript publishing, and verification |
| `tests/` | Behavioural and packaging regression tests |
| `.github/workflows/` | CI verification and release-triggered npm publishing through OIDC |

## License

[MIT](LICENSE) © 2026 Trevor Leong

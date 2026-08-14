# OpenCode Debate

<div align="center">

[![CI](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml)
[![Version: v2.2.2](https://img.shields.io/badge/version-v2.2.2-blue.svg?style=flat-square)](https://github.com/DrTralala/opencode-debate/tree/v2.2.2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js >=24.15.0](https://img.shields.io/badge/Node-%3E%3D24.15.0-339933.svg?style=flat-square)](https://nodejs.org/)

</div>

Run structured, multi-round debates in OpenCode with three neutral participant agents backed by different language models, followed by a final synthesis.

## Requirements

- OpenCode 1.17.13 or later
- Node.js 24.15.0 or later
- Python 3.9 or later
- Linux is required for transcript persistence; the safe descriptor publisher uses Linux directory descriptors and `/proc/self/fd` semantics. Other platforms fail closed.
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
    "opencode-debate@2.2.2"
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
5. From round 2 onward, the debate stops early only when every participant reports consensus and recommends stopping. At the round limit, the selected set's continuation mode either uses the existing user Question flow (`ask`) or lets the coordinator ask, add one round, or synthesise (`discretion`). Every continuation Question includes one concise process-based rationale and the coordinator's neutral advisory recommendation. If the recommendation is a fixed choice, exactly that matching fixed option is marked `(Recommended)` and no other fixed option is; if it is a custom positive count, no fixed option is marked and the exact count is stated without inventing a fourth option. The user still chooses among the fixed options or enters a custom numeric value, and Questions contain no substantive coordinator arguments, new research, or topic conclusions.
6. The coordinator returns a final synthesis and calls the coordinator-only persistence tool, which validates and atomically writes the canonical date-only Markdown transcript before generating matching HTML from that exact path.
7. The dispatch guard registers each valid rewritten debate command, binds all three resolved participant types before accepting tasks, rejects unmarked, duplicate, wrong-agent, and wrong-round dispatches, and resets stale state only when no dispatch is in flight. A fresh command cannot reset an in-flight debate.

Before storing or forwarding any participant response, the coordinator calls the coordinator-only `format_debate_response` custom tool with the `round1` schema for round 1 and `round2` thereafter. The formatter requires the exact schema, preserves participant field values, and returns canonical JSON. Raw responses are never stored or forwarded. Syntax errors may receive syntax-preserving repairs and are retried until formatting succeeds; semantic or schema errors are sent to the resumed participant with the exact diagnostic and retried until valid. Failed formatting attempts are recorded under `## JSON Parsing Problems` in the transcript. The response-formatting and transcript-persistence tools are denied globally and to participant agents, and allowed only for the hidden coordinator.

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
| `--set:<name>` | Configured participant set. The package includes `default` and `cheap`; omission uses the default selected by `config.yaml`. |
| `--` | End option parsing and treat all following text as the topic. |

Invalid options produce an error without starting participant subagents.

## Participant Sets

| Set | Participant 1 | Participant 2 | Participant 3 |
|---|---|---|---|
| `default` | `debate-kimi` (Kimi K3, `max`) | `debate-anthropic` (Claude Opus 5, `high`) | `debate-openai` (GPT-5.6 Sol, `xhigh`) |
| `cheap` | `debate-glm` (GLM-5.2, `max`) | `debate-qwen` (Qwen 3.7 Max, `max`) | `debate-kimi` (Kimi K3, `max`) |

## Configuration

[`config.yaml`](config.yaml) is the source of every participant and set shipped by the package. On each plugin initialisation, opencode-debate resolves this user path:

```text
${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-debate/config.yaml
```

When `XDG_CONFIG_HOME` is set, the path is `$XDG_CONFIG_HOME/opencode/opencode-debate/config.yaml`; otherwise it is `~/.config/opencode/opencode-debate/config.yaml`. If the file does not exist, the plugin atomically creates it as an exact copy of the packaged file. If it already exists, the plugin never rewrites or merges it.

The user file is a complete, authoritative version 2 configuration. Removing a participant or set keeps it removed, including after package upgrades. Existing version 1 files and former partial overlays are rejected; convert them to a complete version 2 file, or delete them to regenerate the packaged template on the next initialisation.

A complete minimal file has this shape:

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

A participant requires a non-empty `model`. `description` and `variant` are optional non-empty strings. Without a description, the plugin uses `Neutral debate participant using <model>`; without a variant, the OpenCode agent configuration omits that field. Participants may be unused by every set and are still registered.

Every set is a mapping whose `participants` array contains exactly three distinct declared participant IDs. The optional `default: yes` marker may appear on at most one set, and only the parsed string `yes` is valid. When no marker is present, the first set in YAML source order is selected. No set name is reserved, so a set named `default` is not required. The command's default rounds are 3; `--rounds` remains the override.

Each set may specify `continuation: ask` or `continuation: discretion`; omission defaults to `ask`. In `ask` mode, when the configured limit is reached without the early-stop condition and at least one participant recommends continuing, the coordinator asks the user whether to run `1 more round`, `3 more rounds`, or `Stop and synthesise now`. Each continuation Question includes one concise process-based rationale and the coordinator's neutral advisory recommendation. For a fixed recommendation, `(Recommended)` appears on exactly the matching fixed option and no other; for a custom positive recommendation, no fixed option is marked, the exact count is stated, and no fourth option is invented. A custom numeric answer grants that many additional rounds; a non-numeric answer proceeds to synthesis. In `discretion` mode, the coordinator chooses among asking the user, one autonomous extra round, or synthesis using participant guidance and debate quality; discretion-mode Questions, including the no-unanimous-consensus case where all participants recommend stopping, use the same rationale, recommendation, option-marking, and custom-count policy. The user still chooses among fixed options or enters a custom numeric value, and Questions contain no substantive coordinator arguments, new research, or topic conclusions. The decision is revisited after each extension and there is no hard extension cap. Three false `consensus_reached` values are guidance only; they do not automatically stop or extend a debate.

Duplicate YAML keys, unknown fields, unsupported versions, incomplete participants, malformed sets, and unknown participant references stop plugin initialisation. Errors identify the absolute file and field path; creation and read errors also report the filesystem operation and cause. There is no implicit in-memory fallback.

Normal agents are denied Task access to the configured debate participants; only the hidden debate coordinator receives exact Task allows for them. Hiding removes participant autocomplete visibility, but OpenCode still lets a user invoke an exact participant name manually with `@name`. This is not a security boundary.

Configuration is loaded once. After editing or deleting the user file, quit and restart OpenCode. Maintainers changing the packaged file should also run `node scripts/gen-participants.ts` to update the project-local generated agents before restarting.

Provider availability and supported variants can change independently of this repository.

## Privacy and Cost

- Debate topics, participant turns, and workspace context read by participants can be sent to several third-party model providers.
- Transcripts are stored locally under `docs/debates/` and can contain sensitive source code or repository context. Plugin consumers do not inherit this repository's ignore rules, so add `docs/debates/` to your own `.gitignore` before running debates.
- A debate invokes three models per round and may be extended beyond its configured limit. Multi-model, multi-round debates can incur substantial provider usage and cost.

## Transcripts

Each completed debate writes:

- `docs/debates/YYYY-MM-DD-<slug>.md`
- `docs/debates/YYYY-MM-DD-<slug>.html`

Markdown is canonical. The coordinator-only `persist_debate_transcript` tool computes the UTC date, validates the canonical Markdown before creating files, atomically claims the base name (then `-2`, `-3`, and later suffixes for collisions), and invokes `scripts/generate_html.py` with the exact claimed Markdown path plus a descriptor identity token. Publication and exact-path HTML generation use Linux no-follow directory descriptors and fail closed if the canonical directory identity changes. Participant turns, extension decisions, JSON parsing notes, and final synthesis render as sanitized Markdown; Consensus and Stop badges appear below each completed round. If HTML generation fails, the Markdown transcript is retained and the concise failure is reported. The transcript files still require normal local-data protection.

The Markdown topic metadata uses matching tokenised markers so multiline topics are preserved verbatim, including blank lines and Markdown-like content:

```markdown
**Topic:** <!-- BEGIN TOPIC <token> -->
<topic copied verbatim, including line breaks>
<!-- END TOPIC <token> -->
```

The request's token is retained for the matching markers. Do not edit the generated HTML directly; regenerate it from the canonical Markdown. The persistence tool accepts only lowercase kebab-case slugs and retains `--latest` only as a backwards-compatible generator CLI option.

## Verification

```bash
sh scripts/verify.sh
```

This runs repository contract checks, generated-agent and prompt drift detection, Python response-formatter and HTML-generator tests, Node.js behavioural tests, warning checks, and TypeScript typechecking. The same script runs in GitHub Actions for every push and pull request.

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
| `src/response-formatter.ts` | Registers the coordinator-only response-formatting tool and runs the packaged validator |
| `src/task-dispatch-guard.ts` | Guards coordinator participant dispatches by resolved type, purpose, round, and session lifecycle |
| `src/transcript-persistence.ts` | Registers coordinator-only, date-only, collision-safe transcript persistence |
| `src/participants.ts` | Creates, loads, validates, and normalises authoritative participant YAML |
| `scripts/debate-participant-body.md` | Shared participant instructions |
| `scripts/gen-participants.ts` | Generates participant agent files |
| `scripts/format_response.py` | Strictly validates and canonicalises participant JSON responses |
| `scripts/generate_html.py` | Parses Markdown transcripts and atomically generates HTML |
| `scripts/publish_transcript.py` | Publishes Markdown through Linux trusted directory descriptors without symlink races |
| `scripts/render_markdown.mjs` | Renders and sanitizes narrative Markdown for HTML transcripts |
| `scripts/check_package.mjs` | Verifies the exact npm package contents |
| `scripts/verify.sh` | Runs local and CI validation |
| `.github/workflows/verify.yml` | Verifies pushes and pull requests |
| `.github/workflows/publish.yml` | Publishes stable GitHub Releases to npm through OIDC |
| `tests/` | Python, TypeScript, JavaScript, package, and workflow regression tests |

## License

[MIT](LICENSE) © 2026 Trevor Leong

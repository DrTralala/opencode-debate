# OpenCode Debate

<div align="center">

[![CI](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml/badge.svg)](https://github.com/DrTralala/opencode-debate/actions/workflows/verify.yml)
[![Version](https://img.shields.io/github/v/release/DrTralala/opencode-debate?label=version&color=blue&sort=date&style=flat-square)](https://github.com/DrTralala/opencode-debate/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js >=24.15.0](https://img.shields.io/badge/Node-%3E%3D24.15.0-339933.svg?style=flat-square)](https://nodejs.org/)

</div>

Ever find your agents stuck trying to implement a feature or fix a bug? Meet OpenCode Debate, where your agents can debate a chosen topic to achieve the best possible outcome.

## Requirements

- OpenCode 1.17.13 or later
- Node.js 24.15.0 or later
- Python 3.9 or later
- Linux (other platforms have not been tested)
- Access to models from different families (e.g. GPT, Claude and Gemini) is highly recommended

## Installation

Put this in your `opencode.json`:
```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-debate@latest"
  ]
}
```

For Git-based projects, you may want to add `docs/debates/` to `.gitignore` as debate transcripts are stored there.

## Uninstallation

Remove the `opencode-debate` entry from your `opencode.json`. Optionally, delete the following directories:

1. `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode-debate`
2. `${XDG_CACHE_HOME:-$HOME/.cache}/opencode/packages/opencode-debate@latest`

## Quick Start

Run a debate:

```text
/debate <topic>
```

On success, the coordinator returns a final synthesis and prints the paths to the Markdown and HTML transcripts under `docs/debates/`. If HTML generation fails, the Markdown transcript is retained and the failure is reported.

## How It Works

1. `/debate` validates the options and starts a hidden coordinator with three debate participants specified in `${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode-debate/config.yaml`.
2. Round 1: Participants respond to the topic independently.
3. Round 2: Participants receive one another's responses. They can now specify `consensus_reached` and `recommend_stopping` to end the debate early. If the conditions are not met, the debate continues to the next round.
4. Round 3: Participants once again receive one another's responses. By default, this is the final round. They will also specify `consensus_reached` and `recommend_stopping`.
5. Assuming the debate stops here, the coordinator synthesises the participants' responses and saves the results as both Markdown and HTML transcripts. It also provides a summary upon completion.

The conditions under which debates stop can be adjusted in `config.yaml`. See the [Configuration](#configuration) section.

## Usage

```text
/debate <topic>
/debate --rounds 5 <topic>
/debate --set:alt <topic>
/mini-debate <topic>
```

Invalid options produce an error without starting participant subagents.

## Mini Debates

Run a debate with only one debate participant in the current session. The main agent stays active and debates directly with the participant. For example:

```text
/mini-debate Are there alternative ways to fix this bug?
```

Choose a participant and round limit with space-separated options:

```text
/mini-debate --participant debate-glm --rounds 5 Are there alternative ways to fix this bug?
```

The `--participant:<name>` form remains supported as an alias for `--participant <name>`. The round limit is from 1 to 10; `mini_debate` in `config.yaml` supplies the defaults.

## Automatic Debates

> [!CAUTION]
> This can become expensive if you do not know what you are doing. Use at your own risk.

When enabled, the agent can automatically spawn a debate. This is done at the agent's discretion, usually when there is material uncertainty. It can request additional cycles of debate if it considers the answers inadequate.

This behaviour can be overridden on a per-session basis:

`/debate-auto on` -- Allow new automatic debates without starting one.

`/debate-auto off` -- Block new discussions; existing work and evaluated continuations can proceed.

`/debate-auto status` -- Check the current state and discussions.

`/debate-auto stop <discussion-id|all>` -- Cancel one or all discussions in this conversation, including pending ones.

`/debate-auto reset` -- Return to the configured default.

Participants cannot edit files or launch nested debates. Normal OpenCode permissions still apply. By default, participants have access to the following tools:
- `start`
- `status`
- `evaluate`
- `resume`
- `cancel`

### Automatic-debate storage

#### Storage location and legacy data

New private automatic-debate checkpoints on Linux are stored under OpenCode's state directory in `<state>/opencode-debate/`. Existing native checkpoint sessions continue using OpenCode's native checkpoint storage, which is also used on other platforms. The previous `<state>/opencode-debate/auto-debate/v2/` tree is not read, resumed, migrated or modified by this version.

There are no storage-specific `/debate-auto` commands to inspect, migrate or delete these files. Manage any old v2 data outside the plugin.

#### Auditing, compaction and deletion

Audit information can only be retrieved by specifying a `discussion_id`. This information remains available after a restart, even when transcripts are disabled.

Storage compaction occurs only when:

- All discussions have reached a terminal state.
- All runtime and delivery evidence has been settled.

Confirmed parent deletion removes the private store only when it is safe to do so and all outstanding activity has been drained. Unresolved containment or receipt evidence is retained and reported rather than deleted.

Revision chains are checked while the store is in use, but after a restart the plugin cannot distinguish an older, internally valid copy from the latest saved copy.

#### Security and durability limitations

Private storage is access-restricted but **not encrypted**. Processes running under the same user account and administrators can still read the stored files.

Ordinary deletion and compaction do not guarantee secure erasure of:

- Physical disk blocks.
- Filesystem snapshots.
- Existing backups.

Process-kill testing does not establish resilience against sudden power loss. Storage durability guarantees are limited to synchronised operations on local Linux filesystems.

### Viewing participant sessions

As debate participants are essentially subagents, you can review their sessions using **Ctrl+X** in the OpenCode TUI. Cycle between the different debate participants to see their reasoning.

## Configuration

Edit the user configuration at:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode-debate/config.yaml
```

If the file is missing, the plugin atomically creates it as an exact copy of the packaged [`config.example.yaml`](config.example.yaml). Existing files are never merged or rewritten, even during upgrades; add new settings yourself. The user file is a complete, authoritative version 2 configuration, not a partial overlay. Version 1 files require migration.

The packaged template's former `cheap` set is now named `alt`, and `auto_debate.set` selects `alt`. Existing user files keep their current set and model values; change them manually if you want the new defaults. Restart OpenCode after editing the file.

The packaged participant models are:

| Participant | Model | Variant |
| --- | --- | --- |
| `debate-openai` | `openai/gpt-6.2-astra` | `high` |
| `debate-glm` | `commandcode/zai-org/GLM-5.3` | `max` |
| `debate-kimi` | `commandcode/moonshotai/Kimi-K3.1-Pro` | `max` |
| `debate-anthropic` | `openrouter/anthropic/claude-opus-5.5` | `high` |
| `debate-qwen` | `commandcode/Qwen/Qwen3.8-Max-Prime` | not set |

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
    continuation: ask
    participants: [alpha, beta, gamma]
auto_debate:
  enabled: true
  set: primary
  max_rounds: 0
  persist_transcripts: true
mini_debate:
  enabled: true
  participant: alpha
  max_rounds: 5
```

- `continuation` can be either `ask` or `discretion`, with the latter allowing the model to decide.
- Values of `1` or `2` are invalid for `max_rounds`. A value of `0` means unlimited rounds.

## Privacy Concerns

Transcripts are stored locally under `docs/debates/`. They can contain sensitive source code or repository context. Please exercise caution when sharing these files or pushing them to remote Git repositories hosted on platforms such as GitHub. It is highly recommended that you add `docs/debates/` to your own `.gitignore`.

## Transcripts

Each completed manual debate writes:

- `docs/debates/YYYY-MM-DD-<slug>.md`
- `docs/debates/YYYY-MM-DD-<slug>.html`

Markdown is canonical; HTML is generated from that same file with sanitised content. Publication is atomic and does not overwrite existing transcripts. It fails closed when it encounters unsafe paths. If HTML generation fails, the Markdown transcript is retained. Regenerate the HTML rather than editing it directly.

When transcript persistence is enabled, automatic debates save only Markdown transcripts as `docs/debates/auto-YYYY-MM-DD-<question-slug>.md`. If that date-and-slug name belongs to another transcript, the plugin uses a numeric suffix such as `-2` rather than overwriting it; unsafe destination paths fail closed. When a discussion resumes, the plugin appends its verified frames to the existing transcript rather than replacing it.

## License

[MIT](LICENSE) © 2026 Trevor Leong

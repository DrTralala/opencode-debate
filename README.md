# OpenCode Debate Agent

A project-level OpenCode `/debate` command that coordinates three neutral participant subagents (each backed by a different LLM) to debate a topic across multiple rounds, then synthesises the results.

## How It Works

1. `/debate <topic>` routes to a hidden Debate agent via the slash command.
2. `src/debate.ts` (loaded through `.opencode/plugin/debate.ts`) parses `--rounds` and `--set` flags, then replaces the command prompt with a canonical request containing the topic, round count, participant set, and resolved participant order.
3. The Debate agent spawns three participant subagents in round 1, each receiving the same topic.
4. In subsequent rounds, each participant receives the other participants' most recent turns and refines its position. Round 2+ prompts are fully self-contained — continuity does not depend on resumed context.
5. From round 2 onward, each participant reports `consensus_reached` and `recommend_stopping`. The debate stops early only when all participants report both as `true`.
6. If the round limit is reached without consensus, the user is offered additional rounds or a final synthesis.
7. The Debate agent writes a final synthesis and persists Markdown and HTML transcripts under `docs/debates/`.

Participant turns stay in subagent sessions and transcripts — the main session receives only the final synthesis.

## Installation

```sh
npm install
```

Restart OpenCode after installing so the plugin is loaded.

## Usage

```text
/debate review this repository for maintainability improvements
/debate --rounds 5 compare two architecture options for this project
/debate --set:cheap compare two architecture options for this project
/debate --rounds 5 --set:cheap compare two architecture options for this project
```

Flags (recognised only before the topic begins):

- `--rounds <number>` — maximum rounds (1–10, default 3). `--rounds=N` also accepted. May only appear once.
- `--set:default|cheap` — participant set (default `default`). May only appear once.
- `--` — ends option parsing; all following text is the topic.

Invalid arguments produce an error prompt for the Debate agent; no subagents are started.

## Participant Agents

Two sets are available via `--set`:

| Set | Participant 1 | Participant 2 | Participant 3 |
|---|---|---|---|
| `default` | `debate-kimi` (Kimi K3) | `debate-anthropic` (Claude Fable 5) | `debate-openai` (GPT-5.6 Sol Pro) |
| `cheap` | `debate-glm` (GLM-5.2) | `debate-qwen` (Qwen 3.7 Max) | `debate-kimi` (Kimi K3) |

### Modifying or Adding Subagents

All participant metadata lives in `src/participants.ts`. The `.opencode/agents/debate-*.md` files are generated from this registry plus the shared prompt body in `scripts/debate-participant-body.md`.

**To add a new participant:**

1. Add an entry to the `DEBATE_PARTICIPANTS` array in `src/participants.ts`:
   ```ts
   {
     agent: "debate-mistral",
     description: "Neutral debate participant using Mistral Large",
     model: "openrouter/mistralai/mistral-large",
     variant: "max",
   },
   ```
2. Add the agent name to the relevant set(s) in `DEBATE_PARTICIPANT_SETS`:
   ```ts
   export const DEBATE_PARTICIPANT_SETS = {
      default: ["debate-kimi", "debate-anthropic", "debate-openai"],
      cheap: ["debate-glm", "debate-qwen", "debate-kimi"],
     premium: ["debate-anthropic", "debate-openai", "debate-mistral"],
   } as const
   ```
3. Whitelist the new agent in `.opencode/agents/debate.md` under the `task` permission:
   ```yaml
   task:
     "*": "deny"
     "debate-openai": "allow"
     "debate-anthropic": "allow"
      "debate-glm": "allow"
      "debate-kimi": "allow"
      "debate-qwen": "allow"
     "debate-mistral": "allow"
   ```
4. Regenerate the agent files:
   ```sh
   node scripts/gen-participants.ts
   ```
5. Restart OpenCode to load the new agent.

**To modify an existing participant** (e.g. change the model or description):

1. Edit the relevant entry in `DEBATE_PARTICIPANTS` in `src/participants.ts`.
2. Run `node scripts/gen-participants.ts` to regenerate agent files.
3. Restart OpenCode.

**To change the shared participant prompt**, edit `scripts/debate-participant-body.md` and regenerate.

**To change a participant's set membership** (e.g. swap one model for another in the `cheap` set), edit `DEBATE_PARTICIPANT_SETS` in `src/participants.ts`. No regeneration is needed for set changes alone.

### Participant Behaviour

Participants may use read-only tools (read, grep, glob, webfetch, etc.) for context but cannot edit files, run mutating commands, or spawn subagents. Each round, participants return a JSON object with a `turn` field (and `consensus_reached`/`recommend_stopping` booleans from round 2 onward).

## Verification

```sh
sh scripts/verify.sh
```

Runs static contract checks, behavioural unit tests (`node --test tests/*.test.ts`), and TypeScript typechecking (`tsc --noEmit`). Requires Node.js >= 24.

## Files

| File | Purpose |
|---|---|
| `.opencode/commands/debate.md` | Routes `/debate` to the Debate agent |
| `.opencode/plugin/debate.ts` | Plugin entrypoint |
| `.opencode/agents/debate.md` | Coordinator agent definition |
| `.opencode/agents/debate-*.md` | Generated participant agent definitions |
| `src/debate.ts` | Argument parser and prompt generation |
| `src/participants.ts` | Canonical participant registry and set ordering |
| `scripts/debate-participant-body.md` | Shared participant prompt body |
| `scripts/gen-participants.ts` | Renders agent files from registry + body |
| `scripts/verify.sh` | Contract checks, tests, and typecheck |
| `tests/debate.test.ts` | Behavioural unit tests |

# OpenCode Debate Agent

This repo defines a project-level OpenCode `/debate` command. The command routes to a Debate agent that coordinates three neutral participant subagents inside the current OpenCode session.

## Files

- `.opencode/commands/debate.md`: routes `/debate` to the project Debate agent.
- `.opencode/agents/debate.md`: authoritative behaviour definition for orchestration, participant subagents, transcript handling, early stopping, and final synthesis.
- `.opencode/agents/debate-deepseek.md`: neutral participant agent; model ID lives in frontmatter.
- `.opencode/agents/debate-glm.md`: neutral participant agent; model ID lives in frontmatter.
- `.opencode/agents/debate-opus.md`: neutral participant agent; model ID lives in frontmatter.
- `docs/superpowers/specs/2026-07-05-debate-agent-design.md`: design rationale.
- `docs/superpowers/plans/2026-07-05-debate-agent.md`: original implementation plan.
- `scripts/verify.sh`: static verification for the tracked repository contract.

## How It Works

1. Run `/debate <topic>` from this repo.
2. The slash command routes to the `debate` agent.
3. The Debate agent parses any leading `--rounds <number>` flag, then treats the rest as topic text.
4. In round 1, it starts three neutral participant subagents and gives each the same topic.
5. In later rounds, it resumes each participant by `task_id` and gives each the other participants' previous turns.
6. From round 2 onward, each participant reports whether consensus has been reached and whether it recommends stopping.
7. The Debate agent stops early only when all participants report consensus and all recommend stopping.
8. The Debate agent stores participant turns for continuity and writes a final synthesis in the current session.

No separate OpenCode sessions are used for debate turns.

## Participant Agents

- `Participant 1`: `debate-deepseek`.
- `Participant 2`: `debate-opus`.
- `Participant 3`: `debate-glm`.

The concrete model IDs are intentionally kept in the participant agent frontmatter so model changes have one canonical source.

## Usage

```text
/debate review this repository for maintainability improvements
/debate --rounds 5 compare two architecture options for this project
```

Supported leading flags:

- `--rounds <number>`: maximum debate rounds. Defaults to `3`.
- Options are recognised only before the topic begins. After the first non-option token, all remaining text is part of the topic.

## Output

The Debate agent keeps participant turns out of the main session because they are available in the participant subagent sessions. The main session receives the final synthesis:

```markdown
## Final Synthesis
...
```

## Verification

Run the static repository checks before committing changes:

```sh
sh scripts/verify.sh
```

The verification script treats `.opencode/package*.json`, `.opencode/node_modules/`, and `.opencode/.gitignore` as local-only artefacts that must not be tracked.

## Limitations

- Participant roles are fixed as three neutral peers.
- Debate state lasts only for the current command execution.
- Consensus and stop detection parses only the final two non-empty status lines from each round 2+ participant turn; malformed or missing lines are treated as `no`.
- If a participant task fails, times out, or returns empty output twice, the Debate agent stops and reports the partial result.

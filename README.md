# OpenCode Debate Agent

This repo defines a project-level OpenCode `/debate` command. The command routes to a Debate agent that coordinates two neutral participant subagents inside the current OpenCode session.

## Files

- `.opencode/commands/debate.md`: routes `/debate` to the project Debate agent.
- `.opencode/agents/debate.md`: orchestrates the debate, participant subagents, transcript, early stopping, and final synthesis.
- `.opencode/agents/debate-deepseek.md`: neutral participant backed by Deepseek V4 Pro.
- `.opencode/agents/debate-opus.md`: neutral participant backed by Claude Opus 4.8 through OpenRouter.

## How It Works

1. Run `/debate <topic>` from this repo.
2. The slash command routes to the `debate` agent.
3. The Debate agent parses the topic and optional `--rounds <number>` flag.
4. In round 1, it starts two neutral participant subagents and gives both the same topic.
5. In later rounds, it resumes each participant by `task_id` and gives each the other participant's previous turn.
6. From round 2 onward, each participant reports whether consensus has been reached and whether it recommends stopping.
7. The Debate agent stops early only when both participants report consensus and both recommend stopping.
8. The Debate agent stores participant turns for continuity and writes a final synthesis in the current session.

No separate OpenCode sessions are used for debate turns.

## Participant Models

- `Participant 1`: `debate-deepseek`, using `opencode-go/deepseek-v4-pro`.
- `Participant 2`: `debate-opus`, using `openrouter/anthropic/claude-opus-4.8`.

## Usage

```text
/debate review this repository for maintainability improvements
/debate --rounds 5 compare two architecture options for this project
```

Supported flags:

- `--rounds <number>`: maximum debate rounds. Defaults to `3`.

## Output

The Debate agent keeps participant turns out of the main session because they are available in the participant subagent sessions. The main session receives the final synthesis:

```markdown
## Final Synthesis
...
```

## Limitations

- Participant roles and models are fixed as two neutral peers backed by Deepseek V4 Pro and OpenRouter Claude Opus 4.8.
- Debate state lasts only for the current command execution.
- Consensus and stop detection relies on the participants following the requested status-line format.

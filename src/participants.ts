export const DEBATE_PARTICIPANT_SETS = {
  default: ["debate-glm", "debate-opus", "debate-openai"],
  cheap: ["debate-glm", "debate-qwen", "debate-deepseek"],
} as const

export type DebateSet = keyof typeof DEBATE_PARTICIPANT_SETS
export type DebateParticipantAgent = (typeof DEBATE_PARTICIPANT_SETS)[DebateSet][number]

export type DebateParticipant = {
  agent: DebateParticipantAgent
  description: string
  model: string
  variant: string
}

export const DEBATE_PARTICIPANTS: readonly DebateParticipant[] = [
  {
    agent: "debate-openai",
    description: "Neutral debate participant using OpenAI GPT-5.6 Sol Pro",
    model: "openai/gpt-5.6-sol",
    variant: "xhigh",
  },
  {
    agent: "debate-glm",
    description: "Neutral debate participant using GLM-5.2 from OpenCode Go",
    model: "opencode-go/glm-5.2",
    variant: "max",
  },
  {
    agent: "debate-opus",
    description: "Neutral debate participant using Claude Opus 4.8 through OpenRouter",
    model: "openrouter/anthropic/claude-opus-4.8",
    variant: "high",
  },
  {
    agent: "debate-deepseek",
    description: "Neutral debate participant using Deepseek V4 Pro from OpenCode Go",
    model: "opencode-go/deepseek-v4-pro",
    variant: "max",
  },
  {
    agent: "debate-qwen",
    description: "Neutral debate participant using Qwen 3.7 Max from OpenCode Go",
    model: "opencode-go/qwen3.7-max",
    variant: "max",
  },
]

export const DEBATE_PARTICIPANT_SETS = {
  default: ["debate-kimi", "debate-anthropic", "debate-openai"],
  cheap: ["debate-glm", "debate-qwen", "debate-kimi"],
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
    agent: "debate-kimi",
    description: "Neutral debate participant using Kimi K3 from OpenCode Go",
    model: "opencode-go/kimi-k3",
    variant: "max",
  },
  {
    agent: "debate-anthropic",
    description: "Neutral debate participant using Claude Fable 5 through OpenRouter",
    model: "openrouter/anthropic/claude-fable-5",
    variant: "high",
  },
  {
    agent: "debate-qwen",
    description: "Neutral debate participant using Qwen 3.7 Max from OpenCode Go",
    model: "opencode-go/qwen3.7-max",
    variant: "max",
  },
]

import type { Plugin } from "@opencode-ai/plugin"
import { composePluginHooks } from "../../index.ts"
import { createDebatePlugin } from "../../src/debate.ts"
import { createTaskDispatchGuard } from "../../src/task-dispatch-guard.ts"
import {
  createMiniDebateController,
  type MiniDebateController,
  type MiniDebateHost,
} from "../../src/mini-debate/plugin.ts"
import { DEBATE_REGISTRY } from "../../src/participants.ts"
import { ResponseFormatterPlugin } from "../../src/response-formatter.ts"

// One composed project-local plugin. The manual guard and the mini controller
// are created together so their command hand-offs share a single instance of
// each and the manual guard is never registered twice.
export const DebatePlugin: Plugin = async (input, options) => {
  let miniDebateController: MiniDebateController | undefined
  const taskDispatchGuard = createTaskDispatchGuard({
    beforeStart: (sessionID) => miniDebateController?.release(sessionID),
  })
  const debateHooks = await createDebatePlugin(DEBATE_REGISTRY)(input, options)
  const responseFormatterHooks = await ResponseFormatterPlugin(input, options)
  miniDebateController = createMiniDebateController(
    DEBATE_REGISTRY,
    {
      client: input.client as unknown as MiniDebateHost["client"],
      directory: input.directory,
    },
    { beforeStart: (sessionID) => taskDispatchGuard.release(sessionID) },
  )
  return composePluginHooks([
    debateHooks,
    taskDispatchGuard.hooks,
    responseFormatterHooks,
    miniDebateController.hooks,
  ])
}

export default DebatePlugin

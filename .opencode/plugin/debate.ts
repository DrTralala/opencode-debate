import type { Hooks, Plugin } from "@opencode-ai/plugin"
import { composePluginHooks, createIntegrationConfigHook } from "../../index.ts"
import { createDebatePlugin } from "../../src/debate.ts"
import { createTaskDispatchGuard } from "../../src/task-dispatch-guard.ts"
import {
  createMiniDebateController,
  type MiniDebateController,
  type MiniDebateHost,
} from "../../src/mini-debate/plugin.ts"
import { loadEffectiveRegistry } from "../../src/participants.ts"
import { ResponseFormatterPlugin } from "../../src/response-formatter.ts"

// One composed project-local plugin. It loads the same effective user registry
// as the installed package and shares the installed config-registration logic,
// so permission mirroring, agent/command registration and command hand-offs
// behave like the published plugin with a single manual guard instance.
export const DebatePlugin: Plugin = async (input, options) => {
  const registry = loadEffectiveRegistry()
  let miniDebateController: MiniDebateController | undefined
  const taskDispatchGuard = createTaskDispatchGuard({
    beforeStart: (sessionID) => miniDebateController?.release(sessionID),
  })
  const integrationHooks: Hooks = { config: createIntegrationConfigHook(registry) }
  const debateHooks = await createDebatePlugin(registry)(input, options)
  const responseFormatterHooks = await ResponseFormatterPlugin(input, options)
  miniDebateController = createMiniDebateController(
    registry,
    {
      client: input.client as unknown as MiniDebateHost["client"],
      directory: input.directory,
    },
    { beforeStart: (sessionID) => taskDispatchGuard.release(sessionID) },
  )
  return composePluginHooks([
    debateHooks,
    integrationHooks,
    taskDispatchGuard.hooks,
    responseFormatterHooks,
    miniDebateController.hooks,
  ])
}

export default DebatePlugin

/**
 * CLS observability plugin for DeepSeek Harness.
 *
 * Observes DSH's native session, agent loop, LLM stream, and tool lifecycle,
 * converts them into CLS-formatted GenAI spans, and uploads directly to
 * Tencent Cloud CLS via tencentcloud-cls-sdk-js.
 *
 * @module tencentcloud-agentobs-sdk-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  Config as ConfigSchema,
  type Config as PluginConfig,
  type ResolvedClsConfig,
  resolveClsConfig,
} from './config.js'
import { DshClsCoordinator } from './coordinator.js'
import type { DshPluginContext } from './dsh-types.js'

export const name = 'cls-observability'
export const inject = ['sessions', 'llm'] as const
export const Config = ConfigSchema
export type Config = PluginConfig

/** Install native DSH lifecycle observation and CLS upload pipeline. */
export function apply(ctx: Context, config: Config): void {
  const dsh = ctx as unknown as DshPluginContext
  const result = resolveClsConfig(config)

  if (!config.enabled) {
    dsh.logger.info('[cls-dsh] collection is disabled')
    return
  }

  if ('missing' in result) {
    dsh.logger.warn(
      `[cls-dsh] CLS configuration incomplete — missing: ${result.missing.join(', ')}.\n`
      + '  Option 1: Set environment variables:\n'
      + '    export CLS_ENDPOINT=ap-guangzhou.cls.tencentcs.com\n'
      + '    export CLS_TOPIC_ID=<your-topic-id>\n'
      + '    # strong auth:\n'
      + '    export CLS_SECRET_ID=<your-secret-id>\n'
      + '    export CLS_SECRET_KEY=<your-secret-key>\n'
      + '    # or authless (weak auth) upload:\n'
      + '    export CLS_UIN=<your-uin>\n'
      + '  Option 2: Edit plugin config at ~/.dsh/profiles/<profile>/cordis.patch.yml:\n'
      + '    - id: cls-observability\n'
      + '      config:\n'
      + '        endpoint: ap-guangzhou.cls.tencentcs.com\n'
      + '        topicId: <your-topic-id>\n'
      + '        secretId: <your-secret-id>\n'
      + '        secretKey: <your-secret-key>\n'
      + '        # or authless (weak auth) upload:\n'
      + '        # uin: <your-uin>',
    )
    return
  }

  const resolvedConfig: ResolvedClsConfig = result
  const coordinator = new DshClsCoordinator(resolvedConfig, dsh.logger)
  coordinator.start()

  // Adopt existing sessions (do not replay events to avoid duplication after HMR)
  for (const session of dsh.sessions.list()) coordinator.adoptSession(session)

  const disposers = [
    dsh.on('session/created', (session) => {
      try {
        coordinator.adoptSession(session)
      } catch (error: unknown) {
        dsh.logger.warn(
          `[cls-dsh] failed to adopt session ${String(session.id)}: ${String(error)}`,
        )
      }
    }),
    dsh.on('session/event', (session, event) => coordinator.onSessionEvent(session, event)),
    dsh.on('session/disposed', (session) => {
      try {
        coordinator.disposeSession(session)
      } catch (error: unknown) {
        dsh.logger.warn(
          `[cls-dsh] failed to dispose session ${String(session.id)}: ${String(error)}`,
        )
      }
    }),
    dsh.on('llm/stream', (options, next) => coordinator.interceptLlm(options, next)),
  ]

  dsh.effect(() => async () => {
    for (const dispose of disposers.reverse()) dispose()
    try {
      coordinator.closeAll()
    } catch (error: unknown) {
      dsh.logger.warn(`[cls-dsh] failed to close live spans: ${String(error)}`)
    }
    await coordinator.shutdown()
  }, 'cls-dsh: detach listeners and shutdown CLS flusher')

  dsh.logger.info(
    `[cls-dsh] loaded; endpoint=${resolvedConfig.endpoint}; topic=${resolvedConfig.topicId.slice(0, 8)}...; `
    + `content=${resolvedConfig.captureContent ? 'enabled' : 'disabled'}`,
  )
}

import type { LanguageModelFactory } from '@product-res/ai'
import { AppError } from '@product-res/shared'
import { MockLanguageModelV4 } from 'ai/test'

export type { LanguageModelFactory, TextModelEnv } from '../../../packages/ai/src/text/model.ts'
export const AI_PROVIDER_NOT_CONFIGURED = 'AI_PROVIDER_NOT_CONFIGURED'
export const PREFIX = `Saved before disconnect. ${'a'.repeat(200)}`
export const SHORT_TAIL = ' Completed after the page closed.'
export const LONG_TAIL = ' Saved at the next checkpoint.'
export const FINAL_USAGE = { input: 100, output: 700 }

// 仅由独立 e2e Vite 配置加载；未知模型直接拒绝，离线测试不会调用服务商。
export const defaultLanguageModelFactory: LanguageModelFactory = (model) => {
  if (!['disconnect-short', 'disconnect-long'].includes(model.providerModelId))
    throw new AppError(AI_PROVIDER_NOT_CONFIGURED, 'Only disconnect fixtures are available')
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: PREFIX })
          // 留出关闭页面的时间；长流的第二块还验证默认 5 秒检查点。
          await new Promise((resolve) => setTimeout(resolve, 6_000))
          const long = model.providerModelId === 'disconnect-long'
          controller.enqueue({ type: 'text-delta', id: 't1', delta: long ? LONG_TAIL : SHORT_TAIL })
          if (long) return // 保持挂起，不触发 onEnd/onError；测试在断开超过 30 秒后执行回收。
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: {
                total: FINAL_USAGE.input,
                noCache: FINAL_USAGE.input,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: FINAL_USAGE.output,
                text: FINAL_USAGE.output,
                reasoning: undefined,
              },
            },
          })
          controller.close()
        },
      }),
    }),
  })
}

import type { LanguageModelFactory } from '@product-res/ai'
import { AppError } from '@product-res/shared'
import { MockLanguageModelV4 } from 'ai/test'

export type { LanguageModelFactory, TextModelEnv } from '../../../../packages/ai/src/text/model.ts'
export const AI_PROVIDER_NOT_CONFIGURED = 'AI_PROVIDER_NOT_CONFIGURED'
export const LOCAL_CHAT_PREFIX = `Acceptance reply started. ${'a'.repeat(200)}`
export const LOCAL_CHAT_TAIL = ' Acceptance reply completed.'

function reasoningOnlyStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'reasoning-start', id: 'acceptance-reasoning' })
      controller.enqueue({
        type: 'reasoning-delta',
        id: 'acceptance-reasoning',
        delta: 'r'.repeat(1024),
      })
      controller.enqueue({ type: 'reasoning-end', id: 'acceptance-reasoning' })
      controller.enqueue({
        type: 'finish',
        finishReason: { unified: 'length', raw: 'length' },
        usage: {
          inputTokens: { total: 53, noCache: 53, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1024, text: 0, reasoning: 1024 },
        },
      })
      controller.close()
    },
  })
}

// 仅通过独立本地 Vite 配置替换模型工厂；未知模型拒绝，绝不回退到真实服务商。
export const defaultLanguageModelFactory: LanguageModelFactory = (model) => {
  if (model.provider !== 'deepseek' || model.providerModelId !== 'deepseek-flash')
    throw new AppError(
      AI_PROVIDER_NOT_CONFIGURED,
      'Only local acceptance text models are available',
    )
  return new MockLanguageModelV4({
    provider: 'deepseek.chat',
    doStream: async ({ prompt, abortSignal, providerOptions }) => {
      // 模拟 deepseek-flash 默认思考：未关闭时故障模型只回 reasoning 并用尽输出上限，
      // 复现 staging fault-2026-10-14a；只作用于专用故障模型，普通本地验收输出不变。
      const thinking = (providerOptions?.deepseek as { thinking?: { type?: string } } | undefined)
        ?.thinking?.type
      if (model.key.startsWith('acceptance-fault-') && thinking !== 'disabled')
        return { stream: reasoningOnlyStream() }
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: (() => void) | undefined
      const cleanup = () => {
        finished = true
        clearTimeout(timer)
        if (abort) abortSignal?.removeEventListener('abort', abort)
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            abort = () => {
              if (finished) return
              cleanup()
              controller.error(new DOMException('Aborted', 'AbortError'))
            }
            if (abortSignal?.aborted) return abort()
            abortSignal?.addEventListener('abort', abort, { once: true })
            controller.enqueue({ type: 'text-start', id: 'acceptance-text' })
            controller.enqueue({
              type: 'text-delta',
              id: 'acceptance-text',
              delta: LOCAL_CHAT_PREFIX,
            })
            // 大块前缀触发真实检查点；延迟尾部让停止与关页确实发生在生成期间。
            const stop = JSON.stringify(prompt).includes('acceptance-scenario: stop')
            timer = setTimeout(
              () => {
                if (finished) return
                cleanup()
                controller.enqueue({
                  type: 'text-delta',
                  id: 'acceptance-text',
                  delta: LOCAL_CHAT_TAIL,
                })
                controller.enqueue({ type: 'text-end', id: 'acceptance-text' })
                controller.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: undefined },
                  usage: {
                    inputTokens: {
                      total: 100,
                      noCache: 100,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 100, text: 100, reasoning: undefined },
                  },
                })
                controller.close()
              },
              stop ? 10_000 : 6_000,
            )
          },
          // 故障包装器只取消上游 reader，不标记用户 stop；清除延迟尾部避免错误后继续 enqueue。
          cancel() {
            cleanup()
          },
        }),
      }
    },
  })
}

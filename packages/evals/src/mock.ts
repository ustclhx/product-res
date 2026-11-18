import type { LanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

type FinishReason = 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'

const FINISH_REASONS = new Set<string>([
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
])

export interface FixedReply {
  readonly text: string
  readonly finishReason?: string | undefined
  readonly usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined }
}

/**
 * 以固定文本应答的模型：回放把录制包装成它，与真实模式走同一条 `generateText` 路径
 * （design D5），评委的结构化解析因此在回放中同样被覆盖。单测也用它注入模拟模型。
 */
export function fixedModel(
  reply: FixedReply | ((call: number) => FixedReply | Promise<FixedReply>),
  modelId = 'replay',
): MockLanguageModelV4 & LanguageModel {
  let calls = 0
  return new MockLanguageModelV4({
    provider: 'evals',
    modelId,
    doGenerate: async () => {
      const current = typeof reply === 'function' ? await reply(calls++) : reply
      const unified = (
        FINISH_REASONS.has(current.finishReason ?? 'stop')
          ? (current.finishReason ?? 'stop')
          : 'other'
      ) as FinishReason
      return {
        content: [{ type: 'text', text: current.text }],
        finishReason: { unified, raw: current.finishReason },
        usage: {
          inputTokens: {
            total: current.usage?.inputTokens,
            noCache: current.usage?.inputTokens,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: current.usage?.outputTokens,
            text: current.usage?.outputTokens,
            reasoning: undefined,
          },
        },
        warnings: [],
      }
    },
  })
}

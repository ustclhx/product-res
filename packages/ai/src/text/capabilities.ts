import type { ModelMessage, wrapLanguageModel } from 'ai'

type CallOptions = Parameters<ReturnType<typeof wrapLanguageModel>['doStream']>[0]
export type TextThinkingParams = Pick<CallOptions, 'reasoning' | 'providerOptions'>

export interface TextProviderCapabilities {
  readonly supportsThinking: boolean
  applyThinking<T extends TextThinkingParams>(params: T, on: boolean): T & TextThinkingParams
  continuation?: {
    buildPrefix(messages: ModelMessage[], partial: string): ModelMessage[]
  }
}

const defaults: TextProviderCapabilities = {
  supportsThinking: false,
  applyThinking: (params) => params,
}

const deepseek: TextProviderCapabilities = {
  supportsThinking: true,
  applyThinking: (params, on) => ({
    ...params,
    reasoning: on ? 'high' : 'none',
    providerOptions: {
      ...params.providerOptions,
      deepseek: {
        ...params.providerOptions?.deepseek,
        thinking: { type: on ? 'enabled' : 'disabled' },
      },
    },
  }),
  continuation: {
    buildPrefix: (messages, partial) => [
      ...messages,
      {
        role: 'assistant',
        content: partial,
        providerOptions: { deepseek: { prefix: true } },
      },
    ],
  },
}

const capabilities = new Map<string, TextProviderCapabilities>([['deepseek', deepseek]])

/** 同时接受注册表 provider 与 SDK 的 deepseek.chat 标识。 */
export function getTextProviderCapabilities(provider: string): TextProviderCapabilities {
  return capabilities.get(provider.split('.')[0] ?? provider) ?? defaults
}

/** 是否向使用者开放 thinking 开关：缺省跟随适配器；显式 true 仍需 Provider 可控，false 不开放。 */
export function supportsTextThinking(provider: string, thinkingOverride?: boolean): boolean {
  return thinkingOverride !== false && getTextProviderCapabilities(provider).supportsThinking
}

/**
 * 计算本次调用实际下发的 thinking：
 * - Provider 不可控时返回 undefined，不改变请求；
 * - 模型显式 `thinking=false` 时返回 false，由 applyThinking 下发关闭形式。
 *   部分模型（如 DeepSeek V4）默认推理，不下发关闭会让 reasoning 占用 maxOutputTokens 而截断正文；
 * - 其他情况使用调用方请求的值。
 */
export function resolveTextThinking(
  provider: string,
  thinkingOverride: boolean | undefined,
  requested: boolean,
): boolean | undefined {
  if (!getTextProviderCapabilities(provider).supportsThinking) return undefined
  if (thinkingOverride === false) return false
  return requested
}

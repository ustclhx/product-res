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

/** 模型缺省跟随适配器；显式 true 仍需 Provider 可控，false 始终禁用。 */
export function supportsTextThinking(provider: string, thinkingOverride?: boolean): boolean {
  return thinkingOverride !== false && getTextProviderCapabilities(provider).supportsThinking
}

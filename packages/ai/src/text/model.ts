import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { AppError } from '@product-res/shared'
import type { LanguageModel } from 'ai'
import type { AvailableModel } from '../models.ts'

/**
 * 文本模型的构造（docs/06-ai.md §3「实现」）：按 `ai_model.provider` 返回经 AI Gateway 的
 * AI SDK 模型实例；OpenAI 兼容直连由部署管理员配置。测试注入模拟模型。
 */

/** 构造模型所需的环境变量（AI Gateway 端点与鉴权，design 决策 8） */
export interface TextModelEnv {
  /** CF 缺省 gateway；Node composition 显式装配 direct。 */
  readonly AI_TEXT_EGRESS?: 'direct' | 'gateway' | undefined
  /** 完整 OpenAI 兼容 API base，只来自管理员部署配置。 */
  readonly OPENAI_BASE_URL?: string | undefined
  /** Cloudflare 账号 id 与 Gateway 名称，组成 Gateway 的服务商兼容端点 */
  readonly AI_GATEWAY_ACCOUNT_ID?: string | undefined
  readonly AI_GATEWAY_ID?: string | undefined
  /** Gateway 开启鉴权时携带 */
  readonly AI_GATEWAY_TOKEN?: string | undefined
  /** 默认使用 Gateway BYOK；显式提供时仍经 Gateway 转发服务商密钥 */
  readonly OPENAI_API_KEY?: string | undefined
  readonly ANTHROPIC_API_KEY?: string | undefined
  readonly GOOGLE_API_KEY?: string | undefined
  readonly DEEPSEEK_API_KEY?: string | undefined
}

export type LanguageModelFactory = (model: AvailableModel, env: TextModelEnv) => LanguageModel

export const AI_PROVIDER_NOT_CONFIGURED = 'AI_PROVIDER_NOT_CONFIGURED'

const DEEPSEEK_DIRECT_BASE_URL = 'https://api.deepseek.com'

type OpenAiChatModel = ReturnType<ReturnType<typeof createOpenAI>['chat']>
type OpenAiUsage = Awaited<ReturnType<OpenAiChatModel['doGenerate']>>['usage']

function preserveUnknownUsage(usage: OpenAiUsage): OpenAiUsage {
  const raw = usage.raw as
    | { prompt_tokens?: number | null; completion_tokens?: number | null }
    | undefined
  if (!raw) return usage
  // SDK 将部分缺失的计数转为 0；未知用量必须仍由共用结算器估算并受预扣封顶。
  return {
    ...usage,
    inputTokens:
      raw.prompt_tokens == null
        ? { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }
        : usage.inputTokens,
    outputTokens:
      raw.completion_tokens == null
        ? { total: undefined, text: undefined, reasoning: undefined }
        : usage.outputTokens,
  }
}

function openAiChat(options: Parameters<typeof createOpenAI>[0], modelId: string): OpenAiChatModel {
  const model = createOpenAI(options).chat(modelId)
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const result = await model.doGenerate(options)
      return { ...result, usage: preserveUnknownUsage(result.usage) }
    },
    async doStream(options) {
      const result = await model.doStream(options)
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(
                chunk.type === 'finish'
                  ? { ...chunk, usage: preserveUnknownUsage(chunk.usage) }
                  : chunk,
              )
            },
          }),
        ),
      }
    },
  }
}

type DeepSeekModel = ReturnType<ReturnType<typeof createDeepSeek>>

/** SDK 原生支持 prefix，但仅 beta base URL；按本次消息选择端点，避免改变普通调用。 */
function deepseekChat(
  options: Parameters<typeof createDeepSeek>[0] & { baseURL: string },
  modelId: string,
): DeepSeekModel {
  const model = createDeepSeek(options)(modelId)
  const beta = createDeepSeek({ ...options, baseURL: `${options.baseURL}/beta` })(modelId)
  const select = (params: Parameters<DeepSeekModel['doStream']>[0]) => {
    const last = params.prompt.at(-1)
    return last?.role === 'assistant' && last.providerOptions?.deepseek?.prefix === true
      ? beta
      : model
  }
  return {
    specificationVersion: model.specificationVersion,
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (params) => select(params).doGenerate(params),
    doStream: (params) => select(params).doStream(params),
  }
}

function gatewayOptions(
  baseURL: string,
  env: TextModelEnv,
  key: string | undefined,
  authHeader: string,
) {
  const apiKey = key?.trim() || undefined
  const token = env.AI_GATEWAY_TOKEN?.trim()
  return {
    baseURL,
    // SDK 要求 API key；占位值阻止其回退读取 process.env，发送前移除对应鉴权头。
    apiKey: apiKey ?? 'cloudflare-gateway-byok',
    headers: token ? { 'cf-aig-authorization': `Bearer ${token}` } : {},
    fetch: ((input, init) => {
      if (apiKey) return globalThis.fetch(input, init)
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      )
      headers.delete(authHeader)
      return globalThis.fetch(input, { ...init, headers })
    }) satisfies typeof fetch,
  }
}

/** 保留原生 Provider Gateway 协议；OpenAI 可显式选择兼容直连。 */
export const defaultLanguageModelFactory: LanguageModelFactory = (model, env) => {
  if (env.AI_TEXT_EGRESS !== undefined && !['direct', 'gateway'].includes(env.AI_TEXT_EGRESS))
    throw new AppError(AI_PROVIDER_NOT_CONFIGURED, 'Invalid text egress configuration', {
      status: 503,
    })
  if (model.provider === 'openai' && env.AI_TEXT_EGRESS === 'direct') {
    const apiKey = env.OPENAI_API_KEY?.trim()
    let url: URL | undefined
    try {
      url = new URL(env.OPENAI_BASE_URL ?? '')
    } catch {
      // 只报告配置项，不将可能包含凭据的 URL 放入错误或日志。
    }
    if (
      !apiKey ||
      !url ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new AppError(AI_PROVIDER_NOT_CONFIGURED, 'OpenAI direct endpoint is not configured', {
        status: 503,
      })
    return openAiChat({ baseURL: url.href.replace(/\/$/, ''), apiKey }, model.providerModelId)
  }
  // Gateway 会把 DeepSeek 的 SSE 整段缓冲后才返回（#152），direct 且有管理员密钥时直连官方端点；
  // 未配置密钥时保持原 Gateway（BYOK）路径，不改变既有部署。
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim()
  if (model.provider === 'deepseek' && env.AI_TEXT_EGRESS === 'direct' && deepseekKey)
    return deepseekChat(
      { baseURL: DEEPSEEK_DIRECT_BASE_URL, apiKey: deepseekKey },
      model.providerModelId,
    )
  const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim()
  const gatewayId = env.AI_GATEWAY_ID?.trim()
  if (!accountId || !gatewayId) {
    throw new AppError(AI_PROVIDER_NOT_CONFIGURED, 'AI Gateway is not configured', { status: 503 })
  }
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}`
  switch (model.provider) {
    case 'openai':
      return openAiChat(
        gatewayOptions(`${baseURL}/openai`, env, env.OPENAI_API_KEY, 'authorization'),
        model.providerModelId,
      )
    case 'anthropic':
      return createAnthropic(
        gatewayOptions(`${baseURL}/anthropic/v1`, env, env.ANTHROPIC_API_KEY, 'x-api-key'),
      )(model.providerModelId)
    case 'google':
      return createGoogleGenerativeAI(
        gatewayOptions(
          `${baseURL}/google-ai-studio/v1beta`,
          env,
          env.GOOGLE_API_KEY,
          'x-goog-api-key',
        ),
      )(model.providerModelId)
    case 'deepseek':
      return deepseekChat(
        gatewayOptions(`${baseURL}/deepseek`, env, env.DEEPSEEK_API_KEY, 'authorization'),
        model.providerModelId,
      )
    default:
      throw new AppError(
        AI_PROVIDER_NOT_CONFIGURED,
        `No language model provider is configured for ${model.provider}`,
        { status: 503 },
      )
  }
}

import { AppError } from '@product-res/shared'
import { createFalMediaProvider } from './fal.ts'
import type { TaskMediaProvider } from './provider.ts'
import { createWorkersAiMediaProvider, type WorkersAiBinding } from './workers-ai.ts'

export interface MediaProviderEnv {
  readonly FAL_KEY?: string
  readonly AI?: WorkersAiBinding
  readonly MEDIA_WEBHOOK_SECRET?: string
}

export interface MediaProviderDefinition {
  readonly id: string
  readonly synchronous: boolean
  readonly supportedKinds: readonly ('image' | 'video')[]
  readonly outputHosts: readonly string[]
  isConfigured(env: MediaProviderEnv): boolean
  create(env: MediaProviderEnv, options: { modelId: string }): TaskMediaProvider
}

export const mediaProviderDefinitions: readonly MediaProviderDefinition[] = [
  {
    id: 'fal',
    synchronous: false,
    supportedKinds: ['image', 'video'],
    // fal 官方 API 示例与现有夹具的主机；只允许精确主机名。
    outputHosts: ['fal.media', 'v3.fal.media', 'v3b.fal.media'],
    isConfigured: (env) => Boolean(env.FAL_KEY),
    create(env, { modelId }) {
      if (!env.FAL_KEY) throw unavailable()
      return createFalMediaProvider({ apiKey: env.FAL_KEY, modelId, fetch: globalThis.fetch })
    },
  },
  {
    id: 'workers-ai',
    synchronous: true,
    supportedKinds: ['image'],
    outputHosts: [],
    isConfigured: (env) => Boolean(env.AI),
    create(env, { modelId }) {
      if (!env.AI) throw unavailable()
      return createWorkersAiMediaProvider({ binding: env.AI, modelId })
    },
  },
]

function unavailable() {
  return new AppError('AI_PROVIDER_NOT_CONFIGURED', 'Media provider is not configured', {
    status: 503,
  })
}

export function getMediaProviderDefinition(id: string): MediaProviderDefinition | undefined {
  return mediaProviderDefinitions.find((definition) => definition.id === id)
}

export function getMediaOutputHosts(id: string): readonly string[] {
  return getMediaProviderDefinition(id)?.outputHosts ?? []
}

export function requireMediaProviderDefinition(
  id: string,
  env: MediaProviderEnv,
  enabledProviders: readonly string[] = mediaProviderDefinitions.map((definition) => definition.id),
): MediaProviderDefinition {
  const definition = getMediaProviderDefinition(id)
  if (!definition || !enabledProviders.includes(id))
    throw new AppError('MODEL_UNAVAILABLE', 'Media provider is not enabled', { status: 404 })
  if (!definition.isConfigured(env)) throw unavailable()
  return definition
}

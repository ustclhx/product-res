import type { AiModality } from '@product-res/config'
import { AppError } from '@product-res/shared'

/** 后台选项与保存端共用目标能力过滤，模板启用不代表当前目标已装配 binding。 */
export function availableMediaProviders(
  mediaProviders: readonly string[],
  workersAi = true,
): string[] {
  return mediaProviders.filter((provider) => provider !== 'workers-ai' || workersAi)
}

/** 保存端复核模板启用列表与目标能力，避免绕过表单提交不可用服务商。 */
export function assertModelProviderEnabled(
  kind: AiModality,
  provider: string,
  mediaProviders: readonly string[],
  workersAi = true,
): void {
  if (provider === 'workers-ai' && !workersAi) {
    throw new AppError(
      'MODEL_PROVIDER_UNAVAILABLE',
      'Workers AI is not available on this runtime',
      {
        status: 400,
      },
    )
  }
  if (kind !== 'text' && !mediaProviders.includes(provider)) {
    throw new AppError('MEDIA_PROVIDER_DISABLED', 'Media provider is not enabled', { status: 400 })
  }
}

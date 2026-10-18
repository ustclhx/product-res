import { AppError } from '@product-res/shared'
import { z } from 'zod'
import type { AiModality } from './pricing.ts'

export const ACCEPTANCE_FAULT_PREFIX = 'acceptance-fault-'
export const ACCEPTANCE_FAULT_INVALID = 'ACCEPTANCE_FAULT_INVALID'

const acceptanceFaultSchema = z
  .object({
    mode: z.enum([
      'workers-error',
      'workers-timeout',
      'fal-callback-lost',
      'fal-callback-early',
      'fal-submit-response-lost',
      'fal-provider-error',
      'fal-timeout',
      'chat-before-stream',
      'chat-mid-stream',
    ]),
  })
  .strict()

export type AcceptanceFault = z.infer<typeof acceptanceFaultSchema>
export type AcceptanceFaultMode = AcceptanceFault['mode']

/** 只能由服务端环境和可信身份装配；缺省上下文不授予故障访问权限。 */
export interface FaultAccessContext {
  readonly enabled: boolean
  readonly platformAdmin: boolean
}

const invalidFault = () =>
  new AppError(ACCEPTANCE_FAULT_INVALID, 'Acceptance fault model configuration is invalid', {
    status: 503,
  })

/** 媒体 schema 解析也校验保留扩展，不能静默接受未知模式或可调执行策略。 */
export function parseAcceptanceFaultMetadata(value: unknown): AcceptanceFault {
  const parsed = acceptanceFaultSchema.safeParse(value)
  if (!parsed.success) throw invalidFault()
  return parsed.data
}

/** 配置必须同时具备专用 key 与合法元数据；任何半配置都不能降级为普通调用。 */
export function parseAcceptanceFault(model: {
  readonly key: string
  readonly kind: AiModality
  readonly provider: string
  readonly providerModelId: string
  readonly paramsSchema?: Record<string, unknown> | null | undefined
}): AcceptanceFault | undefined {
  const dedicated = model.key.startsWith(ACCEPTANCE_FAULT_PREFIX)
  const schema = model.paramsSchema
  const hasMetadata = schema != null && Object.hasOwn(schema, 'x-acceptance-fault')
  if (!dedicated && !hasMetadata) return undefined
  if (!dedicated || !hasMetadata) throw invalidFault()
  const fault = parseAcceptanceFaultMetadata(schema?.['x-acceptance-fault'])
  const valid = fault.mode.startsWith('workers-')
    ? model.kind === 'image' &&
      model.provider === 'workers-ai' &&
      model.providerModelId === '@cf/black-forest-labs/flux-1-schnell'
    : fault.mode.startsWith('fal-')
      ? model.kind === 'image' &&
        model.provider === 'fal' &&
        model.providerModelId === 'fal-ai/flux/schnell'
      : model.kind === 'text' &&
        model.provider === 'deepseek' &&
        model.providerModelId === 'deepseek-flash'
  if (!valid) throw invalidFault()
  return fault
}

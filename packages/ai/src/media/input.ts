import type { AiTask } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { z } from 'zod'
import {
  type MediaAcceptanceFault,
  type MediaAcceptanceFaultProof,
  parseMediaFaultSnapshot,
} from './fault.ts'
import { createMediaParamsValidator, parseMediaSchema } from './params.ts'

export interface MediaTaskInput {
  params: Record<string, unknown>
  providerModelId: string
  unitsLimit: number
  fileParams: string[]
  storageBytes: number
  callbackOrigin?: string | undefined
  acceptanceFault?: MediaAcceptanceFault
  acceptanceFaultProof?: MediaAcceptanceFaultProof
}

const snapshot = z.object({
  params: z.record(z.string(), z.unknown()),
  providerModelId: z.string().min(1),
  unitsLimit: z.number().finite().positive(),
  fileParams: z.array(z.string().min(1)),
  storageBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  callbackOrigin: z.url({ protocol: /^https?$/ }).optional(),
})

export function readMediaTaskInput(task: Pick<AiTask, 'input'>): MediaTaskInput {
  const parsed = snapshot.safeParse(task.input)
  if (!parsed.success)
    throw new AppError('MEDIA_INPUT_INVALID', 'Invalid media task snapshot', { status: 500 })
  // Provider 重建处有完整任务，runner/提交入口另行校验故障快照的身份配对。
  return {
    ...parsed.data,
    ...(task.input.acceptanceFault === undefined
      ? {}
      : {
          acceptanceFault: parseMediaFaultSnapshot(task.input.acceptanceFault),
        }),
    ...(task.input.acceptanceFaultProof === undefined
      ? {}
      : {
          acceptanceFaultProof: task.input.acceptanceFaultProof as MediaAcceptanceFaultProof,
        }),
  }
}

/** 模型参数解析与表单共用浏览器安全实现；数据库文件权限仍由提交事务检查。 */
export function validateMediaParams(
  schema: Record<string, unknown> | null,
  params: Record<string, unknown>,
  kind: 'image' | 'video',
): { params: Record<string, unknown>; fileParams: string[]; unitsLimit: number } {
  const mediaSchema = parseMediaSchema(schema)
  const parsed = createMediaParamsValidator(mediaSchema, kind).safeParse(params)
  if (!parsed.success)
    throw new AppError(
      'INVALID_PARAMS',
      parsed.error.issues.find((issue) => issue.code === 'custom')?.message ??
        'Invalid media model parameters',
    )
  const unitsParam =
    mediaSchema['x-media']?.unitsParam ?? (kind === 'image' ? 'num_images' : 'duration')
  return {
    params: parsed.data,
    fileParams: Object.entries(mediaSchema.properties)
      .filter(([name, field]) => field.format === 'file' && parsed.data[name] !== undefined)
      .map(([name]) => name),
    unitsLimit: (parsed.data[unitsParam] ?? 1) as number,
  }
}

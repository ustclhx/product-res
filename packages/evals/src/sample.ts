import { z } from 'zod'
import { EvalConfigError } from './errors.ts'

/** 样本与检查 ID 会出现在录制文件名中，只允许不含路径分隔符的短标识 */
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
)

/**
 * 样本（design D4）：`input` 原样传给提示词的 `user(input)`；`expect` 按检查 ID 覆盖或追加
 * 套件级检查参数，其中 `severity` 可把某个检查对该样本降为警告。
 */
export const sampleSchema = z.strictObject({
  id: z.string().regex(idPattern),
  input: jsonValue,
  expect: z
    .record(
      z.string().regex(idPattern),
      z.looseObject({ severity: z.enum(['error', 'warn']).optional() }),
    )
    .optional(),
  tags: z.array(z.string().min(1)).optional(),
})

export type Sample = z.infer<typeof sampleSchema>

export const samplesSchema = z.array(sampleSchema).min(1)

export function parseSamples(data: unknown, source = 'samples.json'): Sample[] {
  const parsed = samplesSchema.safeParse(data)
  if (!parsed.success)
    throw new EvalConfigError(
      `${source} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
    )
  const seen = new Set<string>()
  for (const sample of parsed.data) {
    if (seen.has(sample.id))
      throw new EvalConfigError(`${source}: duplicate sample id ${sample.id}`)
    seen.add(sample.id)
  }
  return parsed.data
}

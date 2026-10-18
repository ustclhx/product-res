import { z } from 'zod'

export const adminPlanModelsInput = z.object({
  id: z.uuid(),
  models: z
    .array(z.string().trim().min(1).max(200))
    .max(1000)
    .transform((models) => [...new Set(models)]),
})

export const adminPlansListInput = z.object({
  offset: z.number().int().min(0).max(100_000).default(0),
  q: z.string().trim().max(200).optional(),
})

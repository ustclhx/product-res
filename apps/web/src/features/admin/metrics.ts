import { type Database, metricsDaily } from '@product-res/db'
import { and, asc, gte, lte } from 'drizzle-orm'
import { z } from 'zod'

export const metricsSearchSchema = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'Invalid date range',
  })

export async function readAdminMetrics(
  db: Database,
  input: z.infer<typeof metricsSearchSchema>,
  now = new Date(),
) {
  const data = metricsSearchSchema.parse(input)
  const to = data.to ?? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10)
  const from =
    data.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
  // 看板只读已汇总数据；存量采用区间最后一日，增量求和，成功率按样本加权。
  const rows = await db
    .select()
    .from(metricsDaily)
    .where(and(gte(metricsDaily.day, from), lte(metricsDaily.day, to)))
    .orderBy(asc(metricsDaily.day))
  const overageByModel: Record<string, number> = {}
  let registrations = 0,
    creditsConsumed = 0,
    overageAbsorbed = 0,
    completed = 0,
    attempts = 0
  for (const row of rows) {
    registrations += row.registrations
    creditsConsumed += row.creditsConsumed
    overageAbsorbed += row.overageAbsorbed
    completed += row.textCompleted
    attempts += row.textCompleted + row.textFailed + row.textAborted
    for (const [model, value] of Object.entries(row.overageByModel))
      overageByModel[model] = (overageByModel[model] ?? 0) + value
  }
  const latest = rows.at(-1) ?? null
  return {
    rows,
    from,
    to,
    latest,
    registrations,
    creditsConsumed,
    overageAbsorbed,
    overageByModel,
    successRate: attempts ? completed / attempts : null,
    attempts,
    paidConversion: latest?.totalWorkspaces ? latest.paidWorkspaces / latest.totalWorkspaces : null,
  }
}

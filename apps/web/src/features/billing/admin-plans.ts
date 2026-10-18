import { aiModel, type Database, plan } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { asc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { AdminActionScope } from '../admin/action.ts'
import { ADMIN_PAGE_SIZE } from '../admin/list.ts'
import { adminPlanModelsInput, type adminPlansListInput } from './admin-plans-input.ts'

export async function listAdminPlans(db: Database, data: z.infer<typeof adminPlansListInput>) {
  const [rows, models] = await Promise.all([
    db
      .select({
        id: plan.id,
        key: plan.key,
        name: plan.name,
        type: plan.type,
        active: plan.active,
        features: plan.features,
      })
      .from(plan)
      .where(
        data.q ? or(ilike(plan.key, `%${data.q}%`), ilike(plan.name, `%${data.q}%`)) : undefined,
      )
      .orderBy(asc(plan.sort), asc(plan.key))
      .offset(data.offset)
      .limit(ADMIN_PAGE_SIZE + 1),
    db
      .select({ key: aiModel.key, enabled: aiModel.enabled })
      .from(aiModel)
      .orderBy(asc(aiModel.key)),
  ])
  return {
    rows: rows
      .slice(0, ADMIN_PAGE_SIZE)
      .map(({ features, ...row }) => ({ ...row, models: features.models })),
    hasMore: rows.length > ADMIN_PAGE_SIZE,
    models,
  }
}

export async function updateAdminPlanModels(scope: AdminActionScope, input: unknown) {
  const data = adminPlanModelsInput.parse(input)
  const { tx, audit } = scope
  // 锁住当前套餐，校验历史授权并保留其他权益；审计旧值与实际覆盖值一致。
  const [before] = await tx.select().from(plan).where(eq(plan.id, data.id)).for('update')
  if (!before) throw new AppError('NOT_FOUND', 'Plan not found', { status: 404 })
  const existing = data.models.length
    ? await tx.select({ key: aiModel.key }).from(aiModel).where(inArray(aiModel.key, data.models))
    : []
  const allowed = new Set(['*', ...before.features.models, ...existing.map((row) => row.key)])
  if (data.models.some((key) => !allowed.has(key)))
    throw new AppError('INVALID_PLAN_MODEL', 'Choose an existing model or retain a historical key.')
  await tx
    .update(plan)
    .set({
      features: sql`jsonb_set(${plan.features}, '{models}', ${JSON.stringify(data.models)}::jsonb)`,
    })
    .where(eq(plan.id, data.id))
  await audit({
    action: 'admin.plan.models.update',
    targetType: 'plan',
    targetId: data.id,
    meta: { key: before.key, models: { before: before.features.models, after: data.models } },
  })
  return data.id
}

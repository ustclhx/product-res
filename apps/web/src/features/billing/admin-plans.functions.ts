import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { withBilling } from '../../server/feature-gates.ts'
import { withAdminAction } from '../admin/action.server.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'
import { listAdminPlans, updateAdminPlanModels } from './admin-plans.ts'
import { adminPlanModelsInput, adminPlansListInput } from './admin-plans-input.ts'

export const getAdminPlans = createServerFn({ method: 'GET' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(adminPlansListInput)
  .handler(({ context, data }) => listAdminPlans(context.db, data))

export const saveAdminPlanModels = createServerFn({ method: 'POST' })
  .middleware([withBilling, adminMiddleware])
  .inputValidator(adminPlanModelsInput)
  .handler(async ({ context, data }) => {
    try {
      const id = await withAdminAction(context, 'admin.plan.models.update', (scope) =>
        updateAdminPlanModels(scope, data),
      )
      return { ok: true as const, id }
    } catch (error) {
      if (error instanceof AppError) return { ok: false as const, error: error.message }
      throw error
    }
  })

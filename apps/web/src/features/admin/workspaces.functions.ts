import { getCreditBatches, getCreditLedger } from '@product-res/credits'
import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withCredits } from '../../server/feature-gates.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { adminMiddleware } from './admin.functions.ts'
import { executeAdminWorkspaceRestore } from './workspaces.server.ts'
import { adminWorkspaceDetail, listAdminWorkspaces } from './workspaces.ts'

export const getAdminWorkspaces = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(
    z.object({
      offset: z.number().int().min(0).max(100_000),
      q: z.string().max(200).optional(),
      status: z.enum(['active', 'deleted']).optional(),
    }),
  )
  .handler(({ context, data }) => listAdminWorkspaces(context.db, data))

export const getAdminWorkspace = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(({ context, data }) =>
    adminWorkspaceDetail(
      context.db,
      data.id,
      templateConfig.billing.pastDueGraceDays,
      templateConfig,
    ),
  )

const creditCursor = z.object({ id: z.uuid(), createdAt: z.string().max(40) })
export const getAdminWorkspaceCredits = createServerFn({ method: 'GET' })
  .middleware([withCredits, adminMiddleware])
  .validator(z.object({ id: z.uuid(), kind: z.enum(['batches', 'ledger']), cursor: creditCursor }))
  .handler(({ context, data }) =>
    data.kind === 'batches'
      ? getCreditBatches(context.db, data.id, { cursor: data.cursor })
      : getCreditLedger(context.db, data.id, { cursor: data.cursor }),
  )

export const restoreAdminWorkspace = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    try {
      await executeAdminWorkspaceRestore(context, {
        runtime: getWebRuntime(),
        headers: getRequest().headers,
        workspaceId: data.id,
      })
      return { ok: true as const }
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      return { ok: false as const, code: error.code, message: error.message }
    }
  })

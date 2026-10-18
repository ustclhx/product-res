import { CreditsError, getCreditBalance } from '@product-res/credits'
import { creditGrant } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { withCredits } from '../../server/feature-gates.ts'
import { adminAction } from './action.server.ts'
import { adminMiddleware } from './admin.functions.ts'
import { adjustAdminCredits, creditAdjustmentInput } from './credits.ts'
import { ADMIN_PAGE_SIZE } from './list.ts'

export const getAdminCredits = createServerFn({ method: 'GET' })
  .middleware([withCredits, adminMiddleware])
  .inputValidator(
    z.object({ workspaceId: z.uuid().optional(), offset: z.number().int().min(0).max(100_000) }),
  )
  .handler(async ({ context, data }) => {
    if (!data.workspaceId) return { rows: [], hasMore: false, balance: null }
    const rows = await context.db
      .select()
      // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes reading the explicitly selected workspace's credit batches.
      .from(creditGrant)
      .where(eq(creditGrant.workspaceId, data.workspaceId))
      .orderBy(desc(creditGrant.createdAt), desc(creditGrant.id))
      .limit(ADMIN_PAGE_SIZE + 1)
      .offset(data.offset)
    return {
      rows: rows.slice(0, ADMIN_PAGE_SIZE),
      hasMore: rows.length > ADMIN_PAGE_SIZE,
      balance: await getCreditBalance(context.db, data.workspaceId),
    }
  })

export const adjustCredits = createServerFn({ method: 'POST' })
  .middleware([withCredits, adminMiddleware])
  .inputValidator(creditAdjustmentInput)
  .handler(async (input) => {
    try {
      const result = await adminAction(
        'credits.adjust',
        ({
          data,
          ...scope
        }: Parameters<typeof adjustAdminCredits>[0] & {
          data: z.infer<typeof creditAdjustmentInput>
        }) => adjustAdminCredits(scope, data),
      )(input)
      return { ok: true as const, ...result }
    } catch (error) {
      if (!(error instanceof AppError) && !(error instanceof CreditsError)) throw error
      return { ok: false as const, error: error.code }
    }
  })

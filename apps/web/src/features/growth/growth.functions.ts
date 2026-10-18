import { waitlist } from '@product-res/db'
import { requireCapability } from '@product-res/platform'
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { withAdminAction } from '../admin/action.server.ts'
import { adminMiddleware } from '../admin/admin.functions.ts'
import { ADMIN_PAGE_SIZE } from '../admin/list.ts'
import { growthContext } from './http.ts'
import { prepareWaitlistInvitations, sendWaitlistInvitations } from './service.ts'

export const getGrowthFormOptions = createServerFn({ method: 'GET' })
  .inputValidator(z.enum(['waitlist', 'newsletter']))
  .handler(({ data }) => {
    if (!templateConfig.features[data]) throw notFound()
    return {
      siteKey: templateConfig.auth.turnstile
        ? (getWebRuntime().config.TURNSTILE_SITE_KEY ?? null)
        : null,
    }
  })

export const getAdminWaitlist = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ offset: z.number().int().min(0).max(100000) }))
  .handler(async ({ context, data }) => {
    if (!templateConfig.features.waitlist) throw notFound()
    const rows = await context.db
      .select({
        id: waitlist.id,
        email: waitlist.email,
        createdAt: waitlist.createdAt,
        invitedAt: waitlist.invitedAt,
      })
      .from(waitlist)
      .orderBy(desc(waitlist.id))
      .limit(ADMIN_PAGE_SIZE + 1)
      .offset(data.offset)
    return { rows: rows.slice(0, ADMIN_PAGE_SIZE), hasMore: rows.length > ADMIN_PAGE_SIZE }
  })

export const inviteAdminWaitlist = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .inputValidator(z.object({ ids: z.array(z.uuid()).min(1).max(50) }))
  .handler(async ({ context, data }) => {
    if (!templateConfig.features.waitlist) throw notFound()
    const ctx = { ...growthContext(), db: context.db }
    requireCapability(ctx.queue, 'Email queue')
    const rows = await withAdminAction(context, 'waitlist.invite', (scope) =>
      prepareWaitlistInvitations(scope, data.ids),
    )
    await sendWaitlistInvitations(ctx, rows)
    return { count: rows.length }
  })

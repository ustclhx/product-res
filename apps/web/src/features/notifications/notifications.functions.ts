import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { listNotifications, markNotificationsRead } from './service.ts'

const input = z.object({ slug: z.string().min(1).max(64) })
export const getNotifications = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(input.extend({ offset: z.number().int().min(0).max(100000).default(0) }))
  .handler(({ context, data }) =>
    listNotifications(context.db, context.workspace.id, context.user.id, data.offset),
  )

export const readNotifications = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(input.extend({ id: z.uuid().optional() }))
  .handler(({ context, data }) =>
    markNotificationsRead(context.db, context.workspace.id, context.user.id, data.id),
  )

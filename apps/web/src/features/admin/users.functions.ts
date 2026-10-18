import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { z } from 'zod'
import { getWebRuntime } from '../../server/runtime.ts'
import { adminMiddleware } from './admin.functions.ts'
import { executeAdminAuthAction } from './impersonation.server.ts'
import { adminUserDetail, listAdminUsers } from './users.ts'

export const getAdminUsers = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(
    z.object({ offset: z.number().int().min(0).max(100_000), q: z.string().max(200).optional() }),
  )
  .handler(({ context, data }) => listAdminUsers(context.db, data))

export const getAdminUser = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(({ context, data }) => adminUserDetail(context.db, data.id))

export const setAdminUserBan = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(
    z.object({ userId: z.uuid(), banned: z.boolean(), reason: z.string().trim().min(1).max(2000) }),
  )
  .handler(async ({ context, data }) => {
    await executeAdminAuthAction({
      db: context.db,
      runtime: getWebRuntime(),
      headers: getRequest().headers,
      path: data.banned ? '/admin/ban-user' : '/admin/unban-user',
      body: { userId: data.userId, banReason: data.reason },
    })
    return { ok: true }
  })

export const startAdminImpersonation = createServerFn({ method: 'POST' })
  .middleware([adminMiddleware])
  .validator(z.object({ userId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const response = await executeAdminAuthAction({
      db: context.db,
      runtime: getWebRuntime(),
      headers: getRequest().headers,
      path: '/admin/impersonate-user',
      body: data,
    })
    setResponseHeader('set-cookie', response.headers.getSetCookie())
    return { ok: true }
  })

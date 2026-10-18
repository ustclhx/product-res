import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { getWebRuntime } from '../../server/runtime.ts'
import { readRequestSession } from '../i18n/session.server.ts'
import { executeAdminAuthAction } from './impersonation.server.ts'

export const getImpersonation = createServerFn({ method: 'GET' }).handler(async () => {
  const runtime = getWebRuntime()
  const { db, auth } = runtime
  try {
    const fresh = await readRequestSession({
      auth,
      db,
      headers: getRequest().headers,
    })
    const adminId = fresh.session.impersonatedBy
    if (!adminId) return null
    const admin = await db.query.user.findFirst({
      where: (u, { eq }) => eq(u.id, adminId),
    })
    return { userEmail: fresh.user.email, adminEmail: admin?.email ?? adminId }
  } catch (error) {
    if (error instanceof AppError && [401, 403].includes(error.status)) return null
    throw error
  }
})

export const stopAdminImpersonation = createServerFn({ method: 'POST' }).handler(async () => {
  const runtime = getWebRuntime()
  const response = await executeAdminAuthAction({
    db: runtime.db,
    runtime,
    headers: getRequest().headers,
    path: '/admin/stop-impersonating',
  })
  setResponseHeader('set-cookie', response.headers.getSetCookie())
  return { ok: true }
})

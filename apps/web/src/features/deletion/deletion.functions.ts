import { deleteAccount, deleteTeamWorkspace } from '@product-res/auth'
import { AppError } from '@product-res/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseStatus } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withRealSession } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { createBillingDeletionSteps } from '../billing/deletion.server.ts'

async function remove(workspaceId?: string) {
  const runtime = getWebRuntime()
  const db = runtime.db
  const options = {
    db,
    auth: runtime.auth,
    headers: getRequest().headers,
    clientIp: runtime.requestMeta.clientIp,
    kv: runtime.cache,
    additionalSteps: createBillingDeletionSteps(runtime.config, db, runtime.cache),
  }
  try {
    if (workspaceId)
      await deleteTeamWorkspace({
        ...options,
        workspaceId,
        multiTenant: templateConfig.tenancy.multiTenant,
      })
    else await deleteAccount(options)
    return { ok: true as const }
  } catch (error) {
    if (!(error instanceof AppError)) throw error
    if (error.status === 503) setResponseStatus(503)
    return {
      ok: false as const,
      code: error.code,
      message: error.message,
      deletionCompleted: error.details?.deletionCompleted === true,
      workspaces: (error.details?.workspaces ?? []) as { id: string; name: string; slug: string }[],
    }
  }
}
export const removeAccount = createServerFn({ method: 'POST' })
  .middleware([withRealSession])
  .handler(() => remove())
export const removeWorkspace = createServerFn({ method: 'POST' })
  .middleware([withRealSession])
  .validator(z.object({ workspaceId: z.uuid() }))
  .handler(({ data }) => remove(data.workspaceId))

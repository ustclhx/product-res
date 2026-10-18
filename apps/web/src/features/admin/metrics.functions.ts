import { createServerFn } from '@tanstack/react-start'
import { adminMiddleware } from './admin.functions.ts'
import { metricsSearchSchema, readAdminMetrics } from './metrics.ts'

export const getAdminMetrics = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(metricsSearchSchema)
  .handler(({ context, data }) => readAdminMetrics(context.db, data))

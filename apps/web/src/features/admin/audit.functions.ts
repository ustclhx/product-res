import { createServerFn } from '@tanstack/react-start'
import { adminMiddleware } from './admin.functions.ts'
import { auditSearchSchema, listAuditLogs } from './audit.ts'

export const getAdminAuditLogs = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .validator(auditSearchSchema)
  .handler(({ context, data }) => listAuditLogs(context.db, data))

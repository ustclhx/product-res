import { requireFreshSession } from '@product-res/auth'
import { AppError } from '@product-res/shared'
import { isNotFound } from '@tanstack/react-router'
import { z } from 'zod'
import type { WebRuntime } from '../../server/runtime.ts'
import { requireAdmin } from './guard.ts'
import { executeAdminAuthAction } from './impersonation.server.ts'
import { assertRealSession, isSensitiveAuthPath } from './impersonation.ts'
import { executeAdminWorkspaceRestore } from './workspaces.server.ts'

/** 原生 admin HTTP 接口也经过事务包装，不能通过直接请求绕过审计或模拟限制。 */
export async function handleAuthRequest(request: Request, runtime: WebRuntime) {
  const { db, auth } = runtime
  const path = new URL(request.url).pathname.slice('/api/auth'.length)
  try {
    if (path.startsWith('/admin/')) {
      if (path === '/admin/stop-impersonating' && request.method === 'POST')
        return await executeAdminAuthAction({ db, runtime, headers: request.headers, path })
      // 先隐藏后台，再解析输入，避免非管理员通过畸形 JSON 辨认管理入口。
      const fresh = await requireAdmin({ db, auth, headers: request.headers })
      if (
        request.method === 'POST' &&
        ['/admin/ban-user', '/admin/unban-user', '/admin/impersonate-user'].includes(path)
      )
        return await executeAdminAuthAction({
          db,
          runtime,
          headers: request.headers,
          path,
          body: await request.json(),
        })
      if (request.method === 'POST' && path === '/admin/restore-workspace') {
        const input = z.object({ workspaceId: z.uuid() }).safeParse(await request.json())
        if (!input.success)
          throw new AppError('INVALID_INPUT', 'Valid workspace ID is required', { status: 400 })
        return Response.json(
          await executeAdminWorkspaceRestore(
            { db, admin: fresh.user, ip: runtime.requestMeta.clientIp },
            { runtime, headers: request.headers, workspaceId: input.data.workspaceId },
          ),
        )
      }
      // 明确的只读白名单；新插件端点不能绕过平台的写入约束与审计。
      if (request.method !== 'GET' || !['/admin/list-users', '/admin/get-user'].includes(path))
        return Response.json({ code: 'NOT_FOUND', message: 'Not Found' }, { status: 404 })
    } else if (isSensitiveAuthPath(path)) {
      const fresh = await requireFreshSession({ db, auth, headers: request.headers })
      assertRealSession(fresh.session)
    }
    return await auth.handler(request)
  } catch (error) {
    if (isNotFound(error))
      return Response.json({ code: 'NOT_FOUND', message: 'Not Found' }, { status: 404 })
    if (error instanceof SyntaxError)
      return Response.json({ code: 'INVALID_INPUT', message: 'Invalid JSON body' }, { status: 400 })
    if (!(error instanceof AppError)) throw error
    return Response.json({ code: error.code, message: error.message }, { status: error.status })
  }
}

import { requireFreshSession } from '@product-res/auth'
import { type Database, session, user } from '@product-res/db'
import type { KeyValueStore } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { WebRuntime } from '../../server/runtime.ts'
import { withAdminAction } from './action.server.ts'
import { isPlatformAdmin, requireAdmin } from './guard.ts'
import { assertRealSession } from './impersonation.ts'

const bodySchema = (body: unknown) => {
  const parsed = z
    .object({ userId: z.uuid(), banReason: z.string().trim().max(2000).optional() })
    .safeParse(body)
  if (!parsed.success)
    throw new AppError('INVALID_INPUT', 'Valid user ID and reason are required', { status: 400 })
  return { userId: parsed.data.userId, reason: parsed.data.banReason ?? '' }
}

/** KV 写入在数据库提交后执行；失败仍由实时数据库守卫阻止失效会话。 */
function stagedCache(cache: KeyValueStore) {
  const pending: (() => Promise<void>)[] = []
  function get(key: string): Promise<string | null>
  function get<T>(key: string, type: 'json'): Promise<T | null>
  async function get<T>(key: string, type?: 'json'): Promise<T | string | null> {
    const value = key.startsWith('auth:active-sessions-') ? await cache.get(key) : null
    return value === null || type !== 'json' ? value : (JSON.parse(value) as T)
  }
  const staged: KeyValueStore = {
    get,
    put: async (...args: Parameters<KeyValueStore['put']>) => {
      pending.push(() => cache.put(...args))
    },
    delete: async (key: string) => {
      pending.push(() => cache.delete(key))
    },
  }
  return {
    cache: staged,
    flush: async () => {
      for (const action of pending) {
        try {
          await action()
        } catch (error) {
          log.warn('admin.auth.cache_cleanup_failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
  }
}

/** 原生 admin 插件的会话 / 用户写入使用同一 Drizzle 事务，审计失败则一并回滚。 */
export async function executeAdminAuthAction(options: {
  db: Database
  runtime: WebRuntime
  headers: Headers
  path: string
  body?: unknown
}) {
  const { db, headers, path, runtime } = options
  const createAuth = (database: Database, cache?: KeyValueStore) =>
    runtime.createAuth(database, cache)
  const ip = runtime.requestMeta.clientIp
  const appUrl = runtime.config.APP_URL
  const sourceCache = runtime.cache
  const stopping = path === '/admin/stop-impersonating'
  const fresh = stopping
    ? await requireFreshSession({ auth: createAuth(db), db, headers }).catch((error: unknown) => {
        if (error instanceof AppError && [401, 403].includes(error.status))
          throw new AppError('NOT_FOUND', 'Not Found', { status: 404 })
        throw error
      })
    : await requireAdmin({ auth: createAuth(db), db, headers })
  if (!stopping) assertRealSession(fresh.session)
  const adminId = stopping ? fresh.session.impersonatedBy : fresh.user.id
  if (!adminId) throw new AppError('NOT_FOUND', 'Not Found', { status: 404 })
  const input = stopping ? { userId: fresh.user.id, reason: '' } : bodySchema(options.body)
  const cache = stagedCache(sourceCache)
  const response = await withAdminAction(
    { db, admin: { id: adminId }, ip },
    path,
    async ({ tx, audit }) => {
      const [current] = await tx
        .select()
        .from(session)
        .where(eq(session.id, fresh.session.id))
        .for('share')
      if (!current || current.expiresAt <= new Date())
        throw new AppError('SESSION_REQUIRED', 'Session expired', { status: 401 })
      const [target] = await tx.select().from(user).where(eq(user.id, input.userId)).for('update')
      if (!target) throw new AppError('NOT_FOUND', 'User not found', { status: 404 })
      if (path === '/admin/impersonate-user' && isPlatformAdmin(target.role))
        throw new AppError('IMPERSONATE_ADMIN_FORBIDDEN', 'Cannot impersonate administrators', {
          status: 403,
        })
      if (path === '/admin/ban-user' && input.userId === adminId)
        throw new AppError('SELF_BAN_FORBIDDEN', 'Cannot ban yourself', { status: 403 })
      if (
        (path === '/admin/ban-user' || path === '/admin/unban-user') &&
        (!input.reason || input.reason.length > 2000)
      )
        throw new AppError('REASON_REQUIRED', 'A reason is required', { status: 400 })
      // 插件只能使用本事务；关闭读取 KV，避免原生权限中间件读取旧角色 / 会话。
      const txDb = tx as unknown as Database
      const txAuth = createAuth(txDb, cache.cache)
      const nativeHeaders = new Headers(headers)
      nativeHeaders.set('content-type', 'application/json')
      const native = await txAuth.handler(
        new Request(`${appUrl}/api/auth${path}`, {
          method: 'POST',
          headers: nativeHeaders,
          body: JSON.stringify(stopping ? {} : { userId: input.userId, banReason: input.reason }),
        }),
      )
      if (!native.ok) {
        const error = (await native.json()) as { code?: string; message?: string }
        throw new AppError(
          error.code ?? 'ADMIN_AUTH_FAILED',
          error.message ?? 'Auth operation failed',
          { status: native.status },
        )
      }
      // 退出后必须恢复到有效的原管理员会话，不能由失效的 backup cookie 恢复权限。
      if (stopping) {
        const restoredHeaders = new Headers(headers)
        const cookies = new Map<string, string>()
        for (const cookie of native.headers.getSetCookie()) {
          const part = cookie.split(';')[0] ?? ''
          cookies.set(part.slice(0, part.indexOf('=')), part)
        }
        restoredHeaders.set('cookie', [...cookies.values()].join('; '))
        const restored = await requireAdmin({ auth: txAuth, db: txDb, headers: restoredHeaders })
        if (restored.user.id !== adminId)
          throw new AppError('NOT_FOUND', 'Not Found', { status: 404 })
      }
      await audit({
        action: stopping
          ? 'user.impersonation.ended'
          : path === '/admin/impersonate-user'
            ? 'user.impersonation.started'
            : path === '/admin/ban-user'
              ? 'user.banned'
              : 'user.unbanned',
        targetType: 'user',
        targetId: input.userId,
        meta: {
          userId: input.userId,
          actualAdminId: adminId,
          reason: input.reason,
          ...(path.includes('ban-user')
            ? { previousBanned: target.banned, previousReason: target.banReason }
            : {}),
        },
      })
      return native
    },
  )
  await cache.flush()
  return response
}

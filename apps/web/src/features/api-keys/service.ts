import { type Auth, requireFreshSession } from '@product-res/auth'
import type { TemplateConfig } from '@product-res/config'
import { apikey, type Database, member, scoped } from '@product-res/db'
import { type Entitlements, getEntitlements, requireEntitlement } from '@product-res/entitlements'
import type { RateLimiter } from '@product-res/platform'
import { AppError } from '@product-res/shared'
import { setLogContext } from '@product-res/shared/log'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { resolveWorkspaceBySlug } from '../../server/workspace-context.ts'
import { assertRealSession } from '../admin/impersonation.ts'

export interface ApiKeyDeps {
  db: Database
  auth: Auth
  config: TemplateConfig
  entitlements?: (db: Database, workspaceId: string) => Promise<Entitlements>
}

export function requirePublicApi(config: TemplateConfig) {
  if (!config.billing.enabled || !config.features.publicApi)
    throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
}

async function entitlement(deps: ApiKeyDeps, workspaceId: string) {
  return (
    deps.entitlements ??
    ((db, id) =>
      getEntitlements(db, id, {
        pastDueGraceDays: deps.config.billing.pastDueGraceDays,
      }))
  )(deps.db, workspaceId)
}

/** 管理入口每次实时校验会话及空间角色，不能借模拟登录创建持久凭据。 */
async function manager(headers: Headers, slug: string, deps: ApiKeyDeps) {
  requirePublicApi(deps.config)
  const fresh = await requireFreshSession({ db: deps.db, auth: deps.auth, headers })
  assertRealSession(fresh.session)
  const resolved = await resolveWorkspaceBySlug(deps.db, fresh.user.id, slug)
  if (!resolved) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  if (!['owner', 'admin'].includes(resolved.member.role))
    throw new AppError('FORBIDDEN', 'Workspace administrator required', { status: 403 })
  if (!deps.config.tenancy.multiTenant && !resolved.workspace.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  setLogContext({ workspaceId: resolved.workspace.id, userId: fresh.user.id })
  return { ...resolved, user: fresh.user }
}

// apikey 是用户归属的认证表；以插件 metadata 中不可由客户端修改的空间绑定限定管理范围。
const keyScope = (workspaceId: string) =>
  sql`${apikey.metadata}::jsonb ->> 'workspaceId' = ${workspaceId}`
export const createKeySchema = z.object({
  slug: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  expiresAt: z.iso.datetime().optional(),
})
export const editKeySchema = z
  .object({
    slug: z.string().min(1).max(64),
    id: z.uuid(),
    name: z.string().trim().min(1).max(80).optional(),
    revoke: z.boolean().optional(),
  })
  .refine((value) => value.revoke === true || value.name !== undefined)

export async function createWorkspaceKey(
  headers: Headers,
  input: z.infer<typeof createKeySchema>,
  deps: ApiKeyDeps,
) {
  const data = createKeySchema.parse(input)
  const { workspace, user } = await manager(headers, data.slug, deps)
  requireEntitlement(await entitlement(deps, workspace.id), { capability: 'publicApi' })
  const expiresIn = data.expiresAt
    ? Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000)
    : undefined
  if (expiresIn !== undefined && expiresIn < 60)
    throw new AppError('INVALID_REQUEST', 'Expiration must be at least one minute in the future')
  const created = await deps.auth.api.createApiKey({
    body: {
      userId: user.id,
      name: data.name,
      prefix: 'sk_',
      expiresIn,
      metadata: { workspaceId: workspace.id },
      rateLimitEnabled: false,
    },
  })
  // 完整值只从创建操作返回；列表与更新明确投影安全字段。
  return { id: created.id, key: created.key }
}

export async function listWorkspaceKeys(
  headers: Headers,
  slug: string,
  page: number,
  deps: ApiKeyDeps,
) {
  const { workspace } = await manager(headers, slug, deps)
  const rows = await deps.db
    .select({
      id: apikey.id,
      name: apikey.name,
      start: apikey.start,
      enabled: apikey.enabled,
      expiresAt: apikey.expiresAt,
      createdAt: apikey.createdAt,
    })
    .from(apikey)
    .where(keyScope(workspace.id))
    .orderBy(desc(apikey.createdAt))
    .limit(21)
    .offset(page * 20)
  return { rows: rows.slice(0, 20), hasMore: rows.length > 20 }
}

export async function editWorkspaceKey(
  headers: Headers,
  input: z.infer<typeof editKeySchema>,
  deps: ApiKeyDeps,
) {
  const data = editKeySchema.parse(input)
  const { workspace } = await manager(headers, data.slug, deps)
  const [updated] = await deps.db
    .update(apikey)
    .set({
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.revoke ? { enabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(apikey.id, data.id), keyScope(workspace.id)))
    .returning({ id: apikey.id })
  if (!updated) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  return updated
}

/** API 入口仅解析 Bearer，Cookie 不参与鉴权；Key 创建者的封禁和成员身份实时查库。 */
export async function authenticateApiKey(
  request: Request,
  deps: ApiKeyDeps & { rateLimiter: RateLimiter },
) {
  requirePublicApi(deps.config)
  const invalid = () => new AppError('INVALID_API_KEY', 'Invalid API key', { status: 401 })
  const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!token) throw invalid()
  const verified = await deps.auth.api.verifyApiKey({ body: { key: token } })
  if (!verified.valid || !verified.key) throw invalid()
  const key = verified.key
  const metadata = z.object({ workspaceId: z.uuid() }).safeParse(key.metadata)
  if (!metadata.success) throw invalid()
  const workspace = await deps.db.query.organization.findFirst({
    where: (o, { eq }) => eq(o.id, metadata.data.workspaceId),
  })
  const user = await deps.db.query.user.findFirst({
    where: (u, { eq }) => eq(u.id, key.referenceId),
  })
  if (
    !workspace ||
    workspace.deletedAt ||
    !user ||
    (user.banned && (!user.banExpires || user.banExpires > new Date()))
  )
    throw invalid()
  const [membership] = await scoped(deps.db, workspace.id)
    .select(member, { where: eq(member.userId, user.id) })
    .limit(1)
  if (!membership || !['owner', 'admin'].includes(membership.role)) throw invalid()
  if (!deps.config.tenancy.multiTenant && !workspace.isPersonal)
    throw new AppError('WORKSPACE_READ_ONLY', 'Team workspace writes are disabled', { status: 403 })
  setLogContext({ workspaceId: workspace.id, userId: user.id })
  const entitlements = await entitlement(deps, workspace.id)
  requireEntitlement(entitlements, { capability: 'publicApi' })
  for (const limitKey of [`api:key:${key.id}`, `api:workspace:${workspace.id}`]) {
    if (!(await deps.rateLimiter.limit('api', limitKey)).success)
      throw new AppError('RATE_LIMITED', 'Too many requests', { status: 429 })
  }
  return { workspace, member: membership, user, entitlements }
}

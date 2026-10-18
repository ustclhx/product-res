import { env } from 'cloudflare:workers'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { createDb, member, organization, scoped } from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveDefaultWorkspace, resolveWorkspaceBySlug } from '../src/server/workspace-context.ts'

// tasks.md 4.1 / 4.2：当前空间的解析与每次请求的成员校验（specs/workspace-tenancy）。
// 在 workerd 中经 Hyperdrive 连接本地 PG；会话经 Better Auth 读取（含 Cookie 缓存），
// 以验证缓存中的空间信息不会被用来放行。HTTP 层（重定向、404 状态码）见 PR 中的本地实测记录。

const APP_URL = 'http://localhost:3000'
const EMAIL_DOMAIN = `${newId()}.web-workspace-test.example`
const PASSWORD = 'correct-horse-battery-staple'
const SLUG_RE = /^u-[0-9a-z]{8}$/
const teamIds: string[] = []
let startedAt = new Date()

const db = createDb(env.HYPERDRIVE)
const auth = createAuth(
  { BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz', APP_URL },
  db,
  {
    config: defineTemplateConfig({
      app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: async () => {},
  },
)

const post = (path: string, body: unknown, cookie?: string) =>
  auth.handler(
    new Request(`${APP_URL}/api/auth${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: APP_URL,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  )

function cookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => c !== '' && !c.endsWith('='))
    .join('; ')
}

/** 注册并返回用户 id 与会话 Cookie（含 Cookie 缓存） */
async function signUp(name: string) {
  const res = await post('/sign-up/email', {
    email: `${name}-${newId()}@${EMAIL_DOMAIN}`,
    password: PASSWORD,
    name,
  })
  expect(res.status).toBe(200)
  const { user } = (await res.json()) as { user: { id: string } }
  return { id: user.id, cookie: cookieOf(res) }
}

/** 与 withSession 相同的会话读取方式 */
async function sessionOf(cookie: string) {
  const result = await auth.api.getSession({ headers: new Headers({ cookie }) })
  if (!result) throw new Error('no session')
  return result
}

/** 由 owner 创建一个团队空间（直接写库：本测试不依赖 multiTenant 开关与邀请流程） */
async function createTeam(ownerId: string) {
  const id = newId()
  await db.insert(organization).values({ id, name: 'Team', slug: `t-${id}` })
  await scoped(db, id).insert(member, { id: newId(), userId: ownerId, role: 'owner' })
  teamIds.push(id)
  return { id, slug: `t-${id}` }
}

beforeAll(() => {
  startedAt = new Date()
})

afterAll(async () => {
  const sql = db.$client
  const users = await sql<
    { id: string }[]
  >`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  const ids = users.map((u) => u.id)
  await sql`delete from verification where created_at >= ${startedAt.toISOString()}`
  if (ids.length === 0) return
  const orgs = [...ids, ...teamIds]
  await sql`delete from session where user_id in ${sql(ids)}`
  await sql`delete from member where organization_id in ${sql(orgs)} or user_id in ${sql(ids)}`
  await sql`delete from organization where id in ${sql(orgs)}`
  await sql`delete from account where user_id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('/app 的默认空间', () => {
  it('新用户注册后解析到自己的个人空间（/app → /app/<slug>）', async () => {
    const u = await signUp('fresh')
    const { user, session } = await sessionOf(u.cookie)
    const resolved = await resolveDefaultWorkspace(db, user, session.activeOrganizationId)
    expect(resolved?.workspace).toMatchObject({ id: u.id, isPersonal: true })
    expect(resolved?.workspace.slug).toMatch(SLUG_RE)
    expect(resolved?.member).toMatchObject({ userId: u.id, role: 'owner' })
  })

  it('活跃空间仍是成员时优先；被移出后回退到个人空间', async () => {
    const owner = await signUp('owner')
    const u = await signUp('member')
    const team = await createTeam(owner.id)
    await scoped(db, team.id).insert(member, { id: newId(), userId: u.id, role: 'member' })
    const res = await post('/organization/set-active', { organizationId: team.id }, u.cookie)
    expect(res.status).toBe(200)
    const cookie = cookieOf(res)

    const before = await sessionOf(cookie)
    expect(before.session.activeOrganizationId).toBe(team.id)
    expect(
      (await resolveDefaultWorkspace(db, before.user, before.session.activeOrganizationId))
        ?.workspace.id,
    ).toBe(team.id)

    await scoped(db, team.id).delete(member, eq(member.userId, u.id))
    // Cookie 缓存中的活跃空间仍是团队空间，但不据此放行
    const after = await sessionOf(cookie)
    expect(after.session.activeOrganizationId).toBe(team.id)
    const resolved = await resolveDefaultWorkspace(
      db,
      after.user,
      after.session.activeOrganizationId,
    )
    expect(resolved?.workspace.id).toBe(u.id)
  })

  it('个人空间缺失时补建（注册钩子失败的兜底）', async () => {
    const u = await signUp('repair')
    await db.$client`update session set active_organization_id = null where user_id = ${u.id}`
    await scoped(db, u.id).delete(member, undefined)
    await db.delete(organization).where(eq(organization.id, u.id))

    const resolved = await resolveDefaultWorkspace(db, { id: u.id }, null)
    expect(resolved?.workspace).toMatchObject({ id: u.id, isPersonal: true })
    expect(resolved?.member.role).toBe('owner')
  })
})

describe('按 slug 解析（/app/$slug）', () => {
  it('成员可访问自己的空间', async () => {
    const u = await signUp('own')
    const personal = await resolveDefaultWorkspace(db, { id: u.id }, null)
    const slug = personal?.workspace.slug ?? ''
    expect((await resolveWorkspaceBySlug(db, u.id, slug))?.workspace.id).toBe(u.id)
  })

  it('跨空间访问与不存在的空间一样返回空（404）', async () => {
    const a = await signUp('a')
    const b = await signUp('b')
    const bSlug = (await resolveDefaultWorkspace(db, { id: b.id }, null))?.workspace.slug ?? ''
    expect(await resolveWorkspaceBySlug(db, a.id, bSlug)).toBeNull()
    expect(await resolveWorkspaceBySlug(db, a.id, 'u-doesnotx')).toBeNull()
  })

  it('被移出的成员立即无法访问', async () => {
    const owner = await signUp('owner2')
    const u = await signUp('removed')
    const team = await createTeam(owner.id)
    await scoped(db, team.id).insert(member, { id: newId(), userId: u.id, role: 'member' })
    expect((await resolveWorkspaceBySlug(db, u.id, team.slug))?.member.role).toBe('member')

    await scoped(db, team.id).delete(member, eq(member.userId, u.id))
    expect(await resolveWorkspaceBySlug(db, u.id, team.slug)).toBeNull()
    expect((await resolveWorkspaceBySlug(db, owner.id, team.slug))?.member.role).toBe('owner')
  })

  it('已软删的空间对成员也不可访问', async () => {
    const owner = await signUp('owner3')
    const team = await createTeam(owner.id)
    await db.update(organization).set({ deletedAt: new Date() }).where(eq(organization.id, team.id))
    expect(await resolveWorkspaceBySlug(db, owner.id, team.slug)).toBeNull()
  })
})

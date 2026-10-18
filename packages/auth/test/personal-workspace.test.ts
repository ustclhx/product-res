import { env } from 'cloudflare:workers'
import { createDb } from '@product-res/db'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensurePersonalWorkspace,
  findPersonalWorkspace,
  PERSONAL_WORKSPACE_NAME,
  personalSlug,
} from '../src/index.ts'
import { cookieHeader, mockTurnstile, PASSWORD, setup, signUpBody, testUsers } from './helpers.ts'

// tasks.md 4.1：注册即创建个人空间（design.md 决策 4、5），钩子失败时可补建且补建幂等。

const users = testUsers('personal')
const SLUG_RE = /^u-[0-9a-z]{8}$/

beforeAll(() => users.start())
beforeEach(() => {
  mockTurnstile()
})
afterEach(() => {
  vi.restoreAllMocks()
})
afterAll(() => users.cleanup())

async function signUp(s: ReturnType<typeof setup>, name: string) {
  const address = users.email(name)
  const res = await s.post('/sign-up/email', signUpBody(address))
  expect(res.status).toBe(200)
  const body = (await res.json()) as { token: string; user: { id: string } }
  return { address, userId: body.user.id, token: body.token, cookie: cookieHeader(res) }
}

async function membersOf(s: ReturnType<typeof setup>, organizationId: string) {
  return s.db.query.member.findMany({ where: (m, { eq }) => eq(m.organizationId, organizationId) })
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * 注册一个「个人空间钩子失败」的用户：让随机数始终生成与已有空间相同的 slug，
 * 钩子重试用尽后放弃（只记日志），注册本身仍成功。
 */
async function signUpWithFailedHook(s: ReturnType<typeof setup>, name: string) {
  const existing = await signUp(s, `${name}-seed`)
  const taken = (await findPersonalWorkspace(s.db, existing.userId))?.slug ?? ''
  const bytes = [...taken.slice(2)].map((c) => BASE36.indexOf(c))
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
    array.set(bytes.slice(0, array.length))
    return array
  }) as typeof crypto.getRandomValues)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const u = await signUp(s, name)
    expect(random).toHaveBeenCalled()
    expect(error.mock.calls.flat().join(' ')).toContain('personal_workspace.create_failed')
    return { ...u, taken }
  } finally {
    random.mockRestore()
    error.mockRestore()
  }
}

describe('personalSlug', () => {
  it('为 u- 加 8 位 base36', () => {
    const slugs = new Set(Array.from({ length: 200 }, personalSlug))
    for (const slug of slugs) expect(slug).toMatch(SLUG_RE)
    expect(slugs.size).toBe(200)
  })
})

describe('注册即创建个人空间', () => {
  it('新用户拥有个人空间，角色为 owner，注册返回的会话以它为活跃空间', async () => {
    const s = setup()
    const u = await signUp(s, 'new')

    const workspace = await findPersonalWorkspace(s.db, u.userId)
    expect(workspace).toMatchObject({
      id: u.userId,
      name: PERSONAL_WORKSPACE_NAME,
      isPersonal: true,
      deletedAt: null,
    })
    expect(workspace?.slug).toMatch(SLUG_RE)
    const members = await membersOf(s, u.userId)
    expect(members).toEqual([expect.objectContaining({ userId: u.userId, role: 'owner' })])

    const session = await s.db.query.session.findFirst({
      where: (t, { eq }) => eq(t.token, u.token),
    })
    expect(session?.activeOrganizationId).toBe(u.userId)
  })

  it('之后登录产生的新会话同样以个人空间为活跃空间', async () => {
    const s = setup()
    const u = await signUp(s, 'signin')
    const res = await s.post('/sign-in/email', { email: u.address, password: PASSWORD })
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    const session = await s.db.query.session.findFirst({ where: (t, { eq }) => eq(t.token, token) })
    expect(session?.activeOrganizationId).toBe(u.userId)
  })

  it('slug 冲突时重试；钩子最终失败不影响注册，之后可补建', async () => {
    const s = setup()
    const u = await signUpWithFailedHook(s, 'collide')
    expect(await findPersonalWorkspace(s.db, u.userId)).toBeUndefined()
    const session = await s.db.query.session.findFirst({
      where: (t, { eq }) => eq(t.token, u.token),
    })
    expect(session?.activeOrganizationId).toBeNull()

    const repaired = await ensurePersonalWorkspace(s.db, { id: u.userId })
    expect(repaired).toMatchObject({ id: u.userId, isPersonal: true, deletedAt: null })
    expect(repaired.slug).toMatch(SLUG_RE)
    expect(repaired.slug).not.toBe(u.taken)
    expect(await membersOf(s, u.userId)).toEqual([
      expect.objectContaining({ userId: u.userId, role: 'owner' }),
    ])
  })

  it('并发补建只产生一个个人空间与一条 owner 成员行', async () => {
    const s = setup()
    const u = await signUpWithFailedHook(s, 'concurrent')

    // 每个调用用独立的连接，模拟多个请求同时补建
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensurePersonalWorkspace(createDb(env.HYPERDRIVE), { id: u.userId }),
      ),
    )
    expect(new Set(results.map((w) => w.slug)).size).toBe(1)
    expect(await membersOf(s, u.userId)).toHaveLength(1)

    // 已存在时再调用不改动
    const again = await ensurePersonalWorkspace(s.db, { id: u.userId })
    expect(again.slug).toBe(results[0]?.slug)
    expect(await membersOf(s, u.userId)).toHaveLength(1)
  })
})

it('does not repair membership or create a personal workspace for a deleted account', async () => {
  const s = setup()
  const u = await signUp(s, 'deleted')
  await s.db.$client`update organization set deleted_at=now() where id=${u.userId}`
  await s.db.$client`delete from member where organization_id=${u.userId}`
  const existing = await ensurePersonalWorkspace(s.db, { id: u.userId })
  expect(existing.deletedAt).not.toBeNull()
  expect(await membersOf(s, u.userId)).toHaveLength(0)
  await s.db.$client`update "user" set banned=true,ban_expires=null where id=${u.userId}`
  await expect(ensurePersonalWorkspace(s.db, { id: u.userId })).rejects.toMatchObject({
    code: 'USER_BANNED',
  })
  expect(await membersOf(s, u.userId)).toHaveLength(0)
})

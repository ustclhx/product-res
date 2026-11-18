import {
  creditDailyClaim,
  creditGrant,
  creditLedger,
  member,
  organization,
  setting,
  user,
} from '@product-res/db'
import { newId, SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, expect, it, vi } from 'vitest'
import type { DailyCreditsCheck } from '../src/features/credits/daily.server.ts'
import { adminCache, createAdminTestDb } from './admin-test-resources.ts'

// 只替换 Server Function 传输与会话环境，保留 handler、每日领取和账本事务。
const freshSession = vi.hoisted(() => vi.fn())
vi.mock('@product-res/auth', () => ({ requireFreshSession: freshSession }))
vi.mock('@tanstack/react-start', () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    }
    return builder
  },
}))
vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://app.test/app/team'),
}))
vi.mock('../src/server/middleware.ts', () => ({ withWorkspace: {}, withWorkspaceMembership: {} }))
vi.mock('../src/server/runtime.ts', () => ({
  getWebRuntime: () => ({ auth: {}, cache: adminCache }),
}))
vi.mock('../src/server/template-config.ts', () => ({
  templateConfig: {
    // 准入门槛（add-beta-access-gate）由 middleware.activation.test.ts 覆盖，此处关闭以只验证每日领取
    credits: { enabled: true, dailyEnabled: true, requireGrantForAccess: false },
    tenancy: { multiTenant: true },
    billing: { enabled: false },
  },
}))

import { getWorkspacePage } from '../src/features/workspace/workspace.functions.ts'

const db = createAdminTestDb()
afterAll(() => db.$client.end())

it('从团队空间访问 App 时，每日领取只记入该用户的个人空间账本', async () => {
  const userId = newId()
  const teamId = newId()
  const workspaceIds = [userId, teamId]
  const settings = [
    { key: 'credits.dailyAmount', value: 10 },
    { key: 'credits.dailyMaxDaysPerMonth', value: 10 },
    { key: 'credits.dailyExpiryDays', value: 7 },
    { key: 'credits.dailyRequireVerifiedEmail', value: true },
    { key: SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY, value: [] },
  ]
  const keys = settings.map(({ key }) => key)
  const originalSettings = await db.select().from(setting).where(inArray(setting.key, keys))
  try {
    for (const entry of settings) {
      await db
        .insert(setting)
        .values(entry)
        .onConflictDoUpdate({ target: setting.key, set: { value: entry.value } })
    }
    const [account] = await db
      .insert(user)
      .values({
        id: userId,
        name: 'Daily team member',
        email: `${userId}@daily-workspace.test`,
        emailVerified: true,
      })
      .returning()
    const spaces = await db
      .insert(organization)
      .values([
        { id: userId, name: 'Personal', slug: userId, isPersonal: true },
        { id: teamId, name: 'Team', slug: teamId, isPersonal: false },
      ])
      .returning()
    const memberships = await db
      .insert(member)
      .values(
        workspaceIds.map((id) => ({ id: newId(), organizationId: id, userId, role: 'owner' })),
      )
      .returning()
    const workspace = spaces.find(({ id }) => id === teamId)
    const membership = memberships.find(({ organizationId }) => organizationId === teamId)
    freshSession.mockResolvedValue({
      user: account,
      session: { activeOrganizationId: teamId, impersonatedBy: null },
    })
    const context = {
      db,
      workspace,
      member: membership,
      workspaceReadOnly: false,
      workspaceTeamReadOnly: false,
      workspaceTransferring: false,
    }
    const result = await (
      getWorkspacePage as unknown as (input: { context: typeof context }) => Promise<{
        workspace: { id: string; isPersonal: boolean }
        dailyCredits: DailyCreditsCheck | null
      }>
    )({ context })

    expect(result.workspace).toMatchObject({ id: teamId, isPersonal: false })
    expect(result.dailyCredits).toMatchObject({ status: 'granted', credits: 10 })
    if (result.dailyCredits?.status !== 'granted') throw new Error('Missing daily grant')
    const { grantId, day } = result.dailyCredits
    const grants = await db
      .select()
      .from(creditGrant)
      .where(inArray(creditGrant.workspaceId, workspaceIds))
    expect(grants).toEqual([
      expect.objectContaining({
        id: grantId,
        workspaceId: userId,
        source: 'daily',
        sourceRef: `${userId}:${day}`,
        amount: 10,
      }),
    ])
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(inArray(creditLedger.workspaceId, workspaceIds))
    expect(ledger).toEqual([
      expect.objectContaining({ workspaceId: userId, grantId, type: 'grant', delta: 10 }),
    ])
    expect(
      await db.select().from(creditDailyClaim).where(eq(creditDailyClaim.userId, userId)),
    ).toEqual([expect.objectContaining({ userId, grantId, day })])
  } finally {
    await db.delete(creditDailyClaim).where(eq(creditDailyClaim.userId, userId))
    await db.delete(creditLedger).where(inArray(creditLedger.workspaceId, workspaceIds))
    await db.delete(creditGrant).where(inArray(creditGrant.workspaceId, workspaceIds))
    await db.delete(member).where(inArray(member.organizationId, workspaceIds))
    await db.delete(organization).where(inArray(organization.id, workspaceIds))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(setting).where(inArray(setting.key, keys))
    if (originalSettings.length) await db.insert(setting).values(originalSettings)
  }
})

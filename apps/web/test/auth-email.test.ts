import { env } from 'cloudflare:workers'
import { createAuth } from '@product-res/auth'
import { defineTemplateConfig } from '@product-res/config'
import { createDb } from '@product-res/db'
import { renderEmail } from '@product-res/email'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@product-res/email/queue'
import { newId } from '@product-res/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createQueueAuthEmailSender, userLocaleByEmail } from '../src/server/auth-email.ts'

// tasks.md 3.2：认证邮件只入队，用户请求不受邮件服务影响（specs/user-auth「邮件服务暂时不可用」）。
// 在 workerd 中经 Hyperdrive 连接本地 PG；Resend 由 mock fetch 模拟为 503，不访问任何外部服务。
// 消息在队列中的重试与最终发送见 apps/jobs/test/email-queue.test.ts。

const APP_URL = 'http://localhost:3000'
const testEnv = {
  BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  APP_URL,
}
const EMAIL_DOMAIN = `${newId()}.web-email-test.example`
const createdOrgs: string[] = []

function setup() {
  const db = createDb(env.HYPERDRIVE)
  const queued: EmailQueueMessage[] = []
  const auth = createAuth(testEnv, db, {
    config: defineTemplateConfig({
      app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      // 本测试只验证邮件入队；Turnstile 与限流由 packages/auth 的 protection 测试覆盖
      auth: { oauth: [], turnstile: false },
      tenancy: { multiTenant: true },
    }),
    sendEmail: createQueueAuthEmailSender({
      queue: {
        send: async (body) => {
          queued.push(body)
        },
      },
      appName: 'TestApp',
      appUrl: APP_URL,
      resolveLocale: userLocaleByEmail(db),
    }),
  })
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL, ...headers },
        body: JSON.stringify(body),
      }),
    )
  return { db, queued, post }
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  const sql = createDb(env.HYPERDRIVE).$client
  const users = await sql<
    { id: string }[]
  >`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  const ids = users.map((u) => u.id)
  await sql`delete from verification where identifier like ${`%@${EMAIL_DOMAIN}%`} or value like ${`%@${EMAIL_DOMAIN}%`}`
  if (ids.length) await sql`delete from verification where value in ${sql(ids)}`
  if (ids.length === 0) return
  await sql`delete from session where user_id in ${sql(ids)}`
  // 只清理本套件创建的个人空间和团队空间
  const orgs = [...ids, ...createdOrgs]
  // 成员审计只追加，测试夹具由 migrator 清理审计外键。
  await createDb(env.HYPERDRIVE_MIGRATOR)
    .$client`delete from audit_log where actor_user_id in ${sql(ids)} or workspace_id in ${sql(orgs)}`
  await sql`delete from invitation where organization_id in ${sql(orgs)} or inviter_id in ${sql(ids)}`
  await sql`delete from member where organization_id in ${sql(orgs)} or user_id in ${sql(ids)}`
  await sql`delete from organization where id in ${sql(orgs)}`
  await sql`delete from account where user_id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('认证邮件入队', () => {
  it('Resend 返回 5xx 时找回密码请求仍成功，邮件以收件人语言入队', async () => {
    const resend = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"name":"internal_server_error"}', { status: 503 }))
    const { db, queued, post } = setup()
    const address = `reset-${newId()}@${EMAIL_DOMAIN}`
    const signUp = await post('/sign-up/email', {
      email: address,
      password: 'correct-horse-battery-staple',
      name: 'Test User',
    })
    expect(signUp.status).toBe(200)
    await db.$client`update "user" set locale = 'zh-CN' where email = ${address}`
    queued.length = 0

    const res = await post('/request-password-reset', { email: address, redirectTo: '/reset' })

    expect(res.status).toBe(200)
    expect(resend).not.toHaveBeenCalled()
    expect(queued).toHaveLength(1)
    const [message] = queued
    expect(parseEmailQueueMessage(message)).toEqual(message)
    expect(message).toMatchObject({
      template: 'reset-password',
      to: address,
      locale: 'zh-CN',
      appName: 'TestApp',
      props: { url: expect.stringContaining(`${APP_URL}/api/auth/reset-password/`) },
    })
    if (message?.template !== 'reset-password') throw new Error('Reset email missing')
    const rendered = await renderEmail(message.template, message.props, {
      locale: message.locale,
      appName: message.appName,
    })
    expect(rendered.locale).toBe('zh')
    expect(rendered.subject).toBe('重置你的 TestApp 密码')
    expect(rendered.html).toContain('重置密码')
    expect(rendered.text).toContain('链接 60 分钟内有效')
  })

  it('owner 邀请经真实认证端点入队，链接与七天有效期一致', async () => {
    const { db, queued, post } = setup()
    const signUp = await post('/sign-up/email', {
      email: `owner-${newId()}@${EMAIL_DOMAIN}`,
      password: 'correct-horse-battery-staple',
      name: 'Owner',
    })
    expect(signUp.status).toBe(200)
    const cookie = signUp.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const created = await post(
      '/organization/create',
      { name: 'Team', slug: `email-${newId()}` },
      { cookie },
    )
    expect(created.status).toBe(200)
    const { id: organizationId } = (await created.json()) as { id: string }
    createdOrgs.push(organizationId)
    queued.length = 0
    const address = `guest-${newId()}@${EMAIL_DOMAIN}`
    const before = Date.now()
    const response = await post(
      '/organization/invite-member',
      { organizationId, email: address, role: 'owner' },
      { cookie },
    )
    const after = Date.now()
    expect(response.status).toBe(200)
    const { id } = (await response.json()) as { id: string }
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(queued).toHaveLength(1)
    const [message] = queued
    expect(parseEmailQueueMessage(message)).toEqual(message)
    expect(message).toMatchObject({
      template: 'workspace-invitation',
      to: address,
      props: { role: 'owner', expiresInDays: 7 },
    })
    if (message?.template !== 'workspace-invitation') throw new Error('Invitation email missing')
    const url = new URL(message.props.url)
    expect(url.origin).toBe(APP_URL)
    expect(url.pathname).toBe('/accept-invitation')
    expect([...url.searchParams]).toEqual([['id', id]])
    const invitation = await db.query.invitation.findFirst({ where: (i, { eq }) => eq(i.id, id) })
    expect(invitation).toMatchObject({ role: 'owner', organizationId, email: address })
    const expiry = invitation?.expiresAt.getTime() ?? 0
    const lifetime = message.props.expiresInDays * 86400000
    expect(expiry).toBeGreaterThanOrEqual(before + lifetime)
    expect(expiry).toBeLessThanOrEqual(after + lifetime)
  })

  it('未注册的收件人语言为 null', async () => {
    const { db } = setup()
    expect(await userLocaleByEmail(db)(`nobody-${newId()}@${EMAIL_DOMAIN}`)).toBeNull()
  })
})

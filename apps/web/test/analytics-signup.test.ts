import { user, userAttribution } from '@product-res/db'
import { newId } from '@product-res/shared'
import { captureFirstTouch, encodeFirstTouch } from '@product-res/shared/analytics'
import { eq } from 'drizzle-orm'
import { afterAll, expect, it, vi } from 'vitest'
import { createSignUpRecorder } from '../src/features/analytics/server.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

// add-plausible-multi-site 3.2：注册域名写入真实表结构，并随 sign_up 消息传给 jobs。
const db = createAdminTestDb()
afterAll(() => db.$client.end())

async function newUser() {
  const id = newId()
  await db.insert(user).values({ id, name: 'Signup', email: `${id}@signup-host.example.test` })
  return id
}

it('有首触 Cookie 时写入规范化的 signup_host，sign_up 带同一 host', async () => {
  const id = await newUser()
  const send = vi.fn(async () => {})
  const touch = captureFirstTouch({ url: new URL('https://arcanumber.com/?utm_source=chatgpt') })
  await createSignUpRecorder({ db, queue: { send } })(
    { id },
    new Headers({ host: 'WWW.Arcanumber.com:443', cookie: `product_res_ft=${encodeFirstTouch(touch)}` }),
  )
  const [row] = await db
    .select({ signupHost: userAttribution.signupHost, source: userAttribution.source })
    .from(userAttribution)
    .where(eq(userAttribution.userId, id))
  expect(row).toEqual({ signupHost: 'arcanumber.com', source: 'chatgpt' })
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      analytics: { event: 'sign_up', userId: id, host: 'arcanumber.com' },
    }),
  )
})

it('没有首触 Cookie 时不写归因行，sign_up 仍带 host', async () => {
  const id = await newUser()
  const send = vi.fn(async () => {})
  await createSignUpRecorder({ db, queue: { send } })({ id }, new Headers({ host: 'ganjiday.com' }))
  expect(
    await db.select().from(userAttribution).where(eq(userAttribution.userId, id)),
  ).toHaveLength(0)
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ analytics: { event: 'sign_up', userId: id, host: 'ganjiday.com' } }),
  )
})

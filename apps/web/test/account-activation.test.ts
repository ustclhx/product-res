import { env } from 'cloudflare:workers'
import { grant } from '@product-res/credits'
import { createDb, organization } from '@product-res/db'
import { newId } from '@product-res/shared'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_NOT_ACTIVATED,
  assertAccountActivated,
  isAccountActivated,
} from '../src/server/account-activation.ts'

// add-beta-access-gate 2.3：开通条件以真实账本判断（本地 PG 经 Hyperdrive）。
const db = createDb(env.HYPERDRIVE)
const gated = { credits: { enabled: true, requireGrantForAccess: true } }
const member = { role: 'user' }

async function workspace() {
  const id = newId()
  await db.insert(organization).values({ id, name: 'Beta', slug: `beta-${id}`, isPersonal: true })
  return id
}

describe('内测准入：管理员发放积分开通工作台', () => {
  it('未开通返回 403，非管理员来源的积分不算开通，管理员发放后放行', async () => {
    const id = await workspace()
    await expect(assertAccountActivated(db, member, id, gated)).rejects.toMatchObject({
      code: ACCOUNT_NOT_ACTIVATED,
      status: 403,
    })
    await grant(db, { workspaceId: id, source: 'promo', sourceRef: newId(), amount: 10 })
    expect(await isAccountActivated(db, member, id, gated)).toBe(false)
    await grant(db, { workspaceId: id, source: 'admin', sourceRef: newId(), amount: 10 })
    await expect(assertAccountActivated(db, member, id, gated)).resolves.toBeUndefined()
  })

  it('平台 admin（含逗号多角色）始终放行；开关关闭或积分关闭时不检查', async () => {
    const id = await workspace()
    expect(await isAccountActivated(db, { role: 'user, admin' }, id, gated)).toBe(true)
    expect(await isAccountActivated(db, { role: null }, id, gated)).toBe(false)
    expect(
      await isAccountActivated(db, member, id, {
        credits: { enabled: true, requireGrantForAccess: false },
      }),
    ).toBe(true)
    expect(
      await isAccountActivated(db, member, id, {
        credits: { enabled: false, requireGrantForAccess: true },
      }),
    ).toBe(true)
  })
})

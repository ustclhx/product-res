import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  template: { billing: { enabled: true, pastDueGraceDays: 7 } },
}))
vi.mock('./template-config.ts', () => ({ templateConfig: mocks.template }))

import { resolveWorkspaceMaxSeats, resolveWorkspacePlan } from './workspace-data.ts'

const free = { key: 'free', sort: 0, features: { maxSeats: 1 } }
const pro = { key: 'pro', sort: 10, features: { maxSeats: 5 } }

function sqlReturning(subscriptions: unknown[]) {
  const unsafe = vi.fn().mockResolvedValueOnce(subscriptions).mockResolvedValueOnce([free])
  return { unsafe } as unknown as Parameters<typeof resolveWorkspacePlan>[1]
}

beforeEach(() => {
  mocks.template.billing.enabled = true
})

describe('resolveWorkspacePlan', () => {
  it('没有生效订阅时为 free 套餐与其席位上限', async () => {
    await expect(resolveWorkspacePlan('w', sqlReturning([]))).resolves.toEqual({
      planKey: 'free',
      maxSeats: 1,
    })
  })

  it('同一次查询返回生效订阅的套餐与席位上限；席位解析与之一致', async () => {
    const active = {
      status: 'active',
      pastDueSince: null,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      plan: pro,
    }
    await expect(resolveWorkspacePlan('w', sqlReturning([active]))).resolves.toEqual({
      planKey: 'pro',
      maxSeats: 5,
    })
    await expect(resolveWorkspaceMaxSeats('w', sqlReturning([active]))).resolves.toBe(5)
  })

  it('未开启计费时不读套餐表，都为 null', async () => {
    mocks.template.billing.enabled = false
    const sql = { unsafe: vi.fn() } as unknown as Parameters<typeof resolveWorkspacePlan>[1]
    await expect(resolveWorkspacePlan('w', sql)).resolves.toEqual({ planKey: null, maxSeats: null })
  })
})

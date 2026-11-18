import { describe, expect, it } from 'vitest'
import { showUpgradeEntry } from './upgrade.ts'

const base = { billingEnabled: true, planKey: 'free', role: 'owner', readOnly: false }

describe('showUpgradeEntry', () => {
  it('免费套餐的所有者与管理员显示升级入口', () => {
    expect(showUpgradeEntry(base)).toBe(true)
    expect(showUpgradeEntry({ ...base, role: 'admin' })).toBe(true)
  })

  it('已订阅、普通成员、只读空间或未开启计费时不显示', () => {
    expect(showUpgradeEntry({ ...base, planKey: 'pro' })).toBe(false)
    expect(showUpgradeEntry({ ...base, role: 'member' })).toBe(false)
    expect(showUpgradeEntry({ ...base, readOnly: true })).toBe(false)
    expect(showUpgradeEntry({ ...base, billingEnabled: false, planKey: null })).toBe(false)
  })
})

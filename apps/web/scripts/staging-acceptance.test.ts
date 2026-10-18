import type { Page } from '@playwright/test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adminIdentity,
  checkUserReadiness,
  ensureAcceptanceCredits,
  ensureRegisteredAccount,
  sessionUser,
} from '../e2e/staging-acceptance/accounts.ts'
import AcceptanceReporter from '../e2e/staging-acceptance/reporter.ts'

function registrationPage() {
  const fill = vi.fn().mockResolvedValue(undefined)
  const click = vi.fn().mockResolvedValue(undefined)
  const form = { getByLabel: () => ({ fill }), getByRole: () => ({ click }) }
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    getByRole: () => form,
    waitForURL: vi.fn().mockResolvedValue(undefined),
  }
  return { page: page as unknown as Page, goto: page.goto, click }
}

afterEach(() => vi.unstubAllEnvs())

describe('验收账号注册', () => {
  it('首次通过正常页面注册，重跑复用只读查到的账号', async () => {
    vi.stubEnv('STAGING_ACCEPTANCE_LOCAL', '')
    const { page, goto, click } = registrationPage()
    let saved: { id: string } | undefined
    click.mockImplementation(async () => {
      saved = { id: 'fixture-id' }
    })
    const read = vi.fn(async () => saved)
    const first = await ensureRegisteredAccount(
      page,
      read,
      'fixture@example.com',
      'fixture-password',
      'Fixture',
    )
    const second = await ensureRegisteredAccount(
      page,
      read,
      'fixture@example.com',
      'fixture-password',
      'Fixture',
    )
    expect(first).toEqual({ account: saved, registered: true })
    expect(second).toEqual({ account: saved, registered: false })
    expect(goto).toHaveBeenCalledExactlyOnceWith('/register')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('已有账号不打开注册页面', async () => {
    const { page, goto } = registrationPage()
    expect(
      await ensureRegisteredAccount(
        page,
        async () => ({ id: 'existing' }),
        'fixture@example.com',
        'fixture-password',
        'Fixture',
      ),
    ).toEqual({ account: { id: 'existing' }, registered: false })
    expect(goto).not.toHaveBeenCalled()
  })

  it('注册失败向上报告，不能当成账号已存在', async () => {
    vi.stubEnv('STAGING_ACCEPTANCE_LOCAL', '')
    const { page, click } = registrationPage()
    click.mockRejectedValue(new Error('Signup disabled'))
    await expect(
      ensureRegisteredAccount(
        page,
        async () => undefined,
        'fixture@example.com',
        'fixture-password',
        'Fixture',
      ),
    ).rejects.toThrow('Signup disabled')
  })
})

describe('当前管理员身份', () => {
  const admin = { id: 'admin-id', email: 'owner@example.com', role: 'user, admin' }

  it('使用当前会话身份并检查专用用户邮箱与 ID', () => {
    expect(adminIdentity(admin, 'fixture@example.com', 'fixture-id')).toBe(admin)
    expect(() => adminIdentity(admin, ' Owner@Example.com ')).toThrow('必须与当前管理员不同')
    expect(() => adminIdentity(admin, 'fixture@example.com', admin.id)).toThrow(
      '必须与当前管理员不同',
    )
  })

  it('拒绝非管理员，不能将名字相近的角色当成 admin', () => {
    expect(() => adminIdentity({ ...admin, role: 'superadmin' })).toThrow('不是平台管理员')
  })

  it('模拟登录不能充当真实管理员会话', async () => {
    const page = {
      request: {
        get: async () => ({
          ok: () => true,
          json: async () => ({ user: admin, session: { impersonatedBy: 'another-admin' } }),
        }),
      },
    } as unknown as Page
    await expect(sessionUser(page)).rejects.toThrow('退出模拟登录')
  })
})

it('普通用户缺失准备项时列出全部手动操作；通配权限和临界余额可通过', () => {
  expect(() => checkUserReadiness('user-id', 'space-id', ['one'], ['one', 'two'], 0, 2)).toThrow(
    'features.models 权限：two\n需要管理员在 /admin 为 user-id 的空间 space-id 调整可用积分 ≥ 30（当前 0）\n需要管理员在 /admin 为 user-id 的空间 space-id 清偿积分欠费（当前 2）',
  )
  expect(() =>
    checkUserReadiness('user-id', 'space-id', ['*'], ['one', 'two'], 30, 0),
  ).not.toThrow()
})

it('reporter 显示人工登录与准备指引，隐藏通用认证诊断', () => {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    const reporter = new AcceptanceReporter()
    const prompt = '请在弹出的浏览器中登录管理员账号（可使用 Google，等待时间 5 分钟）\n'
    reporter.onStdOut(Buffer.from(prompt))
    reporter.onStdOut('private-auth-diagnostics')
    reporter.onError({ message: 'Error: [验收准备] 管理员登录需要 headed 模式' })
    reporter.onError({ message: 'private-auth-diagnostics' })
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('')
    expect(output).toContain(prompt)
    expect(output).toContain('[验收准备] 管理员登录需要 headed 模式')
    expect(output).not.toContain('private-auth-diagnostics')
  } finally {
    write.mockRestore()
  }
})

it('普通用户只补缺额，同一 runId 有审计后不重复补发，即使余额再次下降', async () => {
  const adjustments: { id: string }[] = []
  const amounts: string[] = []
  const reasons: string[] = []
  const click = vi.fn(async () => {
    adjustments.push({ id: 'audit-id' })
  })
  const page = {
    getByLabel: (name: string) => ({
      fill: async (value: string) => {
        if (name === 'Amount') amounts.push(value)
        else reasons.push(value)
      },
    }),
    getByRole: () => ({ isEnabled: async () => true, click }),
  } as unknown as Page
  const reason = 'staging acceptance test credits fixed-run'
  await ensureAcceptanceCredits(page, async () => adjustments, 12, reason)
  await ensureAcceptanceCredits(page, async () => adjustments, 0, reason)
  expect(amounts).toContain('18')
  expect(reasons).toContain(reason)
  expect(click).toHaveBeenCalledTimes(1)
})

it('已有足够积分时不提交后台调整', async () => {
  const page = {} as Page
  await expect(
    ensureAcceptanceCredits(page, async () => [], 30, 'staging acceptance test credits fixed-run'),
  ).resolves.toBeUndefined()
})

import { expect, type Page } from '@playwright/test'
import { stubTurnstile } from '../turnstile.ts'

export const HUMAN_LOGIN_TIMEOUT = 5 * 60_000
export const guidancePrefix = '[验收准备] '

export type SessionUser = { id: string; email: string; role?: string }

export async function sessionUser(page: Page): Promise<SessionUser> {
  const response = await page.request.get('/api/auth/get-session')
  if (!response.ok()) throw new Error(`${guidancePrefix}无法读取当前登录会话，请重新登录`)
  const data = await response.json()
  if (
    !data?.user ||
    typeof data.user.id !== 'string' ||
    typeof data.user.email !== 'string' ||
    data.session?.impersonatedBy
  )
    throw new Error(`${guidancePrefix}需要真实用户会话，请退出模拟登录后重新登录`)
  return data.user
}

export function adminIdentity(user: SessionUser, dedicatedEmail?: string, targetId?: string) {
  if (
    !user.role
      ?.split(',')
      .map((role) => role.trim())
      .includes('admin')
  )
    throw new Error(`${guidancePrefix}当前账号不是平台管理员，请使用有 /admin 权限的账号登录`)
  if (
    (dedicatedEmail && user.email.trim().toLowerCase() === dedicatedEmail.trim().toLowerCase()) ||
    (targetId && targetId === user.id)
  )
    throw new Error(`${guidancePrefix}专用测试用户必须与当前管理员不同`)
  return user
}

export async function registerAccount(page: Page, email: string, password: string, name: string) {
  const local = process.env.STAGING_ACCEPTANCE_LOCAL === '1'
  if (local) {
    await page
      .context()
      .setExtraHTTPHeaders({ 'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}` })
    await stubTurnstile(page)
  }
  const timeout = local ? 20_000 : HUMAN_LOGIN_TIMEOUT
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Email', { exact: true }).fill(email)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByRole('button', { name: 'Create account', exact: true }).click({ timeout })
  await page.waitForURL(/\/app\/[^/?#]+\/?$/, { timeout })
}

// 两类测试账号共用只读存在性检查；注册成功但后续失败时，重跑也不会再次注册。
export async function ensureRegisteredAccount<T extends { id: string }>(
  page: Page,
  readAccount: () => Promise<T | undefined>,
  email: string,
  password: string,
  name: string,
): Promise<{ account: T; registered: boolean }> {
  const existing = await readAccount()
  if (existing) return { account: existing, registered: false }
  await registerAccount(page, email, password, name)
  const account = await readAccount()
  if (!account) throw new Error(`${guidancePrefix}注册后未找到测试账号，请核对注册状态后重跑`)
  return { account, registered: true }
}

export function checkUserReadiness(
  userId: string,
  workspaceId: string,
  models: readonly string[],
  requiredModels: readonly string[],
  balance: number | undefined,
  debt: number,
) {
  const missing = models.includes('*') ? [] : requiredModels.filter((key) => !models.includes(key))
  const steps = []
  if (missing.length)
    steps.push(
      `需要管理员在 /admin 为 ${userId} 的空间 ${workspaceId} 准备套餐 features.models 权限：${missing.join(', ')}`,
    )
  if (balance !== undefined && balance < 30)
    steps.push(
      `需要管理员在 /admin 为 ${userId} 的空间 ${workspaceId} 调整可用积分 ≥ 30（当前 ${balance}）`,
    )
  if (debt > 0)
    steps.push(
      `需要管理员在 /admin 为 ${userId} 的空间 ${workspaceId} 清偿积分欠费（当前 ${debt}）`,
    )
  if (steps.length) throw new Error(`${guidancePrefix}${steps.join('\n')}`)
}

// 只通过已有后台 UI 发放；先查审计再提交，同一空间/runId 重跑不会生成新的调整。
export async function ensureAcceptanceCredits(
  page: Page,
  readAdjustments: () => Promise<{ id: string }[]>,
  balance: number,
  reason: string,
) {
  const existing = await readAdjustments()
  if (existing.length > 1)
    throw new Error(`${guidancePrefix}同一 runId 存在重复测试积分审计，请管理员核对后再运行`)
  if (balance >= 30 || existing.length === 1) return
  const amount = 30 - balance
  try {
    await expect
      .poll(async () => {
        await page.getByLabel('Amount', { exact: true }).fill('')
        await page.getByLabel('Amount', { exact: true }).fill(String(amount))
        await page.getByLabel('Reason', { exact: true }).fill('')
        await page.getByLabel('Reason', { exact: true }).fill(reason)
        return page.getByRole('button', { name: 'Add credits', exact: true }).isEnabled()
      })
      .toBe(true)
    await page.getByRole('button', { name: 'Add credits', exact: true }).click()
    await expect.poll(async () => (await readAdjustments()).length).toBe(1)
  } catch {
    // 提交响应不确定时不再次点击；重跑先从只读审计恢复。
    throw new Error(
      `${guidancePrefix}测试积分补发未确认，请管理员核对调整审计后重跑同一 runId；不要盲目再次发放`,
    )
  }
}

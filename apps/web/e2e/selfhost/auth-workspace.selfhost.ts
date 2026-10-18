import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import { promisify } from 'node:util'
import { expect, type Page, test } from '@playwright/test'

const runFile = promisify(execFile)
const PASSWORD = 'correct-horse-battery'
const copy =
  process.env.SELFHOST_LOCALE === 'zh'
    ? {
        registerForm: '创建账号',
        name: '姓名',
        email: '邮箱',
        password: '密码',
        createAccount: '创建账号',
        signInForm: '使用密码登录',
        signIn: '登录',
        verificationSent: (email: string) => `已向 ${email} 发送验证链接，请先验证邮箱再登录。`,
        emailVerified: '邮箱已验证',
        continue: '继续',
        emailNotVerified: '请先验证邮箱，我们已向你发送新的验证链接。',
        personal: '个人空间',
        team: '团队空间',
        owner: '你的角色：owner',
        settings: '空间设置',
      }
    : {
        registerForm: 'Create an account',
        name: 'Name',
        email: 'Email',
        password: 'Password',
        createAccount: 'Create account',
        signInForm: 'Sign in with password',
        signIn: 'Sign in',
        verificationSent: (email: string) =>
          `We sent a verification link to ${email}. Verify your email address, then sign in.`,
        emailVerified: 'Email verified',
        continue: 'Continue',
        emailNotVerified:
          'Please verify your email address first. We have sent you a new verification link.',
        personal: 'Personal workspace',
        team: 'Team workspace',
        owner: 'Your role: owner',
        settings: 'Workspace settings',
      }
const PERSONAL_URL = /\/app\/u-[a-z0-9]+\/?$/

interface CapturedEmail {
  id: string
  to: string[]
  html: string
  text: string
}

async function capturedEmails(email: string): Promise<CapturedEmail[]> {
  const files = process.env.SELFHOST_COMPOSE_FILE?.split(delimiter).filter(Boolean)
  if (!files?.length) throw new Error('SELFHOST_COMPOSE_FILE is required for Compose acceptance')
  const script = `
    const url = new URL('http://capture:8025/emails')
    url.searchParams.set('to', process.argv[1])
    const response = await fetch(url)
    if (!response.ok) process.exit(1)
    process.stdout.write(JSON.stringify(await response.json()))
  `
  try {
    // execFile 缓冲 stdout，不将带验证链接的邮件输出到终端或测试附件。
    const { stdout } = await runFile(
      'docker',
      [
        'compose',
        ...files.flatMap((file) => ['-f', file]),
        'exec',
        '-T',
        'capture',
        'node',
        '--input-type=module',
        '-e',
        script,
        email,
      ],
      { env: process.env, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    )
    return JSON.parse(stdout) as CapturedEmail[]
  } catch {
    throw new Error('Could not read delivered email from the internal Compose capture service')
  }
}

async function verificationLink(email: string, baseURL: string) {
  let link = ''
  await expect
    .poll(
      async () => {
        const messages = await capturedEmails(email)
        for (const message of messages.toReversed()) {
          // 只接受原 sender 已渲染到邮件中的本站验证链接，不能读数据库或自行生成 token。
          const candidates =
            `${message.html}\n${message.text}`.match(/https?:\/\/[^\s<>"']+/g) ?? []
          for (const candidate of candidates) {
            const url = new URL(candidate.replaceAll('&amp;', '&'))
            if (
              url.origin === new URL(baseURL).origin &&
              url.pathname === '/api/auth/verify-email' &&
              url.searchParams.has('token')
            ) {
              link = url.href
              return true
            }
          }
        }
        return false
      },
      { timeout: 60_000, intervals: [500, 1000, 2000], message: 'Verification email delivered' },
    )
    .toBe(true)
  return link
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  const form = page.getByRole('form', { name: copy.signInForm })
  await form.getByLabel(copy.email, { exact: true }).fill(email)
  await form.getByLabel(copy.password, { exact: true }).fill(PASSWORD)
  await form.getByRole('button', { name: copy.signIn, exact: true }).click()
}

async function sessionIdentity(page: Page) {
  return page.evaluate(async () => {
    // 与敏感鉴权守卫一样实时校验；旧签名 cookie 的缓存展示值不能代表有效会话。
    const response = await fetch('/api/auth/get-session?disableCookieCache=true')
    const result = await response.json()
    // 返回可断言的身份字段，不将 session token 带回测试 runner。
    return result?.user ? { email: result.user.email, verified: result.user.emailVerified } : null
  })
}

test('fresh Node Compose: delivered verification, sign-out, password login and team switching', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Selfhost acceptance requires a base URL')
  const key = randomUUID().slice(0, 8)
  const email = `selfhost-final-${key}@example.com`
  const name = 'Selfhost Owner'
  const teamName = `Selfhost Team ${key}`
  const slug = `selfhost-${key}`

  await page.goto('/register')
  const registration = page.getByRole('form', { name: copy.registerForm })
  await registration.getByLabel(copy.name, { exact: true }).fill(name)
  await registration.getByLabel(copy.email, { exact: true }).fill(email)
  await registration.getByLabel(copy.password, { exact: true }).fill(PASSWORD)
  const signUpResponse = page.waitForResponse('**/api/auth/sign-up/email')
  await registration.getByRole('button', { name: copy.createAccount, exact: true }).click()
  expect((await signUpResponse).status()).toBe(200)
  await expect(page.getByRole('status')).toHaveText(copy.verificationSent(email))
  expect(await sessionIdentity(page)).toBeNull()
  // 先取得注册邮件；未验证登录会另发一封回跳 /app 的邮件，不能混淆两个业务入口。
  const deliveredLink = await verificationLink(email, baseURL)

  const deniedLogin = page.waitForResponse('**/api/auth/sign-in/email')
  await signIn(page, email)
  expect((await deniedLogin).status()).toBe(403)
  await expect(page.getByRole('alert')).toHaveText(copy.emailNotVerified)
  expect(await sessionIdentity(page)).toBeNull()

  try {
    await page.goto(deliveredLink)
  } catch {
    // Playwright 的原始 navigation 错误可能含 token URL，不能输出它。
    throw new Error('Navigation to the delivered verification link failed')
  }
  // 验证失败可能仍停在含 token 的 API URL；断言只打印布尔结果。
  const verificationResult = new URL(page.url())
  expect(
    /^\/verify-email\/?$/.test(verificationResult.pathname) && !verificationResult.search,
  ).toBe(true)
  await expect(page.getByRole('heading', { name: copy.emailVerified, exact: true })).toBeVisible()
  await page.getByRole('link', { name: copy.continue, exact: true }).click()
  await expect(page).toHaveURL(PERSONAL_URL)
  const personalURL = page.url()
  await expect(page.getByTestId('current-user')).toHaveText(`${name} (${email})`)
  expect(await sessionIdentity(page)).toEqual({ email, verified: true })
  const oldCookies = await context.cookies()
  expect(oldCookies.some((cookie) => cookie.name.endsWith('session_token'))).toBe(true)

  await page.goto('/account')
  if (process.env.SELFHOST_I18N === 'false') {
    await expect(page.getByLabel(/^(Language|语言)$/)).toHaveCount(0)
    await expect(page.locator('html')).toHaveAttribute('lang', process.env.SELFHOST_LOCALE ?? 'en')
  }
  const signOutResponse = page.waitForResponse('**/api/auth/sign-out')
  await page.getByRole('button', { name: 'Sign out and sign in again', exact: true }).click()
  expect((await signOutResponse).status()).toBe(200)
  await expect(page).toHaveURL(/\/login\?redirect=%2Faccount$/)
  expect(await sessionIdentity(page)).toBeNull()
  expect((await context.cookies()).some((cookie) => cookie.name.endsWith('session_token'))).toBe(
    false,
  )

  const staleContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true })
  try {
    await staleContext.addCookies(oldCookies)
    const stalePage = await staleContext.newPage()
    await stalePage.goto(personalURL)
    await expect(stalePage).toHaveURL(/\/login(?:\?|$)/)
    expect(await sessionIdentity(stalePage)).toBeNull()
    await expect(stalePage.getByTestId('current-user')).toHaveCount(0)
  } finally {
    await staleContext.close()
  }

  const signInResponse = page.waitForResponse('**/api/auth/sign-in/email')
  await signIn(page, email)
  expect((await signInResponse).status()).toBe(200)
  await expect(page).toHaveURL(personalURL)
  if (process.env.SELFHOST_MARKETING === 'false') {
    await page.goto('/')
    await expect(page).toHaveURL(personalURL)
  }
  await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
  await expect(page.getByText(copy.personal, { exact: true })).toBeVisible()
  await expect(page.getByText(copy.owner, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Create team workspace', exact: true }).click()
  const createTeam = page.getByRole('form', { name: 'Create team workspace' })
  await createTeam.getByLabel('Team name', { exact: true }).fill(teamName)
  await createTeam.getByLabel('Workspace URL', { exact: true }).fill(slug)
  await createTeam.getByRole('button', { name: 'Create team', exact: true }).click()
  await expect(page).toHaveURL(`${baseURL}/app/${slug}`)
  await expect(page.getByTestId('workspace-name')).toHaveText(teamName)
  await expect(page.getByText(copy.team, { exact: true })).toBeVisible()
  await expect(page.getByTestId('current-user')).toHaveText(`${name} (${email})`)
  await expect(page.getByText(copy.owner, { exact: true })).toBeVisible()
  await page.getByRole('link', { name: copy.settings, exact: true }).click()
  await expect(page.getByRole('form', { name: 'Invite member', exact: true })).toBeVisible()
  await expect(page.getByText(`${name} (${email}) · owner`, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Delete team workspace', exact: true })).toBeVisible()

  await page.getByLabel('Switch workspace', { exact: true }).selectOption({
    label: 'Personal (personal)',
  })
  await expect(page).toHaveURL(personalURL)
  await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
  await page.getByRole('link', { name: copy.settings, exact: true }).click()
  await expect(page.getByRole('form', { name: 'Invite member', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Delete team workspace', exact: true })).toHaveCount(
    0,
  )
  await page.getByLabel('Switch workspace', { exact: true }).selectOption({ label: teamName })
  await expect(page).toHaveURL(`${baseURL}/app/${slug}`)
  await expect(page.getByTestId('workspace-name')).toHaveText(teamName)
  expect(await sessionIdentity(page)).toEqual({ email, verified: true })

  // 使用浏览器 fetch 继承 host resolver，避免 APIRequestContext 的宿主机 DNS 要求。
  const health = await page.evaluate(async () => {
    const response = await fetch('/api/health')
    return { status: response.status, body: await response.json() }
  })
  expect(health.status).toBe(200)
  expect(health.body.version).toMatch(/^[0-9a-f]{40}$/)
  if (process.env.APP_VERSION) expect(health.body.version).toBe(process.env.APP_VERSION)
  for (const dependency of ['db', 'cache', 'queue', 'scheduler']) {
    expect(health.body[dependency].status).toBe('up')
  }
  expect(Number.isFinite(Date.parse(health.body.jobs.lastCronAt))).toBe(true)
})

import { pretty } from 'react-email'
import { describe, expect, it } from 'vitest'
import { renderEmail } from '../src/index.ts'
import { APP_NAME, fixtures, LOCALES, snapshotPath } from './fixtures.ts'

describe.each(LOCALES)('templates (%s)', (locale) => {
  it.each(fixtures)('$template', async ({ template, props, recipientName }) => {
    const email = await renderEmail(template, props, { locale, appName: APP_NAME, recipientName })
    expect(email.locale).toBe(locale)
    expect(email.subject).toMatchSnapshot('subject')
    await expect(await pretty(email.html)).toMatchFileSnapshot(
      snapshotPath(template, locale, 'html'),
    )
    await expect(email.text).toMatchFileSnapshot(snapshotPath(template, locale, 'txt'))
  })
})

describe('renderEmail', () => {
  it('picks the language from the recipient locale and falls back to en', async () => {
    const props = { url: 'https://acme.test/verify' }
    const zh = await renderEmail('verify-email', props, { locale: 'zh-CN', appName: APP_NAME })
    const fr = await renderEmail('verify-email', props, { locale: 'fr', appName: APP_NAME })
    const none = await renderEmail('verify-email', props, { locale: null, appName: APP_NAME })
    expect(zh.locale).toBe('zh')
    expect(zh.html).toContain('lang="zh-CN"')
    expect(fr.locale).toBe('en')
    expect(none.locale).toBe('en')
    expect(none.subject).toBe(fr.subject)
  })

  it.each([
    ['en', 'as an owner', '7 days'],
    ['zh', '以所有者身份', '7 天'],
  ] as const)('renders owner invitations in %s', async (locale, roleCopy, expiryCopy) => {
    const email = await renderEmail(
      'workspace-invitation',
      {
        url: 'https://acme.test/accept-invitation?id=1',
        workspaceName: 'Team',
        inviterName: 'Ada',
        role: 'owner',
        expiresInDays: 7,
      },
      { locale, appName: APP_NAME },
    )
    expect(email.text).toContain(roleCopy)
    expect(email.text).toContain(expiryCopy)
  })

  it('escapes user-controlled text', async () => {
    const email = await renderEmail(
      'workspace-invitation',
      {
        url: 'https://acme.test/invite/1',
        workspaceName: '<script>alert(1)</script>',
        inviterName: '<b>Mallory</b>',
        role: 'member',
        expiresInDays: 7,
      },
      { locale: 'en', appName: APP_NAME },
    )
    expect(email.html).not.toContain('<script>')
    expect(email.html).not.toContain('<b>Mallory</b>')
    expect(email.html).toContain('&lt;script&gt;')
  })

  it('rejects links that are not http(s)', async () => {
    const ctx = { locale: 'en', appName: APP_NAME }
    await expect(
      renderEmail('magic-link', { url: 'javascript:alert(1)', expiresInMinutes: 5 }, ctx),
    ).rejects.toThrow('http or https')
    await expect(
      renderEmail('magic-link', { url: '/relative', expiresInMinutes: 5 }, ctx),
    ).rejects.toThrow('absolute URL')
  })

  it('keeps the OTP code in both html and text', async () => {
    const email = await renderEmail(
      'otp',
      { otp: '000731', purpose: 'forget-password', expiresInMinutes: 10 },
      { locale: 'zh', appName: APP_NAME },
    )
    expect(email.html).toContain('000731')
    expect(email.text).toContain('000731')
    expect(email.text).toContain('重置 Acme 密码')
  })
})

it('distinguishes approved refunds from verified completion in email', async () => {
  const props = { amount: 400, currency: 'USD', note: '', supportEmail: 'support@example.test' }
  const context = { locale: 'en', appName: APP_NAME }
  const approved = await renderEmail('refund-update', { ...props, status: 'approved' }, context)
  const completed = await renderEmail('refund-update', { ...props, status: 'refunded' }, context)
  expect(approved.text).toContain('not yet confirmed')
  expect(completed.text).toContain('provider has confirmed')
  expect(approved.text).toContain('4.00 USD')
})

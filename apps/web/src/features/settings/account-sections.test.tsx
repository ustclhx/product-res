import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import type { AccountView } from './account.ts'
import { PreferencesSection } from './account-sections.tsx'
import { ACCOUNT_COPY } from './copy.ts'

const user: AccountView['user'] = {
  id: 'user',
  name: 'User',
  email: 'user@example.com',
  emailVerified: true,
  image: null,
  locale: null,
  timezone: null,
  twoFactorEnabled: false,
}

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => overwriteGetLocale(() => baseLocale))

it('renders the preferences heading for the configured i18n mode', () => {
  const html = renderToStaticMarkup(<PreferencesSection user={user} locales={[baseLocale]} />)
  const heading = templateConfig.i18n.enabled
    ? m.account_preferences_heading()
    : m.account_preferences_timezoneheading()
  expect(html.match(/<h2[^>]*>(.*?)<\/h2>/)?.[1]).toBe(heading)
})

// 生成器 --i18n false 时产品有意不渲染语言控件（见 account-sections.tsx），该组用例只在多语言开启时成立
describe.skipIf(!templateConfig.i18n.enabled)('account language preference', () => {
  it.each([
    { locale: 'zh', expected: 'zh' },
    { locale: null, expected: null },
    { locale: 'removed', expected: null },
  ])('renders the selected language before hydration for $locale', ({ locale, expected }) => {
    const html = renderToStaticMarkup(
      <PreferencesSection user={{ ...user, locale }} locales={['en', 'zh']} />,
    )
    const trigger = html.match(/<button[^>]*role="combobox"[^>]*>[\s\S]*?<\/button>/)?.[0]
    expect(html).toContain('for="locale"')
    expect(trigger).toContain('id="locale"')
    expect(trigger).toContain(expected ?? ACCOUNT_COPY.preferences.localeDefault)
  })
})

describe.runIf(!templateConfig.i18n.enabled)('account preferences without i18n', () => {
  it('does not render the language control', () => {
    const html = renderToStaticMarkup(
      <PreferencesSection user={{ ...user, locale: 'zh' }} locales={[baseLocale]} />,
    )
    expect(html).not.toContain('for="locale"')
    expect(html).not.toContain('id="locale"')
    expect(html).toContain('for="timezone"')
  })
})

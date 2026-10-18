/**
 * 邮件语言：按收件人的 `user.locale` 选择；构建时校验模板支持所有配置语言。
 */
export const EMAIL_LOCALES = ['en', 'zh'] as const
export type EmailLocale = (typeof EMAIL_LOCALES)[number]
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en'

/** `zh`、`zh-CN`、`zh_Hant` 等归为 zh；未设置或不支持的语言回退到模板默认语言。 */
export function resolveEmailLocale(
  locale: string | null | undefined,
  defaultLocale: string = DEFAULT_EMAIL_LOCALE,
): EmailLocale {
  const language = locale?.trim().toLowerCase().split(/[-_]/)[0]
  return (
    EMAIL_LOCALES.find((l) => l === language) ??
    EMAIL_LOCALES.find((l) => l === defaultLocale) ??
    DEFAULT_EMAIL_LOCALE
  )
}

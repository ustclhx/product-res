/** Gmail and Googlemail share one identity; other providers retain dots and tags. */
export function normalizeSignupEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  const parts = normalized.split('@')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Invalid signup email')
  let [local, domain] = parts as [string, string]
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    domain = 'gmail.com'
    local = local.split('+')[0]?.replaceAll('.', '') ?? ''
    if (!local) throw new Error('Invalid signup email')
  }
  return `${local}@${domain}`
}

export const SIGNUP_BONUS_DOMAIN_BLACKLIST_KEY = 'billing.signupBonusDomainBlacklist'

export function parseSignupBonusDomainBlacklist(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Invalid signup bonus domain blacklist')
  return value.map((entry: unknown) => {
    if (typeof entry !== 'string') throw new Error('Invalid signup bonus domain blacklist')
    const domain = entry.trim().toLowerCase().replace(/\.$/, '')
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain)) {
      throw new Error('Invalid signup bonus domain blacklist')
    }
    return domain
  })
}

/** 同时检查原始和规范化域名，避免 googlemail 别名绕过黑名单。 */
export function isSignupEmailBlacklisted(email: string, domains: readonly string[]): boolean {
  const emailDomains = [
    email.trim().toLowerCase().split('@')[1],
    normalizeSignupEmail(email).split('@')[1],
  ]
  return domains.some((blocked) =>
    emailDomains.some((domain) => domain === blocked || domain?.endsWith(`.${blocked}`)),
  )
}

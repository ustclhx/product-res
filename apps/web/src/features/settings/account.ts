import type { TemplateConfig } from '@product-res/config'
import type { Database, User } from '@product-res/db'

/** 用户设置页（/account）需要的数据：只包含当前用户自己的字段 */
export interface AccountView {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: boolean
    readonly image: string | null
    readonly locale: string | null
    readonly timezone: string | null
    readonly twoFactorEnabled: boolean
  }
  /** 是否有密码凭据：只用 OAuth 注册的账号没有密码，不能修改密码或开启两步验证 */
  readonly hasPassword: boolean
  /** 模板配置 `auth.twoFactor` */
  readonly twoFactorAvailable: boolean
  /** 可选的界面语言（模板配置 `i18n.locales`） */
  readonly locales: readonly string[]
}

/** `user` 来自 `requireFreshSession`（已按数据库校验会话与封禁） */
export async function loadAccount(
  db: Database,
  user: User,
  config: TemplateConfig,
): Promise<AccountView> {
  const credential = await db.query.account.findFirst({
    columns: { id: true, password: true },
    where: (a, { and, eq }) => and(eq(a.userId, user.id), eq(a.providerId, 'credential')),
  })
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      locale: user.locale,
      timezone: user.timezone,
      twoFactorEnabled: user.twoFactorEnabled === true,
    },
    hasPassword: Boolean(credential?.password),
    twoFactorAvailable: config.auth.twoFactor,
    locales: config.i18n.locales,
  }
}

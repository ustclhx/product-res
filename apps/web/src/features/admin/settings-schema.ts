import { isValidDailyCreditSetting } from '@product-res/db'
import { z } from 'zod'

const domain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/\.$/, ''))
  .pipe(
    z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  )

export const runtimeSettingsInput = z.object({
  signupEnabled: z.boolean(),
  dailyAmount: z.custom<number>((value) => isValidDailyCreditSetting('credits.dailyAmount', value)),
  dailyMaxDaysPerMonth: z.custom<number>((value) =>
    isValidDailyCreditSetting('credits.dailyMaxDaysPerMonth', value),
  ),
  dailyExpiryDays: z.custom<number>((value) =>
    isValidDailyCreditSetting('credits.dailyExpiryDays', value),
  ),
  dailyRequireVerifiedEmail: z.custom<boolean>((value) =>
    isValidDailyCreditSetting('credits.dailyRequireVerifiedEmail', value),
  ),
  announcement: z.string().trim().max(2000),
  signupBonusDomainBlacklist: z
    .array(domain)
    .max(1000)
    .transform((domains) => [...new Set(domains)]),
  /** 对话无可见正文失败的免费次数与滚动窗口（秒）；0 次表示每次失败都按用量结算 */
  freeFailures: z.object({
    count: z.number().int().min(0).max(1000),
    windowSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600),
  }),
})

export type RuntimeSettingsInput = z.infer<typeof runtimeSettingsInput>

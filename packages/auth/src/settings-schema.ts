import type { TemplateConfig } from '@product-res/config'
import { z } from 'zod'

/**
 * 用户设置字段的校验规则（tasks.md 5.2）。服务端（`account-settings.ts`）与设置页表单共用，
 * 只依赖 zod，可以在浏览器中引入（`@product-res/auth/settings-schema`）。
 */

export const NAME_MAX_LENGTH = 100
export const IMAGE_URL_MAX_LENGTH = 2048

/** 是否为运行时（workerd 的 ICU）认识的 IANA 时区 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const profileNameSchema = z.string().trim().min(1).max(NAME_MAX_LENGTH)
/** 头像只接受 http(s) 地址；`null` 表示清除 */
export const profileImageSchema = z
  .url({ protocol: /^https?$/ })
  .max(IMAGE_URL_MAX_LENGTH)
  .nullable()

export const localeSchema = (config: TemplateConfig) =>
  z.enum(config.i18n.locales as readonly [string, ...string[]]).nullable()
export const timezoneSchema = z
  .string()
  .max(64)
  .refine(isValidTimeZone, { message: 'Unknown time zone' })
  .nullable()

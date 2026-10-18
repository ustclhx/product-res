import {
  profileImageSchema,
  profileNameSchema,
  timezoneSchema,
} from '@product-res/auth/settings-schema'
import { z } from 'zod'
import { ACCOUNT_COPY } from './copy.ts'

// 设置页表单的校验（TanStack Form + Zod）。字段规则与服务端共用 @product-res/auth/settings-schema；
// 表单里空字符串表示「未设置」，提交时转换为 null。

export const profileFormSchema = z.object({
  name: profileNameSchema,
  image: z.union([z.literal(''), profileImageSchema.unwrap()]),
})

export const preferencesFormSchema = (locales: readonly string[]) =>
  z.object({
    locale: z.union([z.literal(''), z.enum(locales as readonly [string, ...string[]])]),
    timezone: z.union([z.literal(''), timezoneSchema.unwrap()]),
  })

// Better Auth 默认的密码长度限制（emailAndPassword.minPasswordLength / maxPasswordLength）
const PASSWORD_MIN_LENGTH = 8
const PASSWORD_MAX_LENGTH = 128

export const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: ACCOUNT_COPY.password.mismatch,
  })

export const passwordOnlyFormSchema = z.object({ password: z.string().min(1) })

export const totpCodeFormSchema = z.object({ code: z.string().regex(/^\d{6}$/) })

/** 表单中的空字符串 → null（清除该字段） */
export const emptyToNull = (value: string): string | null => (value.trim() === '' ? null : value)

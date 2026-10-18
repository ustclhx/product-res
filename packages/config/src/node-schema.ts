import { z } from 'zod'
import { EnvValidationError, validateAiFaultInjectionEnv } from './env.ts'
import type { TemplateConfig } from './template.ts'

const secret = z.string().min(1)
const storageNames = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const
const mailbox = z
  .string()
  .min(1)
  .refine((value) => {
    if (/[\r\n\0]/.test(value)) return false
    const address = value.includes('<')
      ? /^(?:"(?:[^"\\]|\\.)+"|[^"<>,;:]+)\s*<([^<>]+)>$/.exec(value)?.[1]
      : value
    return address !== undefined && z.email().safeParse(address).success
  })
const smtpHost = z
  .string()
  .refine(
    (value) =>
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success ||
      (value.length <= 253 &&
        value.split('.').every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))),
  )

function httpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol) || /[\s?#]/.test(value)) return undefined
    return url
  } catch {
    return undefined
  }
}

/** 仅标量配置；PAYMENT_MODE 继续由支付入口校验，缺凭据不阻断公开页面。 */
const nodeEnvBaseSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/, hostname: /.+/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/, hostname: /.+/ }),
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_URL: z.url({ protocol: /^https$/, hostname: /.+/ }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  CACHE_NAMESPACE: secret.default('saas'),
  PAYMENT_MODE: z.string().optional(),
  AI_FAULT_INJECTION: z.string().optional(),
  SENTRY_ENVIRONMENT: z.enum(['development', 'staging', 'production', 'smoke']).optional(),
  SENTRY_DSN: z
    .string()
    .refine((value) => {
      if (value === '') return true
      const url = httpUrl(value)
      return (
        url !== undefined &&
        /^\w+$/.test(url.username) &&
        url.password === '' &&
        /\/\d+$/.test(url.pathname)
      )
    })
    .optional(),
  S3_ENDPOINT: secret
    .refine((value) => {
      const url = httpUrl(value)
      return url !== undefined && url.username === '' && url.password === ''
    })
    .optional(),
  S3_REGION: secret.optional(),
  S3_BUCKET: secret.optional(),
  S3_ACCESS_KEY_ID: secret.optional(),
  S3_SECRET_ACCESS_KEY: secret.optional(),
  // 在对象校验之后才补默认值，避免默认 true 意外启用未配置存储。
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: secret.optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: secret.optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: secret.optional(),
  STRIPE_SECRET_KEY: secret.optional(),
  STRIPE_WEBHOOK_SECRET: secret.optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: secret.optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  AI_TEXT_EGRESS: z.enum(['direct', 'gateway']).default('direct'),
  OPENAI_API_KEY: secret.optional(),
  ANTHROPIC_API_KEY: secret.optional(),
  GOOGLE_API_KEY: secret.optional(),
  DEEPSEEK_API_KEY: secret.optional(),
  FAL_KEY: secret.optional(),
  MEDIA_WEBHOOK_SECRET: z.string().min(32).optional(),
  AI_GATEWAY_ACCOUNT_ID: z.string().optional(),
  AI_GATEWAY_ID: z.string().optional(),
  AI_GATEWAY_TOKEN: secret.optional(),
  RESEND_API_KEY: secret.optional(),
  EMAIL_TRANSPORT: z.enum(['log', 'resend', 'smtp']).default('log'),
  EMAIL_FROM: mailbox.optional(),
  EMAIL_REPLY_TO: mailbox.optional(),
  SMTP_HOST: smtpHost.optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_TLS_MODE: z.enum(['implicit', 'starttls', 'none']).default('starttls'),
  SMTP_USER: secret.optional(),
  SMTP_PASSWORD: secret.optional(),
})

function withNodeValidation<Shape extends z.core.$ZodShape>(schema: z.ZodObject<Shape>) {
  return schema
    .superRefine((parsed, ctx) => {
      const env = parsed as z.output<typeof nodeEnvBaseSchema>
      try {
        validateAiFaultInjectionEnv(env)
      } catch (error) {
        if (!(error instanceof EnvValidationError)) throw error
        for (const key of error.invalid)
          ctx.addIssue({ code: 'custom', path: [key], message: 'invalid' })
      }
      const required = (names: readonly (keyof typeof env)[]) => {
        for (const key of names) {
          if (env[key] === undefined)
            ctx.addIssue({ code: 'custom', path: [key], message: 'required' })
        }
      }
      if (
        env.S3_FORCE_PATH_STYLE !== undefined ||
        storageNames.some((key) => env[key] !== undefined)
      )
        required(storageNames)
      if (env.EMAIL_TRANSPORT === 'resend') required(['RESEND_API_KEY', 'EMAIL_FROM'])
      if (env.EMAIL_TRANSPORT === 'smtp') {
        required(['SMTP_HOST', 'SMTP_PORT', 'EMAIL_FROM'])
        if (env.SMTP_USER !== undefined || env.SMTP_PASSWORD !== undefined)
          required(['SMTP_USER', 'SMTP_PASSWORD'])
      }
      if (env.SENTRY_ENVIRONMENT === 'production') {
        for (const key of ['S3_ENDPOINT', 'SENTRY_DSN'] as const) {
          if (env[key] && httpUrl(env[key])?.protocol === 'http:')
            ctx.addIssue({ code: 'custom', path: [key], message: 'https required' })
        }
      }
    })
    .transform((env) => ({
      ...env,
      S3_FORCE_PATH_STYLE: (env as z.output<typeof nodeEnvBaseSchema>).S3_FORCE_PATH_STYLE ?? true,
    }))
}

export const nodeEnvSchema = withNodeValidation(nodeEnvBaseSchema)

export type NodeEnv = z.output<typeof nodeEnvSchema>

/** 只允许这些密钥的 _FILE；未知配置不会触发任意文件读取。 */
export const nodeSecretNames = [
  'DATABASE_URL',
  'VALKEY_URL',
  'BETTER_AUTH_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_SECRET',
  'TURNSTILE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'FAL_KEY',
  'MEDIA_WEBHOOK_SECRET',
  'AI_GATEWAY_TOKEN',
  'RESEND_API_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SMTP_PASSWORD',
  'SENTRY_DSN',
] as const satisfies readonly (keyof NodeEnv)[]

/** 启动入口传入模板开关；OAuth/Turnstile 仅启用时必填，邮件沿用既有通道约束。 */
export function nodeEnvSchemaFor(config: Pick<TemplateConfig, 'auth'>) {
  const oauth = new Set(config.auth.oauth)
  return withNodeValidation(
    nodeEnvBaseSchema.extend({
      GOOGLE_CLIENT_ID: oauth.has('google') ? secret : secret.optional(),
      GOOGLE_CLIENT_SECRET: oauth.has('google') ? secret : secret.optional(),
      GITHUB_CLIENT_ID: oauth.has('github') ? secret : secret.optional(),
      GITHUB_CLIENT_SECRET: oauth.has('github') ? secret : secret.optional(),
      TURNSTILE_SITE_KEY: config.auth.turnstile ? secret : secret.optional(),
      TURNSTILE_SECRET_KEY: config.auth.turnstile ? secret : secret.optional(),
    }),
  )
}

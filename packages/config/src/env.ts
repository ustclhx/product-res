import { z } from 'zod'

/**
 * 环境变量与绑定的启动校验（docs/07-infrastructure.md §4）。
 * 只列出当前代码真正用到的项；后续阶段引入新的变量或绑定时在这里扩展，
 * 或由各 app 用 `envSchema.extend(...)` 加上自己独有的绑定后传给 `loadEnv`。
 */

/** Hyperdrive 绑定中本包用到的部分；保留原对象引用，不做拷贝。 */
export interface HyperdriveBinding {
  readonly connectionString: string
}

const hyperdriveBinding = z.custom<HyperdriveBinding>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { connectionString?: unknown }).connectionString === 'string' &&
    (value as HyperdriveBinding).connectionString.length > 0,
)

export const envSchema = z.object({
  /** 不带查询缓存的 Hyperdrive（app-db），健康检查与写操作使用 */
  HYPERDRIVE: hyperdriveBinding,
  /** 缺失策略由支付入口解析，公开页面仍能降级服务。 */
  PAYMENT_MODE: z.enum(['test', 'live']).optional(),
})

export type Env = z.output<typeof envSchema>

/**
 * 环境校验失败。错误信息与字段只包含变量名，绝不包含变量的值。
 * 不继承 AppError：经 `toErrorResponse` 返回给客户端时只会是通用的 500，变量名只出现在日志中。
 */
export class EnvValidationError extends Error {
  override readonly name = 'EnvValidationError'
  readonly missing: readonly string[]
  readonly invalid: readonly string[]

  constructor(missing: readonly string[], invalid: readonly string[]) {
    const parts = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : null,
      invalid.length > 0 ? `invalid ${invalid.join(', ')}` : null,
    ].filter((part) => part !== null)
    super(`Invalid environment: ${parts.join('; ')}`)
    this.missing = missing
    this.invalid = invalid
  }
}

export type PaymentMode = 'test' | 'live'

export interface PaymentModeEnv {
  PAYMENT_MODE?: string | undefined
  SENTRY_ENVIRONMENT?: string | undefined
}

export interface AiFaultInjectionEnv {
  AI_FAULT_INJECTION?: string | undefined
  SENTRY_ENVIRONMENT?: string | undefined
}

/** 专用开关只允许 staging 开启，生产环境连显式关闭配置也拒绝。 */
export function validateAiFaultInjectionEnv(env: AiFaultInjectionEnv): void {
  const value = env.AI_FAULT_INJECTION
  if (value === undefined) return
  if (
    env.SENTRY_ENVIRONMENT === 'production' ||
    (value !== 'enabled' && value !== 'disabled') ||
    (value === 'enabled' && env.SENTRY_ENVIRONMENT !== 'staging')
  )
    throw new EnvValidationError([], ['AI_FAULT_INJECTION'])
}

/** 调用入口缺省拒绝；环境装配另行校验，非法配置不能触发故障。 */
export function isAiFaultInjectionEnabled(env: AiFaultInjectionEnv): boolean {
  return env.AI_FAULT_INJECTION === 'enabled' && env.SENTRY_ENVIRONMENT === 'staging'
}

/** 只有显式开发环境允许省略模式，避免未标记的线上环境默认为测试。 */
export function resolvePaymentMode(env: PaymentModeEnv): PaymentMode {
  if (env.PAYMENT_MODE === 'test' || env.PAYMENT_MODE === 'live') return env.PAYMENT_MODE
  if (env.PAYMENT_MODE === undefined) {
    if (env.SENTRY_ENVIRONMENT === 'development') return 'test'
    throw new EnvValidationError(['PAYMENT_MODE'], [])
  }
  throw new EnvValidationError([], ['PAYMENT_MODE'])
}

/** 按默认 schema 校验 Worker 的 `env`，失败时抛出 `EnvValidationError`。 */
export function loadEnv(env: unknown): Env
/** 按指定 schema（通常是 `envSchema.extend(...)`）校验。 */
export function loadEnv<S extends z.ZodType>(env: unknown, schema: S): z.output<S>
export function loadEnv(env: unknown, schema: z.ZodType = envSchema): unknown {
  const result = schema.safeParse(env ?? {})
  if (result.success) return result.data

  const source = (typeof env === 'object' && env !== null ? env : {}) as Record<string, unknown>
  const missing = new Set<string>()
  const invalid = new Set<string>()
  // 只读取 issue 的路径（变量名），不使用 issue.message，避免自定义消息中带出取值
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '(root)')
    if (source[key] === undefined) missing.add(key)
    else invalid.add(key)
  }
  throw new EnvValidationError([...missing].sort(), [...invalid].sort())
}

import { parseAuthEnv } from '@product-res/auth'
import {
  type AiFaultInjectionEnv,
  EnvValidationError,
  envSchema,
  loadEnv,
  validateAiFaultInjectionEnv,
} from '@product-res/config'
import { log } from '@product-res/shared/log'
import { z } from 'zod'
import { templateConfig } from '../template-config.ts'

/** 绑定对象上必须存在的方法（只检查形状，不读取任何取值） */
const bindingWith = <T>(...methods: string[]) =>
  z.custom<T>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      methods.every((m) => typeof (value as Record<string, unknown>)[m] === 'function'),
  )

/** apps/web 需要的环境变量与绑定：共享 schema 加上 web 独有的绑定。 */
// 支付模式由支付工厂单独校验，避免支付配置错误阻断公开页面与普通认证。
export const webEnvSchema = envSchema.omit({ PAYMENT_MODE: true }).extend({
  BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED: z.string().optional(),
  SIGNUP_ALLOWED_EMAILS: z.string().optional(),
  AI_TEXT_EGRESS: z.enum(['direct', 'gateway']).optional(),
  OPENAI_BASE_URL: z.string().optional(),
  AI_MEDIA_WORKFLOW:
    templateConfig.ai.image || templateConfig.ai.video
      ? bindingWith<Cloudflare.Env['AI_MEDIA_WORKFLOW']>('create', 'get')
      : bindingWith<Cloudflare.Env['AI_MEDIA_WORKFLOW']>('create', 'get').optional(),
  // 跨空间数据流转（add-workspace-data-transfer）；未绑定时发起入口返回 503
  WORKSPACE_TRANSFER_WORKFLOW: bindingWith<
    NonNullable<Cloudflare.Env['WORKSPACE_TRANSFER_WORKFLOW']>
  >('create', 'get').optional(),
  EMAIL_QUEUE: bindingWith<Cloudflare.Env['EMAIL_QUEUE']>('send'),
  CACHE: bindingWith<Cloudflare.Env['CACHE']>('get', 'put', 'delete'),
  RL_AUTH: bindingWith<Cloudflare.Env['RL_AUTH']>('limit'),
  RL_AI: bindingWith<Cloudflare.Env['RL_AI']>('limit'),
  RL_API: templateConfig.features.publicApi
    ? bindingWith<Cloudflare.Env['RL_API']>('limit')
    : bindingWith<Cloudflare.Env['RL_API']>('limit').optional(),
})

/**
 * 认证页面需要的公开变量：启用 Turnstile 时，登录 / 注册等页面要用 site key 渲染小组件
 * （features/auth/options.ts），缺失会让这些表单无法提交。
 */
const authUiEnvSchema = z.object({
  TURNSTILE_SITE_KEY: templateConfig.auth.turnstile ? z.string().min(1) : z.string().optional(),
})

/** 绑定（webEnvSchema）与认证所需的变量（按模板配置，@product-res/auth 的 parseAuthEnv）一起校验，合并报告 */
function validate(env: unknown): EnvValidationError | null {
  const missing = new Set<string>()
  const invalid = new Set<string>()
  for (const check of [
    () => validateAiFaultInjectionEnv((env ?? {}) as AiFaultInjectionEnv),
    () => loadEnv(env, webEnvSchema),
    () => loadEnv(env, authUiEnvSchema),
    () => parseAuthEnv((env ?? {}) as Parameters<typeof parseAuthEnv>[0], templateConfig),
  ]) {
    try {
      check()
    } catch (error) {
      if (!(error instanceof EnvValidationError)) throw error
      for (const key of error.missing) missing.add(key)
      for (const key of error.invalid) invalid.add(key)
    }
  }
  if (missing.size === 0 && invalid.size === 0) return null
  return new EnvValidationError([...missing].sort(), [...invalid].sort())
}

/** 已校验通过的 env 对象；env 在一个 isolate 内不变，校验一次即可。 */
const validated = new WeakSet<object>()

/**
 * 请求入口的环境校验（specs/runtime-config「环境变量启动校验」）。
 * 校验通过返回 `null`；失败时只在日志中列出变量名，并返回不含任何细节的 500。
 */
export function checkEnv(env: unknown): Response | null {
  if (typeof env === 'object' && env !== null && validated.has(env)) return null
  const error = validate(env)
  if (error) {
    log.error('env.invalid', { missing: error.missing, invalid: error.invalid })
    return new Response('Internal Server Error', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }
  if (typeof env === 'object' && env !== null) validated.add(env)
  return null
}

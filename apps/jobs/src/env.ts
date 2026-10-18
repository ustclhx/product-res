import {
  type AiFaultInjectionEnv,
  envSchema,
  loadEnv,
  validateAiFaultInjectionEnv,
  withEmailEnv,
} from '@product-res/config'

/** apps/jobs 需要的环境变量与绑定：共享 schema 加上邮件发送通道（EMAIL_QUEUE 消费者）。 */
export const jobsEnvSchema = withEmailEnv(envSchema)

/**
 * 处理任何事件之前校验环境（specs/runtime-config「环境变量启动校验」）。
 * 失败时抛出 `EnvValidationError`，其消息只含变量名：Cron 记为失败，Queue 消息按重试策略重投。
 */
export function requireEnv(env: unknown) {
  validateAiFaultInjectionEnv((env ?? {}) as AiFaultInjectionEnv)
  return loadEnv(env, jobsEnvSchema)
}

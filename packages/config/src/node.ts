import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { EmailTransportConfig } from './email-env.ts'
import { EnvValidationError, loadEnv } from './env.ts'
import { type NodeEnv, nodeEnvSchema, nodeEnvSchemaFor, nodeSecretNames } from './node-schema.ts'
import type { TemplateConfig } from './template.ts'

export { type NodeEnv, nodeEnvSchema, nodeEnvSchemaFor, nodeSecretNames } from './node-schema.ts'

export interface NodeStorageConfig {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly forcePathStyle: boolean
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

/** 已校验的配置只做装配映射，不加载 SDK 或读取外部凭据。 */
export function nodeStorageConfig(env: NodeEnv): NodeStorageConfig | undefined {
  if (env.S3_ENDPOINT === undefined) return undefined
  return {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION as string,
    bucket: env.S3_BUCKET as string,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
  }
}

export type NodeEmailTransportConfig =
  | EmailTransportConfig
  | {
      readonly transport: 'smtp'
      readonly host: string
      readonly port: number
      readonly tlsMode: 'implicit' | 'starttls' | 'none'
      readonly from: string
      readonly replyTo?: string
      readonly user?: string
      readonly password?: string
    }

export function nodeEmailTransportConfig(env: NodeEnv): NodeEmailTransportConfig {
  if (env.EMAIL_TRANSPORT === 'log') return { transport: 'log' }
  if (env.EMAIL_TRANSPORT === 'resend')
    return {
      transport: 'resend',
      apiKey: env.RESEND_API_KEY as string,
      from: env.EMAIL_FROM as string,
      replyTo: env.EMAIL_REPLY_TO,
    }
  return {
    transport: 'smtp',
    host: env.SMTP_HOST as string,
    port: env.SMTP_PORT as number,
    tlsMode: env.SMTP_TLS_MODE,
    from: env.EMAIL_FROM as string,
    ...(env.EMAIL_REPLY_TO === undefined ? {} : { replyTo: env.EMAIL_REPLY_TO }),
    ...(env.SMTP_USER === undefined
      ? {}
      : { user: env.SMTP_USER, password: env.SMTP_PASSWORD as string }),
  }
}

export interface NodeEnvOptions {
  templateConfig?: Pick<TemplateConfig, 'auth'>
  /** 默认运行目录的 .env；false 禁止 dotenv 读取，显式路径不可读时失败。 */
  dotenvPath?: string | false
  /** 默认 process.env；只在调用时读取，不修改全局环境。 */
  env?: Readonly<Record<string, string | undefined>>
}

/** 在 listen/处理器启动前调用；抛错让启动入口非零退出，不输出原始驱动/文件错误。 */
export function loadNodeEnv(options: NodeEnvOptions = {}): NodeEnv {
  let dotenv: Record<string, string | undefined> = {}
  if (options.dotenvPath !== false) {
    try {
      dotenv = parseEnv(readFileSync(options.dotenvPath ?? '.env', 'utf8'))
    } catch (error) {
      // 仅默认文件不存在允许省略；显式文件错误必须让部署失败。
      if (options.dotenvPath !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new EnvValidationError([], ['DOTENV'])
    }
  }
  const source: Record<string, string | undefined> = { ...dotenv }
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) source[key] = value
  }
  const invalid: string[] = []
  for (const key of nodeSecretNames) {
    const fileKey = `${key}_FILE`
    if (source[fileKey] === undefined) continue
    if (source[key] !== undefined) {
      invalid.push(key)
      continue
    }
    try {
      // 仅去掉一个文件末尾换行，不 trim 密钥中的空格或多余换行。
      const value = readFileSync(source[fileKey], 'utf8').replace(/\r?\n$/, '')
      if (value.length === 0) invalid.push(key)
      else source[key] = value
    } catch {
      invalid.push(key)
    }
  }
  if (invalid.length) throw new EnvValidationError([], invalid.sort())
  return loadEnv(
    source,
    options.templateConfig ? nodeEnvSchemaFor(options.templateConfig) : nodeEnvSchema,
  )
}

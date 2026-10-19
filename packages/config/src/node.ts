import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import type { EmailTransportConfig } from './email-env.ts'
import { EnvValidationError, loadEnv } from './env.ts'
import { type NodeEnv, nodeEnvSchema, nodeEnvSchemaFor, nodeSecretNames } from './node-schema.ts'
import type { TemplateConfig } from './template.ts'

export { type NodeEnv, nodeEnvSchema, nodeEnvSchemaFor, nodeSecretNames } from './node-schema.ts'

const blankAsUnset = new Set([
  'BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED',
  'DATA_PIPELINE_SCHEDULES',
  'EMAIL_FROM',
  'EMAIL_REPLY_TO',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_TLS_MODE',
  'SMTP_USER',
])

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
    // Compose 用 `${NAME:-}` 透传可选项时未配置即为空串；这些键按未设置处理，避免格式校验误判
    if (value === '' && blankAsUnset.has(key)) continue
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
  // 可选密钥目录：每个文件名即密钥名；文件不存在表示未配置，基础 Compose 不必为未启用集成挂载单独 secret。
  const optionalDir = source.OPTIONAL_SECRETS_DIR
  if (optionalDir) {
    for (const key of nodeSecretNames) {
      if (source[key] !== undefined || source[`${key}_FILE`] !== undefined) continue
      const value = readOptionalSecret(optionalDir, key)
      if (value === null) invalid.push(key)
      else if (value !== undefined) source[key] = value
    }
  }
  if (invalid.length) throw new EnvValidationError([], invalid.sort())
  return loadEnv(
    source,
    options.templateConfig ? nodeEnvSchemaFor(options.templateConfig) : nodeEnvSchema,
  )
}

/** 读取可选密钥目录中的单个文件：不存在返回 undefined；不可读或为空返回 null（配置错误） */
function readOptionalSecret(dir: string, name: string): string | undefined | null {
  try {
    const value = readFileSync(join(dir, name), 'utf8').replace(/\r?\n$/, '')
    return value.length === 0 ? null : value
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null
  }
}

/** 数据源凭据名前缀；只读取这些前缀的 NAME 或 NAME_FILE，未知名称不会触发文件读取 */
const DATA_SOURCE_SECRET =
  /^(EBAY|KEEPA|JUNGLESCOUT|SELLERSPRITE|HELIUM10|DATAFORSEO|SPAPI|FX)_[A-Z0-9_]+$/

/**
 * 读取数据源凭据（add-data-source-hub design D2）：优先 NAME，其次 NAME_FILE，最后 OPTIONAL_SECRETS_DIR/NAME（去掉一个末尾换行）。
 * 结果按名称缓存；未配置、文件不可读或为空都返回 undefined，由连接器核验报告“未配置”。
 */
export function createDataSourceSecrets(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const cache = new Map<string, string | undefined>()
  return (name: string): string | undefined => {
    if (!DATA_SOURCE_SECRET.test(name)) return undefined
    if (cache.has(name)) return cache.get(name)
    let value = env[name]
    const file = env[`${name}_FILE`]
    if (value === undefined && file) {
      try {
        value = readFileSync(file, 'utf8').replace(/\r?\n$/, '')
      } catch {
        value = undefined
      }
    }
    if (value === undefined && !file && env.OPTIONAL_SECRETS_DIR)
      value = readOptionalSecret(env.OPTIONAL_SECRETS_DIR, name) ?? undefined
    const result = value ? value : undefined
    cache.set(name, result)
    return result
  }
}

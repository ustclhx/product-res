import { describe, expect, it } from 'vitest'
import { emailTransportConfig, withEmailEnv } from './email-env.ts'
import { EnvValidationError, envSchema, loadEnv } from './env.ts'

const schema = withEmailEnv(envSchema)
const HYPERDRIVE = { connectionString: 'postgres://app:app@localhost:5432/app' }

describe('withEmailEnv', () => {
  it('默认使用 log 通道，不要求 Resend 变量', () => {
    const env = loadEnv({ HYPERDRIVE }, schema)
    expect(env.EMAIL_TRANSPORT).toBe('log')
    expect(env.HYPERDRIVE).toBe(HYPERDRIVE)
    expect(emailTransportConfig(env)).toEqual({ transport: 'log' })
  })

  it('resend 通道要求 RESEND_API_KEY 与 EMAIL_FROM，错误只含变量名', () => {
    let error: unknown
    try {
      loadEnv({ HYPERDRIVE, EMAIL_TRANSPORT: 'resend', EMAIL_REPLY_TO: 'help@example.com' }, schema)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(EnvValidationError)
    expect((error as EnvValidationError).missing).toEqual(['EMAIL_FROM', 'RESEND_API_KEY'])
    expect((error as EnvValidationError).message).not.toContain('help@example.com')
  })

  it('resend 通道变量齐全时返回发送配置', () => {
    const env = loadEnv(
      {
        HYPERDRIVE,
        EMAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_test_key',
        EMAIL_FROM: 'product-res <noreply@example.com>',
      },
      schema,
    )
    expect(emailTransportConfig(env)).toEqual({
      transport: 'resend',
      apiKey: 're_test_key',
      from: 'product-res <noreply@example.com>',
      replyTo: undefined,
    })
  })

  it('未知通道视为非法取值', () => {
    expect(() => loadEnv({ HYPERDRIVE, EMAIL_TRANSPORT: 'smtp' }, schema)).toThrow(
      'Invalid environment: invalid EMAIL_TRANSPORT',
    )
  })
})

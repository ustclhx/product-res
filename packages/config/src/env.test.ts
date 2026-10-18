import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import {
  type AiFaultInjectionEnv,
  EnvValidationError,
  envSchema,
  type HyperdriveBinding,
  isAiFaultInjectionEnabled,
  loadEnv,
  resolvePaymentMode,
  validateAiFaultInjectionEnv,
} from './env.ts'

const SECRET = 'postgres://app:s3cr3t-password@db.internal:5432/app'

function captureError(fn: () => unknown): EnvValidationError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError)
    return error as EnvValidationError
  }
  throw new Error('expected loadEnv to throw')
}

/** 断言错误的所有对外可见内容都不含任何传入的值。 */
function expectNoValues(error: EnvValidationError, values: string[]) {
  const visible = [error.message, String(error), error.stack ?? '', JSON.stringify(error)].join(
    '\n',
  )
  for (const value of values) expect(visible).not.toContain(value)
}

describe('loadEnv', () => {
  it('returns the validated env when everything is present', () => {
    const hyperdrive = { connectionString: SECRET, host: 'db.internal' }
    const env = loadEnv({ HYPERDRIVE: hyperdrive, UNRELATED: 'x' })
    // 绑定保持原对象引用，不被拷贝成只含已知字段的新对象
    expect(env.HYPERDRIVE).toBe(hyperdrive)
    expect(env).toEqual({ HYPERDRIVE: hyperdrive })
    expectTypeOf(env.HYPERDRIVE).toEqualTypeOf<HyperdriveBinding>()
  })

  it('reports missing variables by name', () => {
    const error = captureError(() => loadEnv({ OTHER_SECRET: 'top-secret-value' }))
    expect(error.missing).toEqual(['HYPERDRIVE'])
    expect(error.invalid).toEqual([])
    expect(error.message).toBe('Invalid environment: missing HYPERDRIVE')
    expectNoValues(error, ['top-secret-value'])
  })

  it('treats an undefined env as everything missing', () => {
    expect(captureError(() => loadEnv(undefined)).missing).toEqual(['HYPERDRIVE'])
  })

  it('reports malformed values by name without echoing the value', () => {
    const error = captureError(() => loadEnv({ HYPERDRIVE: SECRET }))
    expect(error.missing).toEqual([])
    expect(error.invalid).toEqual(['HYPERDRIVE'])
    expect(error.message).toBe('Invalid environment: invalid HYPERDRIVE')
    expectNoValues(error, [SECRET, 's3cr3t-password', 'db.internal'])
  })

  it('rejects a Hyperdrive binding with an empty connection string', () => {
    const error = captureError(() => loadEnv({ HYPERDRIVE: { connectionString: '' } }))
    expect(error.invalid).toEqual(['HYPERDRIVE'])
  })

  describe('with an extended schema', () => {
    const schema = envSchema.extend({
      APP_URL: z.url(),
      API_KEY: z.string().min(32, { error: (issue) => `bad value ${String(issue.input)}` }),
      OPTIONAL_FLAG: z.enum(['on', 'off']).optional(),
    })

    it('validates the extra variables and infers their types', () => {
      const env = loadEnv(
        {
          HYPERDRIVE: { connectionString: SECRET },
          APP_URL: 'https://product.ezarouter.cc',
          API_KEY: 'k'.repeat(32),
        },
        schema,
      )
      expect(env.APP_URL).toBe('https://product.ezarouter.cc')
      expect(env.OPTIONAL_FLAG).toBeUndefined()
      expectTypeOf(env.APP_URL).toEqualTypeOf<string>()
      expectTypeOf(env.OPTIONAL_FLAG).toEqualTypeOf<'on' | 'off' | undefined>()
    })

    it('lists missing and invalid names together, never values', () => {
      const error = captureError(() =>
        loadEnv(
          { APP_URL: 'not a url', API_KEY: 'short-secret-key', OPTIONAL_FLAG: 'maybe' },
          schema,
        ),
      )
      expect(error.missing).toEqual(['HYPERDRIVE'])
      expect(error.invalid).toEqual(['API_KEY', 'APP_URL', 'OPTIONAL_FLAG'])
      expect(error.message).toBe(
        'Invalid environment: missing HYPERDRIVE; invalid API_KEY, APP_URL, OPTIONAL_FLAG',
      )
      // 自定义的 Zod 错误消息里带了取值，也不能出现在错误中
      expectNoValues(error, ['not a url', 'short-secret-key', 'maybe'])
    })
  })
})

describe('AI fault injection environment', () => {
  it('只允许 staging 显式开启，缺失或 disabled 不开启故障', () => {
    for (const env of [
      {},
      { SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'disabled' },
      { AI_FAULT_INJECTION: 'disabled', SENTRY_ENVIRONMENT: 'staging' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'staging' },
    ]) {
      expect(() => validateAiFaultInjectionEnv(env)).not.toThrow()
      expect(isAiFaultInjectionEnabled(env)).toBe(env.AI_FAULT_INJECTION === 'enabled')
    }
  })

  it.each<AiFaultInjectionEnv>([
    { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'production' },
    { AI_FAULT_INJECTION: 'disabled', SENTRY_ENVIRONMENT: 'production' },
    { AI_FAULT_INJECTION: 'enabled' },
    { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'development' },
    { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'private-unknown' },
    { AI_FAULT_INJECTION: 'private-invalid', SENTRY_ENVIRONMENT: 'staging' },
    { AI_FAULT_INJECTION: '', SENTRY_ENVIRONMENT: 'staging' },
  ])('拒绝非 staging 开启、生产配置和非法值且只报告变量名：%j', (env) => {
    const error = captureError(() => validateAiFaultInjectionEnv(env))
    expect(error.invalid).toEqual(['AI_FAULT_INJECTION'])
    expectNoValues(
      error,
      Object.values(env).filter((value): value is string => Boolean(value)),
    )
    expect(isAiFaultInjectionEnabled(env)).toBe(false)
  })
})

describe('payment mode', () => {
  it.each(['test', 'live'] as const)('accepts explicit %s in any environment', (mode) => {
    expect(resolvePaymentMode({ PAYMENT_MODE: mode, SENTRY_ENVIRONMENT: 'production' })).toBe(mode)
    expect(
      loadEnv({ HYPERDRIVE: { connectionString: SECRET }, PAYMENT_MODE: mode }).PAYMENT_MODE,
    ).toBe(mode)
  })

  it('defaults only explicit development to test', () => {
    expect(resolvePaymentMode({ SENTRY_ENVIRONMENT: 'development' })).toBe('test')
    for (const environment of ['staging', 'production', undefined]) {
      expect(
        captureError(() =>
          resolvePaymentMode(environment ? { SENTRY_ENVIRONMENT: environment } : {}),
        ).missing,
      ).toEqual(['PAYMENT_MODE'])
    }
  })

  it('rejects invalid modes without exposing their values', () => {
    const value = 'private-invalid-mode'
    for (const check of [
      () => resolvePaymentMode({ PAYMENT_MODE: value, SENTRY_ENVIRONMENT: 'development' }),
      () => loadEnv({ HYPERDRIVE: { connectionString: SECRET }, PAYMENT_MODE: value }),
    ]) {
      const error = captureError(check)
      expect(error.invalid).toEqual(['PAYMENT_MODE'])
      expectNoValues(error, [value])
    }
  })
})

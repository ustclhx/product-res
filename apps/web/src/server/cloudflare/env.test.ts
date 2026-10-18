import { withLogContext } from '@product-res/shared/log'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkEnv } from './env.ts'

// 校验用例固定要求 OAuth 与 Turnstile，生成项目关闭登录方式时仍覆盖缺失变量。
vi.mock('../template-config.ts', async (original) => {
  const { templateConfig } = await original<typeof import('../template-config.ts')>()
  return {
    templateConfig: {
      ...templateConfig,
      ai: { ...templateConfig.ai, image: true, video: true },
      auth: { ...templateConfig.auth, oauth: ['google', 'github'], turnstile: true },
      features: { ...templateConfig.features, publicApi: false },
    },
  }
})

const SECRET = 'postgres://app:super-secret@db.internal.example:5432/app'

/** 齐全的 env：Hyperdrive、形状正确的 Workflow / Queue / KV / Rate Limiting 绑定，以及模板配置要求的认证变量 */
function completeEnv() {
  const fn = () => undefined
  return {
    HYPERDRIVE: { connectionString: SECRET },
    AI_MEDIA_WORKFLOW: { create: fn, get: fn },
    EMAIL_QUEUE: { send: fn },
    CACHE: { get: fn, put: fn, delete: fn },
    RL_AUTH: { limit: fn },
    RL_AI: { limit: fn },
    APP_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    TURNSTILE_SECRET_KEY: 'turnstile-secret',
    TURNSTILE_SITE_KEY: 'turnstile-site-key',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    GITHUB_CLIENT_ID: 'github-id',
    GITHUB_CLIENT_SECRET: 'github-secret',
  }
}

function captureErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('checkEnv（请求入口的环境校验）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('缺少必需绑定时返回 500，日志只含变量名', async () => {
    const error = captureErrors()
    const { HYPERDRIVE: _, ...env } = completeEnv()
    const response = withLogContext({ requestId: 'env-request' }, () =>
      checkEnv({ ...env, OTHER_SECRET: SECRET }),
    )
    expect(response?.status).toBe(500)
    const body = await response?.text()
    expect(body).toBe('Internal Server Error')

    expect(error).toHaveBeenCalledTimes(1)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      level: 'error',
      event: 'env.invalid',
      requestId: 'env-request',
      missing: ['HYPERDRIVE'],
      invalid: [],
    })
    expect(logged).not.toContain(SECRET)
  })

  it('绑定格式非法时返回 500，日志不含取值', () => {
    const error = captureErrors()
    const response = checkEnv({
      ...completeEnv(),
      HYPERDRIVE: { connectionString: '' },
      OTHER_SECRET: SECRET,
    })
    expect(response?.status).toBe(500)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      level: 'error',
      event: 'env.invalid',
      missing: [],
      invalid: ['HYPERDRIVE'],
    })
    expect(logged).not.toContain(SECRET)
  })

  it('缺少 Workflow / Queue 绑定时返回 500 并列出绑定名', () => {
    const error = captureErrors()
    const { AI_MEDIA_WORKFLOW: _, ...env } = completeEnv()
    const response = checkEnv({ ...env, EMAIL_QUEUE: {} })
    expect(response?.status).toBe(500)
    expect(JSON.parse(error.mock.calls.flat().join(' '))).toEqual({
      level: 'error',
      event: 'env.invalid',
      missing: ['AI_MEDIA_WORKFLOW'],
      invalid: ['EMAIL_QUEUE'],
    })
  })

  it('缺少 KV / Rate Limiting 绑定与认证变量时一并列出（按模板配置要求）', () => {
    const error = captureErrors()
    const {
      CACHE: _c,
      RL_AUTH: _r,
      RL_AI: _a,
      BETTER_AUTH_SECRET: _s,
      GITHUB_CLIENT_SECRET: _g,
      TURNSTILE_SITE_KEY: _k,
      ...env
    } = completeEnv()
    const response = checkEnv({ ...env, TURNSTILE_SECRET_KEY: '' })
    expect(response?.status).toBe(500)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged)).toEqual({
      level: 'error',
      event: 'env.invalid',
      missing: [
        'BETTER_AUTH_SECRET',
        'CACHE',
        'GITHUB_CLIENT_SECRET',
        'RL_AI',
        'RL_AUTH',
        'TURNSTILE_SITE_KEY',
      ],
      invalid: ['TURNSTILE_SECRET_KEY'],
    })
    expect(logged).not.toContain('google-secret')
  })

  it('配置齐全时放行', () => {
    const error = captureErrors()
    const env = completeEnv()
    expect(checkEnv(env)).toBeNull()
    expect(checkEnv(env)).toBeNull()
    expect(error).not.toHaveBeenCalled()
  })

  it('非法文本出口在请求入口拒绝，日志只含字段名', () => {
    const error = captureErrors()
    expect(checkEnv({ ...completeEnv(), AI_TEXT_EGRESS: 'private-invalid' })?.status).toBe(500)
    const logged = error.mock.calls.flat().join(' ')
    expect(JSON.parse(logged).invalid).toEqual(['AI_TEXT_EGRESS'])
    expect(logged).not.toContain('private-invalid')
    expect(checkEnv({ ...completeEnv(), AI_TEXT_EGRESS: 'direct' })).toBeNull()
  })

  it('支付模式由入口工厂校验，不阻断公开页面', () => {
    expect(checkEnv({ ...completeEnv(), PAYMENT_MODE: 'invalid' })).toBeNull()
    expect(checkEnv({ ...completeEnv(), SENTRY_ENVIRONMENT: 'production' })).toBeNull()
  })

  it('故障开关只允许 staging enabled，生产 disabled 和未知环境开启均安全拒绝', () => {
    const error = captureErrors()
    for (const env of [
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'disabled', SENTRY_ENVIRONMENT: 'production' },
      { AI_FAULT_INJECTION: 'enabled' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'private-unknown' },
      { AI_FAULT_INJECTION: 'private-invalid', SENTRY_ENVIRONMENT: 'staging' },
    ])
      expect(checkEnv({ ...completeEnv(), ...env })?.status).toBe(500)
    for (const [logged] of error.mock.calls) {
      expect(JSON.parse(String(logged)).invalid).toEqual(['AI_FAULT_INJECTION'])
      expect(logged).not.toContain('private-')
    }
    for (const env of [
      { AI_FAULT_INJECTION: 'disabled' },
      { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'staging' },
    ])
      expect(checkEnv({ ...completeEnv(), ...env })).toBeNull()
  })
})

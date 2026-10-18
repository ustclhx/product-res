import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let createPaymentRuntime: typeof import('./runtime.ts').createPaymentRuntime

beforeEach(async () => {
  // 重载模块模拟新的 isolate，不为测试暴露生产告警状态的重置接口。
  vi.resetModules()
  const runtime = await import('./runtime.ts')
  createPaymentRuntime = runtime.createPaymentRuntime
})

afterEach(() => vi.restoreAllMocks())

it('keeps missing payment configuration offline', () => {
  const fetch = vi.fn()
  const warn = vi.fn()
  expect(
    createPaymentRuntime({ PAYMENT_MODE: 'test' }, ['stripe', 'paypal'], { fetch, warn }).readiness,
  ).toEqual([
    { id: 'stripe', available: false },
    { id: 'paypal', available: false },
  ])
  expect(warn.mock.calls).toEqual([
    ['stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']],
    ['paypal', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID']],
  ])
  expect(fetch).not.toHaveBeenCalled()
})

it('warns only about missing PayPal credentials when a client ID is configured', () => {
  const warn = vi.fn()
  const runtime = createPaymentRuntime(
    { PAYMENT_MODE: 'test', PAYPAL_CLIENT_ID: 'client-fixture' },
    ['paypal'],
    {
      warn,
    },
  )
  expect(runtime.readiness).toEqual([{ id: 'paypal', available: false }])
  expect(warn).toHaveBeenCalledExactlyOnceWith('paypal', [
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ])
})

it('does not warn or perform requests when both enabled providers are configured', () => {
  const warn = vi.fn()
  const fetch = vi.fn()
  const runtime = createPaymentRuntime(
    {
      PAYMENT_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_fixture',
      STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
      PAYPAL_CLIENT_ID: 'client-fixture',
      PAYPAL_CLIENT_SECRET: 'secret-fixture',
      PAYPAL_WEBHOOK_ID: 'webhook-fixture',
    },
    ['stripe', 'paypal'],
    { warn, fetch, cache: { get: vi.fn(), put: vi.fn() } },
  )
  expect(runtime.readiness).toEqual([
    { id: 'stripe', available: true },
    { id: 'paypal', available: true },
  ])
  expect(warn).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('warns once per provider across repeated construction in the same isolate', () => {
  const firstWarn = vi.fn()
  const secondWarn = vi.fn()
  createPaymentRuntime({ PAYMENT_MODE: 'test' }, ['stripe'], { warn: firstWarn })
  createPaymentRuntime({ PAYMENT_MODE: 'test' }, ['stripe', 'paypal'], { warn: secondWarn })
  createPaymentRuntime({ PAYMENT_MODE: 'test' }, ['paypal'], { warn: secondWarn })
  expect(firstWarn).toHaveBeenCalledExactlyOnceWith('stripe', [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
  ])
  expect(secondWarn).toHaveBeenCalledExactlyOnceWith('paypal', [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_WEBHOOK_ID',
  ])
})

it('records default structured warnings containing variable names without credential values', () => {
  const output = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const env = {
    PAYMENT_MODE: 'live',
    STRIPE_SECRET_KEY: 'sk_live_private_fixture',
    PAYPAL_CLIENT_SECRET: 'private-secret-fixture',
    PAYPAL_WEBHOOK_ID: 'private-webhook-fixture',
  }
  createPaymentRuntime(env, ['stripe', 'paypal'])
  expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    {
      level: 'warn',
      event: 'billing.provider_unconfigured',
      mode: 'live',
      provider: 'stripe',
      missing: ['STRIPE_WEBHOOK_SECRET'],
    },
    {
      level: 'warn',
      event: 'billing.provider_unconfigured',
      mode: 'live',
      provider: 'paypal',
      missing: ['PAYPAL_CLIENT_ID'],
    },
  ])
  const lines = JSON.stringify(output.mock.calls)
  for (const value of Object.values({ ...env, PAYMENT_MODE: undefined }).filter(Boolean))
    expect(lines).not.toContain(value)
})

it('does not warn about disabled providers with missing credentials', () => {
  const warn = vi.fn()
  expect(createPaymentRuntime({ PAYMENT_MODE: 'test' }, [], { warn }).readiness).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})

it.each([
  ['test', 'sk_test_fixture', true],
  ['test', 'sk_live_fixture', false],
  ['test', 'rk_live_fixture', false],
  ['test', 'rk_test_fixture', false],
  ['test', 'pk_test_fixture', false],
  ['test', 'invalid_fixture', false],
  ['live', 'sk_test_fixture', false],
  ['live', 'sk_live_fixture', true],
  ['live', 'rk_live_fixture', true],
  ['live', 'rk_test_fixture', false],
  ['live', 'pk_live_fixture', false],
  ['live', 'invalid_fixture', false],
] as const)('validates Stripe key %s/%s before any requests', (mode, key, available) => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetch = vi.fn()
  const create = () =>
    createPaymentRuntime(
      { PAYMENT_MODE: mode, STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_fixture' },
      ['stripe'],
      { fetch },
    )
  if (available) {
    expect(create()).toMatchObject({ mode, readiness: [{ id: 'stripe', available: true }] })
    expect(output).not.toHaveBeenCalled()
  } else {
    expect(create).toThrow(
      expect.objectContaining({ name: 'AppError', code: 'BILLING_UNAVAILABLE', status: 503 }),
    )
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toMatchObject({
      event: 'billing.runtime_invalid',
      invalid: ['STRIPE_SECRET_KEY'],
      mode,
    })
    expect(JSON.stringify(output.mock.calls)).not.toContain(key)
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('defaults missing mode to test only in development', () => {
  const runtime = createPaymentRuntime({ SENTRY_ENVIRONMENT: 'development' }, [], {
    fetch: vi.fn(),
  })
  expect(runtime.mode).toBe('test')
})

it.each(['staging', 'production', 'unknown-private-environment', undefined])(
  'closes payment runtime with 503 when mode is missing in %s',
  (environment) => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetch = vi.fn()
    expect(() =>
      createPaymentRuntime(
        environment === undefined ? {} : { SENTRY_ENVIRONMENT: environment },
        ['stripe', 'paypal'],
        { fetch },
      ),
    ).toThrow(expect.objectContaining({ code: 'BILLING_UNAVAILABLE', status: 503 }))
    expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual({
      level: 'error',
      event: 'billing.runtime_invalid',
      missing: ['PAYMENT_MODE'],
      invalid: [],
      mode: 'missing',
      environment:
        environment === 'staging' || environment === 'production' ? environment : 'unknown',
    })
    expect(fetch).not.toHaveBeenCalled()
  },
)

it('logs only safe labels for invalid mode and environment values', () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetch = vi.fn()
  const env = {
    PAYMENT_MODE: 'private-invalid-mode',
    SENTRY_ENVIRONMENT: 'private-environment',
    STRIPE_SECRET_KEY: 'private-stripe-key',
    PAYPAL_CLIENT_SECRET: 'private-paypal-secret',
  }
  expect(() => createPaymentRuntime(env, ['stripe', 'paypal'], { fetch })).toThrow(
    expect.objectContaining({ code: 'BILLING_UNAVAILABLE', status: 503 }),
  )
  expect(JSON.parse(output.mock.calls[0]?.[0] as string)).toEqual({
    level: 'error',
    event: 'billing.runtime_invalid',
    missing: [],
    invalid: ['PAYMENT_MODE'],
    mode: 'invalid',
    environment: 'unknown',
  })
  for (const value of Object.values(env))
    expect(JSON.stringify(output.mock.calls)).not.toContain(value)
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps the cache requirement for fully configured PayPal', () => {
  expect(() =>
    createPaymentRuntime(
      {
        PAYMENT_MODE: 'live',
        PAYPAL_CLIENT_ID: 'client-fixture',
        PAYPAL_CLIENT_SECRET: 'secret-fixture',
        PAYPAL_WEBHOOK_ID: 'webhook-fixture',
      },
      ['paypal'],
    ),
  ).toThrow(expect.objectContaining({ name: 'EnvValidationError', invalid: ['CACHE'] }))
})

it.each([
  ['test', 'sandbox', 'https://api-m.sandbox.paypal.com'],
  ['live', 'live', 'https://api-m.paypal.com'],
] as const)(
  'uses %s PayPal origin, cache namespace and webhook ID',
  async (mode, environment, origin) => {
    const sub = { id: 'I-SUB', plan_id: 'P-PLAN', status: 'ACTIVE', billing_info: {} }
    const event = {
      id: 'WH-EVENT',
      event_type: 'BILLING.SUBSCRIPTION.UPDATED',
      create_time: '2026-01-01T00:00:00Z',
      resource: { id: 'I-SUB' },
    }
    const paths: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe(origin)
      paths.push(url.pathname)
      let body: unknown
      if (url.pathname === '/v1/oauth2/token') {
        expect(init?.headers).toMatchObject({
          Authorization: `Basic ${btoa('client-fixture:secret-fixture')}`,
        })
        body = { access_token: 'offline-token', expires_in: 3600 }
      } else if (url.pathname === '/v1/notifications/verify-webhook-signature') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ webhook_id: `webhook-${mode}` })
        body = { verification_status: 'SUCCESS' }
      } else if (url.pathname === '/v1/billing/subscriptions/I-SUB') body = sub
      else throw new Error('Unexpected offline request')
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
    })
    const cacheValues = new Map<string, string>()
    const cache = {
      get: vi.fn(async (key: string) => cacheValues.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        cacheValues.set(key, value)
      }),
    }
    const runtime = createPaymentRuntime(
      {
        PAYMENT_MODE: mode,
        PAYPAL_CLIENT_ID: 'client-fixture',
        PAYPAL_CLIENT_SECRET: 'secret-fixture',
        PAYPAL_WEBHOOK_ID: `webhook-${mode}`,
      },
      ['paypal'],
      { fetch, cache },
    )
    const request = new Request('https://offline.test/webhook', {
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': `${origin}/v1/notifications/certs/CERT`,
        'paypal-transmission-id': 'TRANSMISSION',
        'paypal-transmission-sig': 'SIGNATURE',
        'paypal-transmission-time': event.create_time,
      },
    })
    const verified = await runtime.providers.paypal?.verifyWebhook(request, JSON.stringify(event))
    expect(verified?.events[0]).toMatchObject({ type: 'subscription.updated' })
    expect(await runtime.normalizers.paypal?.(event)).toEqual(verified)
    expect(await runtime.providers.paypal?.getSubscription('I-SUB')).toMatchObject({
      providerSubscriptionId: 'I-SUB',
    })
    expect(paths).toEqual([
      '/v1/oauth2/token',
      '/v1/notifications/verify-webhook-signature',
      '/v1/billing/subscriptions/I-SUB',
      '/v1/billing/subscriptions/I-SUB',
      '/v1/billing/subscriptions/I-SUB',
    ])
    expect(cache.get).toHaveBeenCalledWith(`paypal:oauth:v1:${environment}:client-fixture`)
    expect(cache.put.mock.calls[0]?.[0]).toBe(`paypal:oauth:v1:${environment}:client-fixture`)
  },
)

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvValidationError } from './env.ts'
import {
  loadNodeEnv,
  nodeEmailTransportConfig,
  nodeSecretNames,
  nodeStorageConfig,
} from './node.ts'
import { defineTemplateConfig, templateConfigDefaults } from './template.ts'

const valid = {
  DATABASE_URL: 'postgres://fixture:fixture@localhost/test',
  VALKEY_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'test-auth-secret-with-at-least-32-characters',
  APP_URL: 'https://example.test',
}
const directories: string[] = []
const storage = {
  S3_ENDPOINT: 'https://objects.example.test',
  S3_REGION: 'auto',
  S3_BUCKET: 'fixture',
  S3_ACCESS_KEY_ID: 'fixture-access',
  S3_SECRET_ACCESS_KEY: 'fixture-secret',
}
const smtp = {
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '2525',
  EMAIL_FROM: 'Fixture <mail@example.test>',
  EMAIL_REPLY_TO: 'help@example.test',
}
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'node-config-'))
  directories.push(path)
  return path
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true })
})
function failure(fn: () => unknown, names: string[], values: string[]) {
  let error: unknown
  try {
    fn()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(EnvValidationError)
  const safe = error as EnvValidationError
  expect([...safe.missing, ...safe.invalid].sort()).toEqual(names.sort())
  const visible = [String(safe), safe.stack, JSON.stringify(safe)].join('\n')
  for (const value of values) expect(visible).not.toContain(value)
}

describe('Node runtime config', () => {
  it('全关模板无需支付模式、支付或 AI 密钥即可加载基础运行环境', () => {
    const templateConfig = defineTemplateConfig({
      app: { name: 'Tool', url: valid.APP_URL, supportEmail: 'support@example.test' },
      auth: { oauth: [], turnstile: false },
      billing: { enabled: false },
      credits: { enabled: false },
      marketing: { enabled: false },
      i18n: { enabled: false },
      ai: { text: { enabled: false }, image: false, video: false },
    })
    const loaded = loadNodeEnv({ dotenvPath: false, env: valid, templateConfig })
    expect(loaded.APP_URL).toBe(valid.APP_URL)
    expect(loaded.PAYMENT_MODE).toBeUndefined()
    expect(loaded.STRIPE_SECRET_KEY).toBeUndefined()
    expect(loaded.PAYPAL_CLIENT_SECRET).toBeUndefined()
    expect(loaded.OPENAI_API_KEY).toBeUndefined()
  })

  it('两种 Node schema 保留故障闸门，仅 staging 开启并安全拒绝生产配置和非法值', () => {
    const auth = { ...templateConfigDefaults.auth, oauth: [], turnstile: false }
    for (const templateConfig of [undefined, { auth }]) {
      const load = (env: Record<string, string>) =>
        loadNodeEnv({
          dotenvPath: false,
          env: { ...valid, ...env },
          ...(templateConfig ? { templateConfig } : {}),
        })
      expect(load({}).AI_FAULT_INJECTION).toBeUndefined()
      expect(load({ AI_FAULT_INJECTION: 'disabled' }).AI_FAULT_INJECTION).toBe('disabled')
      expect(
        load({ AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'staging' }).AI_FAULT_INJECTION,
      ).toBe('enabled')
      for (const env of [
        { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'production' },
        { AI_FAULT_INJECTION: 'disabled', SENTRY_ENVIRONMENT: 'production' },
        { AI_FAULT_INJECTION: 'enabled' },
        { AI_FAULT_INJECTION: 'enabled', SENTRY_ENVIRONMENT: 'development' },
        { AI_FAULT_INJECTION: 'private-invalid', SENTRY_ENVIRONMENT: 'staging' },
      ])
        failure(() => load(env), ['AI_FAULT_INJECTION'], ['private-invalid'])
    }
  })
  it('S3 原始配置启用校验，全部缺省保持 unavailable，布尔严格且两种 schema 一致', () => {
    const auth = { ...templateConfigDefaults.auth, oauth: [], turnstile: false }
    for (const templateConfig of [undefined, { auth }]) {
      const load = (env: Record<string, string>) =>
        loadNodeEnv({
          dotenvPath: false,
          env: { ...valid, ...env },
          ...(templateConfig ? { templateConfig } : {}),
        })
      expect(nodeStorageConfig(load({}))).toBeUndefined()
      expect(load({}).S3_FORCE_PATH_STYLE).toBe(true)
      for (const key of Object.keys(storage)) {
        const partial = { ...storage }
        delete partial[key as keyof typeof storage]
        failure(() => load(partial), [key], [])
      }
      failure(() => load({ S3_FORCE_PATH_STYLE: 'false' }), Object.keys(storage), [])
      expect(nodeStorageConfig(load(storage))).toEqual({
        endpoint: storage.S3_ENDPOINT,
        region: 'auto',
        bucket: 'fixture',
        accessKeyId: 'fixture-access',
        secretAccessKey: 'fixture-secret',
        forcePathStyle: true,
      })
      expect(
        nodeStorageConfig(load({ ...storage, S3_FORCE_PATH_STYLE: 'false' }))?.forcePathStyle,
      ).toBe(false)
      failure(() => load({ ...storage, S3_FORCE_PATH_STYLE: '1' }), ['S3_FORCE_PATH_STYLE'], [])
    }
  })

  it('S3 endpoint 拒绝非 HTTP(S)、内嵌凭据、query/fragment，生产强制 HTTPS且不泄漏值', () => {
    const load = (S3_ENDPOINT: string, SENTRY_ENVIRONMENT = 'staging') =>
      loadNodeEnv({
        dotenvPath: false,
        env: { ...valid, ...storage, S3_ENDPOINT, SENTRY_ENVIRONMENT },
      })
    expect(load('http://localhost:8333').S3_ENDPOINT).toBe('http://localhost:8333')
    for (const endpoint of [
      'ftp://objects.test',
      'https://user:private@objects.test',
      'https://objects.test?signature=private',
      'https://objects.test#private',
      'invalid-private',
    ]) {
      failure(() => load(endpoint), ['S3_ENDPOINT'], [endpoint])
    }
    failure(
      () => load('http://objects.test', 'production'),
      ['S3_ENDPOINT'],
      ['http://objects.test'],
    )
  })

  it('Node smtp 配置无 Resend 依赖，两种 schema 保持通道/必需项与认证配对校验', () => {
    const auth = { ...templateConfigDefaults.auth, oauth: [], turnstile: false }
    for (const templateConfig of [undefined, { auth }]) {
      const load = (env: Record<string, string>) =>
        loadNodeEnv({
          dotenvPath: false,
          env: { ...valid, ...env },
          ...(templateConfig ? { templateConfig } : {}),
        })
      expect(nodeEmailTransportConfig(load(smtp))).toEqual({
        transport: 'smtp',
        host: 'localhost',
        port: 2525,
        tlsMode: 'starttls',
        from: smtp.EMAIL_FROM,
        replyTo: smtp.EMAIL_REPLY_TO,
      })
      failure(() => load({ EMAIL_TRANSPORT: 'smtp' }), ['SMTP_HOST', 'SMTP_PORT', 'EMAIL_FROM'], [])
      failure(
        () => load({ ...smtp, SMTP_USER: 'fixture-user' }),
        ['SMTP_PASSWORD'],
        ['fixture-user'],
      )
      failure(
        () => load({ ...smtp, SMTP_PASSWORD: 'fixture-password' }),
        ['SMTP_USER'],
        ['fixture-password'],
      )
      expect(
        nodeEmailTransportConfig(
          load({
            ...smtp,
            SMTP_USER: 'fixture-user',
            SMTP_PASSWORD: 'fixture-password',
            SMTP_TLS_MODE: 'implicit',
          }),
        ),
      ).toMatchObject({ user: 'fixture-user', password: 'fixture-password', tlsMode: 'implicit' })
      expect(nodeEmailTransportConfig(load({ ...smtp, SMTP_TLS_MODE: 'none' }))).toMatchObject({
        tlsMode: 'none',
      })
      expect(nodeEmailTransportConfig(load({}))).toEqual({ transport: 'log' })
      expect(
        nodeEmailTransportConfig(
          load({ ...smtp, EMAIL_FROM: '"Example, Inc" <mail@example.test>' }),
        ),
      ).toMatchObject({ from: '"Example, Inc" <mail@example.test>' })
      expect(
        nodeEmailTransportConfig(
          load({
            EMAIL_TRANSPORT: 'resend',
            EMAIL_FROM: smtp.EMAIL_FROM,
            RESEND_API_KEY: 'fixture-resend',
          }),
        ),
      ).toMatchObject({ transport: 'resend', apiKey: 'fixture-resend' })
    }
  })

  it('SMTP 拒绝 URL host、非法端口/TLS、空认证及多邮箱/换行注入', () => {
    const cases = {
      SMTP_HOST: ['https://private.test', 'user@private.test', 'private.test/path', 'host name'],
      SMTP_PORT: ['', '0', '65536', '1.5', 'private-port'],
      SMTP_TLS_MODE: ['private-mode'],
      SMTP_USER: [''],
      SMTP_PASSWORD: [''],
      EMAIL_FROM: [
        'one@example.test,two@example.test',
        'Name\r\n <one@example.test>',
        'private-invalid',
      ],
      EMAIL_REPLY_TO: ['one@example.test;two@example.test'],
    }
    for (const [key, values] of Object.entries(cases)) {
      for (const value of values)
        failure(
          () =>
            loadNodeEnv({
              dotenvPath: false,
              env: {
                ...valid,
                ...smtp,
                SMTP_USER: 'fixture-user',
                SMTP_PASSWORD: 'fixture-password',
                [key]: value,
              },
            }),
          [key],
          value.includes('private') ? [value] : [],
        )
    }
    for (const host of ['mail.example.test', '127.0.0.1', '::1'])
      expect(
        loadNodeEnv({ dotenvPath: false, env: { ...valid, ...smtp, SMTP_HOST: host } }).SMTP_HOST,
      ).toBe(host)
  })

  it('Sentry 环境可选无默认，空 DSN关闭，非法 DSN/环境和生产HTTP拒绝且不泄漏值', () => {
    const load = (env: Record<string, string>) =>
      loadNodeEnv({ dotenvPath: false, env: { ...valid, ...env } })
    expect(load({}).SENTRY_ENVIRONMENT).toBeUndefined()
    expect(load({ SENTRY_DSN: '' }).SENTRY_DSN).toBe('')
    expect(
      load({ SENTRY_DSN: 'http://public@localhost/1', SENTRY_ENVIRONMENT: 'smoke' }).SENTRY_DSN,
    ).toBe('http://public@localhost/1')
    for (const dsn of [
      'private-invalid',
      'ftp://public@host.test/1',
      'https://host.test/1',
      'https://public:password@host.test/1',
      'https://private-key@host.test/1',
      'https://public@host.test/project',
      'https://public@host.test/1?private=query',
      'https://public@host.test/1#private',
    ])
      failure(() => load({ SENTRY_DSN: dsn }), ['SENTRY_DSN'], [dsn])
    failure(
      () => load({ SENTRY_DSN: 'http://public@host.test/1', SENTRY_ENVIRONMENT: 'production' }),
      ['SENTRY_DSN'],
      ['http://public@host.test/1'],
    )
    failure(
      () => load({ SENTRY_ENVIRONMENT: 'private-env' }),
      ['SENTRY_ENVIRONMENT'],
      ['private-env'],
    )
  })

  it('新增 _FILE 仅限 S3 两凭据、SMTP password、Sentry DSN，复用冲突与不可读/空文件拒绝', () => {
    const dir = directory()
    const path = join(dir, 'secret')
    const empty = join(dir, 'empty')
    writeFileSync(empty, '\n')
    for (const [key, value, config] of [
      ['S3_ACCESS_KEY_ID', storage.S3_ACCESS_KEY_ID, storage],
      ['S3_SECRET_ACCESS_KEY', storage.S3_SECRET_ACCESS_KEY, storage],
      ['SMTP_PASSWORD', 'fixture-password', { ...smtp, SMTP_USER: 'fixture-user' }],
      ['SENTRY_DSN', 'https://public@host.test/1', {}],
    ] as const) {
      writeFileSync(path, `${value}\n`)
      const source: Record<string, string | undefined> = {
        ...valid,
        ...config,
        [key]: undefined,
        [`${key}_FILE`]: path,
      }
      expect(loadNodeEnv({ dotenvPath: false, env: source })[key]).toBe(value)
      failure(
        () => loadNodeEnv({ dotenvPath: false, env: { ...source, [key]: value } }),
        [key],
        [value, path],
      )
      for (const file of [empty, join(dir, 'missing')])
        failure(
          () => loadNodeEnv({ dotenvPath: false, env: { ...source, [`${key}_FILE`]: file } }),
          [key],
          [file, 'ENOENT'],
        )
    }
    for (const key of [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
    ])
      expect(nodeSecretNames).not.toContain(key)
    expect(
      nodeStorageConfig(
        loadNodeEnv({
          dotenvPath: false,
          env: { ...valid, S3_ENDPOINT_FILE: '/unreadable', SMTP_HOST_FILE: '/unreadable' },
        }),
      ),
    ).toBeUndefined()
  })

  it('Node 文本出口默认 direct，可显式选择 gateway，非法值启动失败且脱敏', () => {
    expect(loadNodeEnv({ dotenvPath: false, env: valid }).AI_TEXT_EGRESS).toBe('direct')
    expect(
      loadNodeEnv({ dotenvPath: false, env: { ...valid, AI_TEXT_EGRESS: 'gateway' } })
        .AI_TEXT_EGRESS,
    ).toBe('gateway')
    failure(
      () =>
        loadNodeEnv({ dotenvPath: false, env: { ...valid, AI_TEXT_EGRESS: 'private-invalid' } }),
      ['AI_TEXT_EGRESS'],
      ['private-invalid'],
    )
  })
  it('使用 dotenv 语法且进程环境优先，不改变 process.env，不要求 CF 或可选集成', () => {
    const path = join(directory(), '.env')
    writeFileSync(
      path,
      'export CACHE_NAMESPACE="fixture # quoted"\nDB_POOL_MAX=2\nPAYMENT_MODE=invalid\n',
    )
    const before = { ...process.env }
    const env = loadNodeEnv({ dotenvPath: path, env: { ...valid, DB_POOL_MAX: '3' } })
    expect(env.DB_POOL_MAX).toBe(3)
    expect(env.CACHE_NAMESPACE).toBe('fixture # quoted')
    // 模式仍由支付入口拒绝；配置错误不阻断公开页面和认证。
    expect(env.PAYMENT_MODE).toBe('invalid')
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.TURNSTILE_SECRET_KEY).toBeUndefined()
    expect(env).not.toHaveProperty('HYPERDRIVE')
    expect(process.env).toEqual(before)
  })

  it('仅启用的 OAuth、Turnstile 和邮件通道要求凭据', () => {
    const disabled = { auth: { ...templateConfigDefaults.auth, oauth: [], turnstile: false } }
    expect(loadNodeEnv({ dotenvPath: false, env: valid, templateConfig: disabled }).APP_URL).toBe(
      valid.APP_URL,
    )
    failure(
      () =>
        loadNodeEnv({
          dotenvPath: false,
          env: valid,
          templateConfig: { auth: { ...disabled.auth, oauth: ['google'], turnstile: true } },
        }),
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'],
      [],
    )
    failure(
      () => loadNodeEnv({ dotenvPath: false, env: { ...valid, EMAIL_TRANSPORT: 'resend' } }),
      ['RESEND_API_KEY', 'EMAIL_FROM'],
      [],
    )
  })

  it('声明的文件密钥仅去掉一个末尾换行，输出剔除文件路径及无关变量', () => {
    const path = join(directory(), 'auth')
    const value = ` ${valid.BETTER_AUTH_SECRET} \n`
    writeFileSync(path, `${value}\r\n`)
    const { BETTER_AUTH_SECRET: _, ...env } = valid
    const loaded = loadNodeEnv({
      dotenvPath: false,
      env: {
        ...env,
        BETTER_AUTH_SECRET_FILE: path,
        UNKNOWN_FILE: '/unreadable',
        VITE_SECRET: 'private',
      },
    })
    expect(loaded.BETTER_AUTH_SECRET).toBe(value)
    expect(
      Object.keys(loaded).some((key) => key.endsWith('_FILE') || key.startsWith('VITE_')),
    ).toBe(false)
  })

  it('dotenv 和进程环境合并后直接值与 _FILE 冲突（包括空直接值）', () => {
    const path = join(directory(), '.env')
    writeFileSync(path, 'BETTER_AUTH_SECRET_FILE=/private/runtime/auth\n')
    for (const value of [valid.BETTER_AUTH_SECRET, '']) {
      failure(
        () => loadNodeEnv({ dotenvPath: path, env: { ...valid, BETTER_AUTH_SECRET: value } }),
        ['BETTER_AUTH_SECRET'],
        [valid.BETTER_AUTH_SECRET, '/private/runtime/auth'],
      )
    }
  })

  it('不可读或空文件仅报告变量名，无文件路径、内容或底层错误', () => {
    const dir = directory()
    const empty = join(dir, 'empty')
    writeFileSync(empty, '\n')
    const { BETTER_AUTH_SECRET: _, ...env } = valid
    for (const path of [join(dir, 'missing'), dir, empty, '']) {
      failure(
        () => loadNodeEnv({ dotenvPath: false, env: { ...env, BETTER_AUTH_SECRET_FILE: path } }),
        ['BETTER_AUTH_SECRET'],
        [dir, 'ENOENT', 'EISDIR'],
      )
    }
  })

  it('显式 dotenv 不可读会失败且隐藏路径', () => {
    const path = join(directory(), 'missing')
    failure(() => loadNodeEnv({ dotenvPath: path, env: valid }), ['DOTENV'], [path, 'ENOENT'])
  })

  it('必需 URL、secret 和池上限非法时只报告字段名', () => {
    const env = {
      ...valid,
      DATABASE_URL: 'https://private-database-host',
      VALKEY_URL: 'postgres://private-cache-host',
      BETTER_AUTH_SECRET: 'private-short-secret',
      APP_URL: 'http://example.test',
      DB_POOL_MAX: '0',
    }
    failure(
      () => loadNodeEnv({ dotenvPath: false, env }),
      ['DATABASE_URL', 'VALKEY_URL', 'BETTER_AUTH_SECRET', 'APP_URL', 'DB_POOL_MAX'],
      [
        'private-database-host',
        'private-cache-host',
        'private-short-secret',
        'http://example.test',
      ],
    )
    failure(() => loadNodeEnv({ dotenvPath: false, env: {} }), Object.keys(valid), [])
  })

  it('真实 Node 启动先校验，非法配置非零退出且未执行 listen', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import { loadNodeEnv } from ${JSON.stringify(new URL('./node.ts', import.meta.url).href)};
       import { createServer } from 'node:http';
       try { loadNodeEnv({ dotenvPath: false, env: { DATABASE_URL: 'private-invalid-input' } }); }
       catch (error) { console.error(error.message); process.exit(1); }
       createServer().listen(0, () => console.log('LISTENED'));`,
      ],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Invalid environment:')
    expect(result.stderr).toContain('DATABASE_URL')
    expect(result.stderr).not.toContain('private-invalid-input')
    expect(result.stdout).not.toContain('LISTENED')
  })
})

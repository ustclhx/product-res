import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ALLOW_DEV_DATABASE_ENV,
  assertIsolatedTestDatabase,
  isIsolatedDatabaseName,
  resolveTestDatabase,
  suggestedDatabaseName,
  TestDatabaseError,
} from './test-database.ts'

const APP = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const MIGRATOR = 'MIGRATION_DATABASE_URL'
const url = (user: string, db: string, host = 'localhost:5432') =>
  `postgres://${user}:${user}@${host}/${db}`
const reader = (values: Record<string, string>) => (name: string) => values[name]
const pair = (db: string) => ({ [APP]: url('app', db), [MIGRATOR]: url('migrator', db) })

afterEach(() => vi.restoreAllMocks())

describe('isIsolatedDatabaseName', () => {
  it('接受 worktree 与一次性测试库，与项目前缀无关', () => {
    for (const name of [
      'product_res_wt_test_db_guard',
      'xuanxue_wt_sync',
      'my_app_wt_a',
      'product_res_test',
      'xuanxue_test_sync',
    ])
      expect(isIsolatedDatabaseName(name, {})).toBe(true)
  })

  it('拒绝开发、staging、生产与无前缀的库名', () => {
    for (const name of [
      'product_res_dev',
      'xuanxue_dev',
      'product_res_staging',
      'product_res_production',
      'postgres',
      '_wt_x',
      'product_res_wt_',
      'product_res_dev_backup',
    ])
      expect(isIsolatedDatabaseName(name, {})).toBe(false)
  })

  it('CI 库只在 CI 环境中视为隔离', () => {
    expect(isIsolatedDatabaseName('product_res_ci', {})).toBe(false)
    expect(isIsolatedDatabaseName('product_res_ci', { CI: 'true' })).toBe(true)
    expect(isIsolatedDatabaseName('xuanxue_ci_e2e', { CI: 'true' })).toBe(true)
    expect(isIsolatedDatabaseName('product_res_dev', { CI: 'true' })).toBe(false)
  })
})

describe('assertIsolatedTestDatabase', () => {
  it('非隔离库默认失败，并说明如何创建隔离库', () => {
    expect(() =>
      assertIsolatedTestDatabase({ migrator: url('migrator', 'product_res_dev') }, 't', {}),
    ).toThrowError(TestDatabaseError)
    try {
      assertIsolatedTestDatabase({ migrator: url('migrator', 'xuanxue_dev') }, 't', {})
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('拒绝在非隔离数据库 xuanxue_dev 上运行测试')
      expect(message).toContain('CREATE DATABASE')
      expect(message).toContain('CI=1 pnpm test')
      expect(message).toContain(`${ALLOW_DEV_DATABASE_ENV}=1`)
    }
  })

  it('app 与 migrator 必须指向同一个库', () => {
    expect(() =>
      assertIsolatedTestDatabase(
        { app: url('app', 'product_res_wt_a'), migrator: url('migrator', 'product_res_wt_b') },
        't',
        {},
      ),
    ).toThrowError(/指向不同的数据库/)
    expect(() =>
      assertIsolatedTestDatabase(
        {
          app: url('app', 'product_res_wt_a'),
          migrator: url('migrator', 'product_res_wt_a', 'other:5432'),
        },
        't',
        {},
      ),
    ).toThrowError(/指向不同的数据库/)
  })

  it('显式开关允许非隔离库并打印警告', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    assertIsolatedTestDatabase({ migrator: url('migrator', 'product_res_dev') }, 't', {
      [ALLOW_DEV_DATABASE_ENV]: '1',
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('product_res_dev'))
    // 只有值为 1 才生效
    expect(() =>
      assertIsolatedTestDatabase({ migrator: url('migrator', 'product_res_dev') }, 't', {
        [ALLOW_DEV_DATABASE_ENV]: 'true',
      }),
    ).toThrowError(TestDatabaseError)
  })
})

describe('suggestedDatabaseName', () => {
  it('按目录名生成隔离库名，且本身通过隔离检查', () => {
    expect(suggestedDatabaseName('/tmp/Template-Sync.v2')).toBe('product_res_wt_template_sync_v2')
    expect(isIsolatedDatabaseName(suggestedDatabaseName('/x/y'), {})).toBe(true)
  })
})

describe('resolveTestDatabase', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'test-database-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true })
  })

  it('隔离库原样返回连接串', () => {
    expect(resolveTestDatabase('t', { env: {}, read: reader(pair('product_res_wt_x')) })).toEqual({
      appUrl: url('app', 'product_res_wt_x'),
      migratorUrl: url('migrator', 'product_res_wt_x'),
    })
  })

  it('CI 中的 product_res_ci 保持可用', () => {
    expect(
      resolveTestDatabase('t', { env: { CI: 'true' }, read: reader(pair('product_res_ci')) }),
    ).toBeDefined()
  })

  it('显式配置非隔离库时失败', () => {
    expect(() =>
      resolveTestDatabase('t', { env: {}, read: reader(pair('product_res_dev')) }),
    ).toThrowError(/拒绝在非隔离数据库 product_res_dev/)
  })

  it('只配置其中一个连接串时失败', () => {
    expect(() =>
      resolveTestDatabase('t', {
        env: {},
        read: reader({ [APP]: url('app', 'product_res_wt_x') }),
      }),
    ).toThrowError(/必须同时配置/)
  })

  it('未配置时：默认跳过集成测试，required 时失败', () => {
    expect(resolveTestDatabase('t', { env: {}, read: reader({}) })).toBeUndefined()
    expect(() =>
      resolveTestDatabase('t', { required: true, env: {}, read: reader({}) }),
    ).toThrowError(/需要隔离数据库/)
  })

  it('devFallback：未配置开发连接串时使用模板隔离库，并打印库名', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(resolveTestDatabase('t', { devFallback: true, env: {}, root })).toEqual({
      appUrl: url('app', 'product_res_test'),
      migratorUrl: url('migrator', 'product_res_test'),
    })
    expect(info).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('product_res_test'))
  })

  it('devFallback：从项目开发连接串推导两种角色的测试连接串', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const web = join(root, 'apps/web')
    mkdirSync(web, { recursive: true })
    writeFileSync(join(root, '.env'), `DATABASE_URL=${url('app', 'other_dev')}\n`)
    writeFileSync(
      join(web, '.dev.vars'),
      `DATABASE_URL="postgres://app:local-app@127.0.0.1:5433/xuanxue_dev?sslmode=require&database=xuanxue_dev"\n` +
        `${MIGRATOR}=postgres://migrator:local-migrator@127.0.0.1:5433/xuanxue_dev\n`,
    )
    expect(resolveTestDatabase('t', { devFallback: true, env: {}, root })).toEqual({
      appUrl: 'postgres://app:local-app@127.0.0.1:5433/xuanxue_test?sslmode=require',
      migratorUrl: 'postgres://migrator:local-migrator@127.0.0.1:5433/xuanxue_test',
    })
    expect(() => resolveTestDatabase('t', { required: true, env: {}, root })).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining('postgres://app:<本地密码>@127.0.0.1:5433/xuanxue_test'),
      }),
    )
  })

  it('devFallback：从本地 Compose 的库名与宿主端口推导连接串', () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const local = join(root, 'infra/local')
    mkdirSync(local, { recursive: true })
    writeFileSync(
      join(local, 'docker-compose.yml'),
      "services:\n  postgres:\n    environment:\n      POSTGRES_DB: project_dev\n    ports:\n      - '127.0.0.1:5433:5432'\n",
    )
    expect(resolveTestDatabase('t', { devFallback: true, env: {}, root })).toEqual({
      appUrl: url('app', 'project_test', 'localhost:5433'),
      migratorUrl: url('migrator', 'project_test', 'localhost:5433'),
    })
  })

  it('devFallback：CI 无连接串时跳过集成测试', () => {
    writeFileSync(join(root, '.env'), `DATABASE_URL=${url('app', 'xuanxue_dev')}\n`)
    expect(
      resolveTestDatabase('t', {
        devFallback: true,
        env: { CI: '1', [ALLOW_DEV_DATABASE_ENV]: '1' },
        root,
      }),
    ).toBeUndefined()
  })

  it('devFallback：显式开关后才使用开发库', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(
      join(root, '.env'),
      `DATABASE_URL=${url('app', 'xuanxue_dev', 'localhost:5433')}\n`,
    )
    expect(
      resolveTestDatabase('t', {
        devFallback: true,
        env: { [ALLOW_DEV_DATABASE_ENV]: '1' },
        root,
      }),
    ).toEqual({
      appUrl: url('app', 'xuanxue_dev', 'localhost:5433'),
      migratorUrl: url('migrator', 'xuanxue_dev', 'localhost:5433'),
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('xuanxue_dev'))
  })
})

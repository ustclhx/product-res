import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { readLocalEnv } from './worktree-env.ts'

/**
 * 测试数据库隔离检查：各包 vitest 配置与 globalSetup 共用。
 * 集成测试会在 globalSetup 中对目标库执行全部迁移并写入夹具，迁移可能不可逆；
 * 曾有衍生项目在没有 .env.worktree 的普通 git worktree 中运行 pnpm test，
 * 旧逻辑回退到主 checkout 的开发库并把新移植的迁移应用了上去。因此默认只接受隔离库。
 */

/** 显式允许在非隔离库（如开发主库）上运行测试的开关，值必须为 1 */
export const ALLOW_DEV_DATABASE_ENV = 'ALLOW_TEST_ON_DEV_DATABASE'

const HYPERDRIVE_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE'
const MIGRATION_ENV = 'MIGRATION_DATABASE_URL'
const LOCAL_COMPOSE = 'infra/local/docker-compose.yml'

// 找不到项目的本地开发连接配置时使用，生成器会替换库名前缀。
const DEV_APP_URL = 'postgres://app:app@localhost:5432/product_res_dev'

type Env = Record<string, string | undefined>

export class TestDatabaseError extends Error {
  override name = 'TestDatabaseError'
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

/**
 * 隔离库判定只看库名后缀，不绑定模板前缀（生成器会把 saas 改为项目名）：
 * - `<前缀>_wt_<名称>`：Orca / scripts/orca/setup.sh 为每个 worktree 创建的库；
 * - `<前缀>_test` 或 `<前缀>_test_<名称>`：手动创建的一次性测试库；
 * - `<前缀>_ci` 或 `<前缀>_ci_<名称>`：仅在 CI 环境变量为真时接受（CI 服务容器）。
 */
export function isIsolatedDatabaseName(name: string, env: Env = process.env): boolean {
  if (/^[a-z0-9_]*[a-z0-9]_wt_[a-z0-9][a-z0-9_]*$/.test(name)) return true
  if (/^[a-z0-9_]*[a-z0-9]_test(?:_[a-z0-9_]+)?$/.test(name)) return true
  return Boolean(env.CI) && /^[a-z0-9_]*[a-z0-9]_ci(?:_[a-z0-9_]+)?$/.test(name)
}

function allowDevDatabase(env: Env): boolean {
  return env[ALLOW_DEV_DATABASE_ENV] === '1'
}

/** 为当前仓库目录建议的隔离库名，与 scripts/orca/lib.sh 的 worktree_db_name 规则一致 */
export function suggestedDatabaseName(root: string = repoRoot()): string {
  const prefix = databaseName(DEV_APP_URL).replace(/_dev$/, '')
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  return `${prefix}_wt_${slug || 'local'}`.slice(0, 63)
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
}

function readLocalFile(root: string, path: string): string {
  const file = join(root, path)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function developmentUrl(value?: string): URL | undefined {
  if (!value || !URL.canParse(value)) return undefined
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) return
  if (/^\/[a-z0-9_]*[a-z0-9]_dev$/.test(url.pathname)) return url
}

function composeDevelopmentUrl(root: string): URL {
  const url = new URL(DEV_APP_URL)
  const compose = readLocalFile(root, LOCAL_COMPOSE)
  // 读取本地 Compose 约定的字面库名和短端口映射，如 '127.0.0.1:5433:5432'。
  const db = compose.match(
    /^[ \t]+POSTGRES_DB:[ \t]*['"]?([a-z0-9_]+_dev)['"]?[ \t]*(?:#.*)?$/m,
  )?.[1]
  const port = compose.match(/^\s+-\s+['"]?(?:[\w.]+:)?(\d+):5432(?:['"]|\s|$)/m)?.[1]
  if (db) url.pathname = db
  if (port) url.port = port
  return url
}

function sameDatabase(app: URL, migrator: URL): boolean {
  return app.host === migrator.host && app.pathname === migrator.pathname
}

function withRole(source: URL, role: 'app' | 'migrator'): URL {
  const url = new URL(source)
  url.username = role
  url.password = role
  return url
}

function localDevelopmentDatabase(root: string): TestDatabase {
  for (const path of ['apps/web/.dev.vars', '.env']) {
    const values = parseEnv(readLocalFile(root, path))
    const app = developmentUrl(values[HYPERDRIVE_ENV]) ?? developmentUrl(values.DATABASE_URL)
    const migrator = developmentUrl(values[MIGRATION_ENV])
    if (app) {
      const matchingMigrator = migrator && sameDatabase(app, migrator) ? migrator : undefined
      return {
        appUrl: app.href,
        migratorUrl: (matchingMigrator ?? withRole(app, 'migrator')).href,
      }
    }
    if (migrator) return { appUrl: withRole(migrator, 'app').href, migratorUrl: migrator.href }
  }
  const app = composeDevelopmentUrl(root)
  return { appUrl: app.href, migratorUrl: withRole(app, 'migrator').href }
}

function localTestDatabase(development: TestDatabase): TestDatabase {
  function testUrl(value: string): string {
    const url = new URL(value)
    url.pathname = url.pathname.replace(/_dev$/, '_test')
    // postgres.js 会将 query 中的 database 传给服务端，覆盖路径指定的库名。
    for (const key of [...url.searchParams.keys()]) {
      if (/^(database|dbname)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  }
  return { appUrl: testUrl(development.appUrl), migratorUrl: testUrl(development.migratorUrl) }
}

function isLinkedWorktree(root: string): boolean {
  try {
    const [gitDir, commonDir] = execFileSync(
      'git',
      ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .split('\n')
    return Boolean(gitDir && commonDir && gitDir !== commonDir)
  } catch {
    return false
  }
}

function exampleUrl(value: string, role: 'app' | 'migrator'): string {
  const url = new URL(value)
  const password = url.password === role ? role : '<本地密码>'
  return `${url.protocol}//${url.username || role}:${password}@${url.host}${url.pathname}`
}

function isolationHelp(
  label: string,
  reason: string,
  root = repoRoot(),
  test = localTestDatabase(localDevelopmentDatabase(root)),
): string {
  const db = databaseName(test.appUrl)
  const target = new URL(test.appUrl)
  const port = target.port || '5432'
  const compose = composeDevelopmentUrl(root)
  const psql =
    existsSync(join(root, LOCAL_COMPOSE)) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) &&
    port === compose.port
      ? `docker compose -f ${LOCAL_COMPOSE} exec -T postgres psql`
      : `psql -h '${target.hostname.replaceAll("'", "'\\''")}' -p ${port}`
  const orca = existsSync(join(root, 'scripts/orca/setup.sh'))
  return [
    `[${label}] ${reason}`,
    '集成测试会在 globalSetup 中应用迁移并写入数据。默认接受 <项目>_wt_*、<项目>_test，CI 另接受 <项目>_ci。',
    ...(orca && isLinkedWorktree(root)
      ? [
          `在 linked worktree 的仓库根可运行 bash scripts/orca/setup.sh，创建 ${suggestedDatabaseName(root)} 并写入 .env.worktree。`,
        ]
      : orca
        ? [
            '主 checkout 请创建下面的测试库。不要运行 Orca setup.sh，它会写入 .env.worktree 并把开发服务器切到 wt 库。',
          ]
        : []),
    `在仓库根执行以下命令，在 ${target.hostname}:${port} 创建并授权 ${db}：`,
    `  ${psql} -v ON_ERROR_STOP=1 -U postgres -d postgres -c 'CREATE DATABASE "${db}"'`,
    `  ${psql} -v ON_ERROR_STOP=1 -U postgres -d ${db} < infra/local/initdb/02-db-grants.sql`,
    '如需显式配置，在当前 shell 导出指向同一隔离库的两个变量：',
    `  ${HYPERDRIVE_ENV}=${exampleUrl(test.appUrl, 'app')}`,
    `  ${MIGRATION_ENV}=${exampleUrl(test.migratorUrl, 'migrator')}`,
    '未配置连接串时，使用 CI=1 pnpm test 只运行单元测试。',
    `确认要在开发库上运行时，使用 ${ALLOW_DEV_DATABASE_ENV}=1 pnpm test（会应用全部迁移）。`,
  ].join('\n')
}

/** 仅为缺失的本地回落库补充建库说明，不改变其他连接错误。 */
export function missingLocalTestDatabaseError(
  label: string,
  migratorUrl: string,
): TestDatabaseError | undefined {
  if (process.env.CI) return undefined
  const root = repoRoot()
  const test = localTestDatabase(localDevelopmentDatabase(root))
  if (!sameDatabase(new URL(migratorUrl), new URL(test.migratorUrl))) return undefined
  return new TestDatabaseError(
    isolationHelp(label, `本地测试库 ${databaseName(migratorUrl)} 不存在`, root, test),
  )
}

/**
 * 校验测试将连接的库：每个 URL 都必须是隔离库，同时给出 app 与 migrator 时二者须指向同一个库。
 * 设置 ALLOW_TEST_ON_DEV_DATABASE=1 时只打印警告。
 */
export function assertIsolatedTestDatabase(
  urls: { app?: string | undefined; migrator?: string | undefined },
  label: string,
  env: Env = process.env,
  root = repoRoot(),
): void {
  const given = [urls.app, urls.migrator].filter((url): url is string => Boolean(url))
  if (urls.app && urls.migrator) {
    const app = new URL(urls.app)
    const migrator = new URL(urls.migrator)
    if (!sameDatabase(app, migrator))
      throw new TestDatabaseError(
        isolationHelp(label, `${HYPERDRIVE_ENV} 与 ${MIGRATION_ENV} 指向不同的数据库`, root),
      )
  }
  const shared = given.map(databaseName).filter((name) => !isIsolatedDatabaseName(name, env))
  if (!shared.length) return
  const names = [...new Set(shared)].join('、')
  if (allowDevDatabase(env)) {
    console.warn(`[${label}] ${ALLOW_DEV_DATABASE_ENV}=1：在非隔离库 ${names} 上运行测试`)
    return
  }
  throw new TestDatabaseError(isolationHelp(label, `拒绝在非隔离数据库 ${names} 上运行测试`, root))
}

export interface TestDatabase {
  appUrl: string
  migratorUrl: string
}

export interface ResolveTestDatabaseOptions {
  /** 未配置时本地回落到 <项目>_test，显式允许时回落到开发库；CI 中跳过 */
  devFallback?: boolean
  /** 必须有数据库（Node 验收等不允许退化为离线测试） */
  required?: boolean
  env?: Env
  read?: (name: string) => string | undefined
  /** 本地配置所在的仓库根目录 */
  root?: string
}

/**
 * 解析测试使用的 app / migrator 连接串：环境变量 → .env.worktree。
 * 都未配置时返回 undefined（只跑单元测试）；required 时报错；devFallback 时见选项说明。
 * 返回值已通过隔离检查。
 */
export function resolveTestDatabase(
  label: string,
  options: ResolveTestDatabaseOptions = {},
): TestDatabase | undefined {
  const env = options.env ?? process.env
  const root = options.root ?? repoRoot()
  const read = options.read ?? ((name) => readLocalEnv(name, env, root))
  const appUrl = read(HYPERDRIVE_ENV)
  const migratorUrl = read(MIGRATION_ENV)
  if (!appUrl && !migratorUrl) {
    if (options.required)
      throw new TestDatabaseError(
        isolationHelp(label, '该测试需要隔离数据库，但未配置连接串', root),
      )
    if (!options.devFallback || env.CI) return undefined
    const development = localDevelopmentDatabase(root)
    const useDev = allowDevDatabase(env)
    const test = useDev ? development : localTestDatabase(development)
    assertIsolatedTestDatabase({ app: test.appUrl, migrator: test.migratorUrl }, label, env, root)
    if (!useDev) {
      const url = new URL(test.appUrl)
      console.info(`[${label}] 使用本地回落测试库 ${databaseName(test.appUrl)}（${url.host}）`)
    }
    return test
  }
  if (!appUrl || !migratorUrl)
    throw new TestDatabaseError(
      isolationHelp(label, `${HYPERDRIVE_ENV} 与 ${MIGRATION_ENV} 必须同时配置`, root),
    )
  assertIsolatedTestDatabase({ app: appUrl, migrator: migratorUrl }, label, env, root)
  return { appUrl, migratorUrl }
}

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

// 主 checkout 的开发库：只有显式设置 ALLOW_TEST_ON_DEV_DATABASE=1 时才作为默认值。
// 生成器会把库名前缀改为项目名，与 scripts/orca/lib.sh 的命名保持一致。
const DEV_APP_URL = 'postgres://app:app@localhost:5432/product_res_dev'
const DEV_MIGRATOR_URL = 'postgres://migrator:migrator@localhost:5432/product_res_dev'

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

function isolationHelp(label: string, reason: string): string {
  const root = repoRoot()
  const db = suggestedDatabaseName(root)
  // 衍生项目不含 Orca 生命周期脚本，只在模板仓库中提示 setup.sh
  const orca = existsSync(join(root, 'scripts/orca/setup.sh'))
  return [
    `[${label}] ${reason}`,
    '集成测试会在 globalSetup 中对目标库执行全部迁移并写入测试数据，默认只允许隔离库',
    '（库名形如 <项目>_wt_<名称>、<项目>_test；CI 中另接受 <项目>_ci）。可选做法：',
    '  1. Orca worktree：等待 setup 生成 .env.worktree 后再运行；',
    ...(orca
      ? [
          '  2. 普通 git worktree 或主 checkout：在仓库根运行 bash scripts/orca/setup.sh，创建当前目录专属的',
          `     ${db} 并写入 .env.worktree；用完运行 bash scripts/orca/archive.sh 删除；`,
        ]
      : [
          `  2. 手动创建空库 ${db}（容器名见 infra/local/docker-compose.yml）：`,
          `     docker exec -i <PG 容器> psql -U postgres -c 'CREATE DATABASE "${db}"'`,
          `     docker exec -i <PG 容器> psql -U postgres -d ${db} < infra/local/initdb/02-db-grants.sql`,
          `     再在仓库根的 .env.worktree（已被 Git 忽略）写入 ${HYPERDRIVE_ENV}=postgres://app:app@localhost:5432/${db}`,
          `     与 ${MIGRATION_ENV}=postgres://migrator:migrator@localhost:5432/${db}；用完删除该库与文件；`,
        ]),
    `  3. 或在当前 shell 导出指向同一隔离库的 ${HYPERDRIVE_ENV}（app 账号）与 ${MIGRATION_ENV}（migrator 账号）；`,
    '  4. 只运行单元测试：CI=1 pnpm test（未配置数据库时跳过集成测试，不连接任何库）；',
    `  5. 确认要在该库上运行（会应用全部迁移，可能不可逆）：${ALLOW_DEV_DATABASE_ENV}=1 pnpm test。`,
  ].join('\n')
}

/**
 * 校验测试将连接的库：每个 URL 都必须是隔离库，同时给出 app 与 migrator 时二者须指向同一个库。
 * 设置 ALLOW_TEST_ON_DEV_DATABASE=1 时只打印警告。
 */
export function assertIsolatedTestDatabase(
  urls: { app?: string | undefined; migrator?: string | undefined },
  label: string,
  env: Env = process.env,
): void {
  const given = [urls.app, urls.migrator].filter((url): url is string => Boolean(url))
  if (urls.app && urls.migrator) {
    const app = new URL(urls.app)
    const migrator = new URL(urls.migrator)
    if (app.host !== migrator.host || app.pathname !== migrator.pathname)
      throw new TestDatabaseError(
        isolationHelp(label, `${HYPERDRIVE_ENV} 与 ${MIGRATION_ENV} 指向不同的数据库`),
      )
  }
  const shared = given.map(databaseName).filter((name) => !isIsolatedDatabaseName(name, env))
  if (!shared.length) return
  const names = [...new Set(shared)].join('、')
  if (allowDevDatabase(env)) {
    console.warn(`[${label}] ${ALLOW_DEV_DATABASE_ENV}=1：在非隔离库 ${names} 上运行测试`)
    return
  }
  throw new TestDatabaseError(isolationHelp(label, `拒绝在非隔离数据库 ${names} 上运行测试`))
}

export interface TestDatabase {
  appUrl: string
  migratorUrl: string
}

export interface ResolveTestDatabaseOptions {
  /** 未配置时是否视为旧的开发库默认值：本地失败并提示，设置开关后才使用；CI 中跳过 */
  devFallback?: boolean
  /** 必须有数据库（Node 验收等不允许退化为离线测试） */
  required?: boolean
  env?: Env
  read?: (name: string) => string | undefined
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
  const read = options.read ?? readLocalEnv
  const appUrl = read(HYPERDRIVE_ENV)
  const migratorUrl = read(MIGRATION_ENV)
  if (!appUrl && !migratorUrl) {
    if (options.required)
      throw new TestDatabaseError(isolationHelp(label, '该测试需要隔离数据库，但未配置连接串'))
    if (!options.devFallback || env.CI) return undefined
    if (!allowDevDatabase(env))
      throw new TestDatabaseError(
        isolationHelp(
          label,
          `未找到 .env.worktree，也未设置 ${HYPERDRIVE_ENV} / ${MIGRATION_ENV}，不会回退到开发库 ${databaseName(DEV_APP_URL)}`,
        ),
      )
    assertIsolatedTestDatabase({ app: DEV_APP_URL, migrator: DEV_MIGRATOR_URL }, label, env)
    return { appUrl: DEV_APP_URL, migratorUrl: DEV_MIGRATOR_URL }
  }
  if (!appUrl || !migratorUrl)
    throw new TestDatabaseError(
      isolationHelp(label, `${HYPERDRIVE_ENV} 与 ${MIGRATION_ENV} 必须同时配置`),
    )
  assertIsolatedTestDatabase({ app: appUrl, migrator: migratorUrl }, label, env)
  return { appUrl, migratorUrl }
}

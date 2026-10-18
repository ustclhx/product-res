import { pathToFileURL } from 'node:url'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { Pool } from 'pg'

export interface NodeJobEngineMigrationOptions {
  readonly databaseUrl: string
  readonly applicationRole: string
  readonly readonlyRole?: string
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value))
    throw new AppError('JOB_ENGINE_INVALID_ROLE', 'Invalid database role')
  return `"${value}"`
}

/** 仅供一次性 migrator 使用：先完成受控业务迁移，再调用此函数，最后启动 app。 */
export async function migrateNodeJobEngine(options: NodeJobEngineMigrationOptions): Promise<void> {
  const appRole = identifier(options.applicationRole)
  const readonlyRole = options.readonlyRole ? identifier(options.readonlyRole) : undefined
  if (DBOS.isInitialized())
    throw new AppError('JOB_ENGINE_MIGRATOR_IN_APP', 'Migration requires a separate process')
  const pool = new Pool({ connectionString: options.databaseUrl, max: 1 })
  pool.on('error', () => log.error('platform.job_engine.migration_pool_failed'))
  try {
    // 5.2.11 public migrate 内部创建默认 logger，无法注入；只在独立迁移进程抑制原文输出。
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const
    const original = { ...console }
    for (const method of methods) console[method] = () => {}
    try {
      await DBOS.migrate(options.databaseUrl, {
        schemaName: 'dbos',
        applicationRole: options.applicationRole,
      })
    } finally {
      for (const method of methods) console[method] = original[method]
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // 表定义来自版本控制的业务迁移；只赋权，绝不改 DBOS-owned 内部表。
      await client.query('CREATE SCHEMA IF NOT EXISTS job_engine')
      await client.query(`GRANT USAGE ON SCHEMA job_engine TO ${appRole}`)
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA job_engine TO ${appRole}`,
      )
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA job_engine TO ${appRole}`)
      // 调度游标与运行 ledger 是自有 metadata，运行时仅需 DML。
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON job_engine.schedule, job_engine.schedule_run TO ${appRole}`,
      )
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA job_engine GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
      )
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA job_engine GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
      )
      if (readonlyRole) {
        await client.query(`GRANT USAGE ON SCHEMA job_engine, dbos TO ${readonlyRole}`)
        await client.query(
          `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA job_engine, dbos FROM ${readonlyRole}`,
        )
        await client.query(
          `GRANT SELECT ON job_engine.queue, job_engine.batch, job_engine.start, job_engine.dead_letter TO ${readonlyRole}`,
        )
        await client.query(
          `GRANT SELECT (id, queue, request_id, created_at, available_at, state, attempts, batch_id, finished_at) ON job_engine.message TO ${readonlyRole}`,
        )
        // 状态表也含 inputs/output/error；只授权运维身份和状态列，不读持久正文。
        await client.query(
          `GRANT SELECT (workflow_uuid, status, name, executor_id, application_version, created_at, updated_at, recovery_attempts, queue_name) ON dbos.workflow_status TO ${readonlyRole}`,
        )
        // 新事件域只开放排障摘要；payload 与原子等待结果包含业务正文，不能开放。
        await client.query(
          `GRANT SELECT (id, sequence, workflow_id, type, created_at, consumed_at) ON job_engine.workflow_event TO ${readonlyRole}`,
        )
        await client.query(
          `GRANT SELECT (id, workflow_id, name, type, deadline, state, created_at, finished_at) ON job_engine.workflow_wait TO ${readonlyRole}`,
        )
        await client.query(
          `GRANT SELECT ON job_engine.schedule, job_engine.schedule_run TO ${readonlyRole}`,
        )
      }
      await client.query('COMMIT')
    } catch {
      await client.query('ROLLBACK')
      throw new AppError('JOB_ENGINE_PERMISSION_FAILED', 'Job engine permissions failed')
    } finally {
      client.release()
    }
    log.info('platform.job_engine.migrated')
  } catch {
    log.error('platform.job_engine.migration_failed')
    throw new AppError('JOB_ENGINE_MIGRATION_FAILED', 'Job engine migration failed')
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL
  const applicationRole = process.env.DBOS_APPLICATION_ROLE ?? 'app'
  if (!databaseUrl) {
    log.error('platform.job_engine.migration_config_missing')
    process.exitCode = 1
  } else {
    await migrateNodeJobEngine({
      databaseUrl,
      applicationRole,
      ...(process.env.DBOS_READONLY_ROLE ? { readonlyRole: process.env.DBOS_READONLY_ROLE } : {}),
    }).catch(() => {
      process.exitCode = 1
    })
  }
}

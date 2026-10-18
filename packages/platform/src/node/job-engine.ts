import { createHash } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  type ContextualMetadata,
  DBOS,
  Error as DBOSErrors,
  type DLogger,
} from '@dbos-inc/dbos-sdk'
import type { Database } from '@product-res/db'
import { AppError } from '@product-res/shared'
import { log } from '@product-res/shared/log'
import { Pool, type PoolClient } from 'pg'
import { holdNodeJobLock } from './job-guard.ts'
import { type ProcessOwner, processExited, processOwner } from './job-owner.ts'

export interface NodeJobEngine {
  readonly database: Database
  readonly executorId: string
  readonly ownershipToken: string
  readonly nativePoolMax: number
  assertOwnership(): Promise<void>
  isExecutorStopped(executorId: string, ownershipToken?: string): Promise<boolean>
  stopReceiving(): void
  close(): Promise<void>
}

export interface NodeJobEngineOptions {
  readonly database: Database
  readonly databaseUrl: string
  readonly executorId: string
  readonly applicationVersion: string
  /** 所有 jobs 共享持久目录；各副本使用互异且稳定的 hostname/executorId。 */
  readonly ownershipDirectory: string
  readonly nativePoolMax?: number
  readonly shutdownTimeoutMs?: number
  readonly register?: (engine: NodeJobEngine) => void | Promise<void>
  readonly start?: (engine: NodeJobEngine) => void | Promise<void>
  readonly stopReceiving?: () => void
}

let allocated = false

function failure(code: string): AppError {
  return new AppError(code, 'Node job engine is unavailable', { status: 503 })
}

function lockKey(executorId: string): string {
  return createHash('sha256').update(`product-res-job-engine:${executorId}`).digest('hex')
}

async function readOwner(path: string): Promise<ProcessOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      !('pid' in value) ||
      !Number.isSafeInteger(value.pid) ||
      Number(value.pid) <= 0 ||
      !('host' in value) ||
      typeof value.host !== 'string' ||
      !('pidNamespace' in value) ||
      typeof value.pidNamespace !== 'string' ||
      !('token' in value) ||
      typeof value.token !== 'string' ||
      ('machineId' in value &&
        (typeof value.machineId !== 'string' ||
          !/^[0-9a-f]{32}$/.test(value.machineId) ||
          /^0+$/.test(value.machineId))) ||
      ('bootId' in value &&
        (typeof value.bootId !== 'string' ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.bootId))) ||
      ('startTime' in value &&
        (typeof value.startTime !== 'string' || !/^\d+$/.test(value.startTime)))
    ) {
      throw failure('JOB_ENGINE_INVALID_OWNER')
    }
    return value as ProcessOwner
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw failure('JOB_ENGINE_INVALID_OWNER')
  }
}

function metadataFields(metadata?: ContextualMetadata): Record<string, unknown> {
  const attributes = metadata?.span?.attributes
  const fields: Record<string, unknown> = {}
  // 只取身份 metadata；SDK 输入字符串、error、stack 或用户 workflowAttributes 都不能进入日志。
  for (const [output, keys] of Object.entries({
    jobId: ['dbos.workflow.id', 'operationUUID'],
    requestId: ['requestId'],
    workspaceId: ['workspaceId'],
  })) {
    const value = keys.map((key) => attributes?.[key]).find((value) => value !== undefined)
    if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) fields[output] = value
  }
  const attempt = attributes?.attempt
  if (typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 0)
    fields.attempt = attempt
  return fields
}

export const nodeJobEngineLogger: DLogger = {
  info: (_entry, metadata) => log.info('platform.job_engine.sdk', metadataFields(metadata)),
  debug: () => {},
  warn: (_entry, metadata) => log.warn('platform.job_engine.sdk', metadataFields(metadata)),
  error: (_entry, metadata) => log.error('platform.job_engine.sdk', metadataFields(metadata)),
}

export async function createNodeJobEngine(options: NodeJobEngineOptions): Promise<NodeJobEngine> {
  const nativePoolMax = options.nativePoolMax ?? 4
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000
  if (
    !options.executorId ||
    !options.applicationVersion ||
    !options.ownershipDirectory ||
    !Number.isSafeInteger(nativePoolMax) ||
    nativePoolMax < 3 ||
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 0
  )
    throw failure('JOB_ENGINE_INVALID_OPTIONS')
  // DBOS 是进程级 singleton；同进程 close 后仍可能有未合作 callback，禁止重建另一个 incarnation。
  if (allocated || DBOS.isInitialized()) throw failure('JOB_ENGINE_ALREADY_STARTED')
  let current: ProcessOwner
  try {
    current = await processOwner()
  } catch {
    throw failure('JOB_ENGINE_INVALID_OWNER')
  }
  allocated = true
  const pool = new Pool({
    connectionString: options.databaseUrl,
    max: nativePoolMax,
    application_name: 'product_res_job_engine',
    connectionTimeoutMillis: 5_000,
    idle_in_transaction_session_timeout: 60_000,
  })
  let ownerClient: PoolClient | undefined
  let owned = false
  let stopping = false
  let closing: Promise<void> | undefined
  const ownerPath = (executorId: string) =>
    resolve(options.ownershipDirectory, `${lockKey(executorId)}.json`)
  const tokenPath = (executorId: string, token: string) =>
    resolve(options.ownershipDirectory, `${lockKey(executorId)}.${lockKey(token)}.json`)
  const tokenLockPath = (executorId: string, token: string) =>
    resolve(options.ownershipDirectory, `${lockKey(executorId)}.${lockKey(token)}.lock`)
  const loseOwnership = () => {
    if (!owned) return
    owned = false
    log.error('platform.job_engine.ownership_lost')
    engine.stopReceiving()
    // 外层停止 publisher 后，原生 dispatch/recovery 也必须停止，不能继续借可重连 pool 领取。
    void engine.close().catch(() => log.error('platform.job_engine.close_failed'))
  }
  const engine: NodeJobEngine = {
    database: options.database,
    executorId: options.executorId,
    ownershipToken: current.token,
    nativePoolMax,
    async assertOwnership() {
      if (!owned || !ownerClient) throw failure('JOB_ENGINE_OWNERSHIP_LOST')
      try {
        const owner = await readOwner(ownerPath(options.executorId))
        if (
          owner?.pid !== current.pid ||
          owner.host !== current.host ||
          owner.pidNamespace !== current.pidNamespace ||
          owner.machineId !== current.machineId ||
          owner.bootId !== current.bootId ||
          owner.startTime !== current.startTime ||
          owner.token !== current.token
        )
          throw failure('JOB_ENGINE_OWNERSHIP_LOST')
        await ownerClient.query('SELECT 1')
        if (!owned) throw failure('JOB_ENGINE_OWNERSHIP_LOST')
      } catch {
        loseOwnership()
        throw failure('JOB_ENGINE_OWNERSHIP_LOST')
      }
    },
    async isExecutorStopped(executorId, ownershipToken) {
      await engine.assertOwnership()
      const owner = await readOwner(
        ownershipToken ? tokenPath(executorId, ownershipToken) : ownerPath(executorId),
      )
      // 缺文件并不能证明一个已领取工作的执行者退出；人工误删锁也不得放行。
      if (!owner || (ownershipToken !== undefined && owner.token !== ownershipToken)) return false
      return processExited(owner, current, tokenLockPath(executorId, owner.token))
    },
    stopReceiving() {
      if (stopping) return
      stopping = true
      try {
        options.stopReceiving?.()
      } catch {
        log.error('platform.job_engine.stop_receiving_failed')
      }
    },
    close() {
      if (closing) return closing
      engine.stopReceiving()
      closing = (async () => {
        try {
          await DBOS.shutdown({ workflowCompletionTimeoutMS: shutdownTimeoutMs })
        } finally {
          owned = false
          ownerClient?.release(true)
          ownerClient = undefined
          await pool.end()
          // 不删除 PID 文件：超时 callback 仍可能执行副作用，只能在真正 exit 后复用 executorID。
        }
      })()
      return closing
    },
  }
  pool.on('error', loseOwnership)
  try {
    ownerClient = await pool.connect()
    ownerClient.on('error', loseOwnership)
    ownerClient.on('end', loseOwnership)
    const key = lockKey(options.executorId)
    const lock = await ownerClient.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
      [Number.parseInt(key.slice(0, 8), 16) | 0, Number.parseInt(key.slice(8, 16), 16) | 0],
    )
    if (!lock.rows[0]?.acquired) throw failure('JOB_ENGINE_EXECUTOR_IN_USE')
    await mkdir(options.ownershipDirectory, { recursive: true, mode: 0o700 })
    const recoveryGuard = `${ownerPath(options.executorId)}.recovering`
    // Linux 上 executor 锁与本 incarnation 的 token 锁都由本进程持有到真正退出：前者串行化
    // 初始化并拒绝任何仍存活的同 ID 进程（跨容器/namespace），后者供其他进程证明本 token 退出。
    // 获取失败即拒绝；不按 TTL、DB 锁消失或删除 owner 目录接管。
    await holdNodeJobLock(`${ownerPath(options.executorId)}.lock`)
    await holdNodeJobLock(tokenLockPath(options.executorId, current.token), { create: true })
    if (process.platform === 'linux') {
      // 初始化被 SIGKILL 打断留下的 guard：仅在其 token 锁已由内核释放时定向清理。
      const abandoned = await readOwner(recoveryGuard)
      if (abandoned) {
        if (
          !(await processExited(
            abandoned,
            current,
            tokenLockPath(options.executorId, abandoned.token),
          ))
        )
          throw failure('JOB_ENGINE_EXECUTOR_IN_USE')
        await unlink(recoveryGuard)
      }
    }
    await writeFile(recoveryGuard, JSON.stringify(current), { flag: 'wx', mode: 0o600 })
    try {
      const previous = await readOwner(ownerPath(options.executorId))
      if (previous) {
        if (
          !(await processExited(
            previous,
            current,
            tokenLockPath(options.executorId, previous.token),
          ))
        )
          throw failure('JOB_ENGINE_EXECUTOR_IN_USE')
        await unlink(ownerPath(options.executorId))
      }
      await writeFile(ownerPath(options.executorId), JSON.stringify(current), {
        flag: 'wx',
        mode: 0o600,
      })
      // 每个 incarnation 的记录独立保留；重启覆盖 active 文件后仍能证明旧 batch 的进程退出。
      await writeFile(tokenPath(options.executorId, current.token), JSON.stringify(current), {
        flag: 'wx',
        mode: 0o600,
      })
    } finally {
      await unlink(recoveryGuard)
    }
    owned = true
    DBOS.setConfig({
      name: 'product-res-jobs',
      systemDatabaseUrl: options.databaseUrl,
      systemDatabasePool: pool,
      systemDatabasePoolSize: nativePoolMax,
      systemDatabaseSchemaName: 'dbos',
      systemDatabasePollingConcurrency: 1,
      maxConcurrentQueueDispatches: 1,
      useListenNotify: false,
      runMigrations: false,
      executorID: options.executorId,
      applicationVersion: options.applicationVersion,
      logger: nodeJobEngineLogger,
      tracingEnabled: false,
      enableOTLP: false,
    })
    await options.register?.(engine)
    await engine.assertOwnership()
    await DBOS.launch()
    await engine.assertOwnership()
    await options.start?.(engine)
    log.info('platform.job_engine.started', { nativePoolMax })
    return engine
  } catch (error) {
    await engine.close().catch(() => log.error('platform.job_engine.close_failed'))
    if (error instanceof AppError) throw error
    if (error instanceof DBOSErrors.DBOSInitializationError)
      throw new AppError(
        'JOB_ENGINE_DATABASE_NOT_READY',
        'Job engine database or schema is not ready; verify connectivity and run migrator before app',
        { status: 503 },
      )
    throw failure('JOB_ENGINE_START_FAILED')
  }
}

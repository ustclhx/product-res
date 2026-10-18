import { type Database, pingDatabase, readLastCronAt } from '@product-res/db'
import type { TaskHealth } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/** 数据库探测超过该时间视为不可达（specs/system-health） */
export const HEALTH_DB_TIMEOUT_MS = 5_000

export interface HealthOptions {
  /** 惰性获取无缓存的业务 facade；连接初始化失败也由探活返回脱敏 503。 */
  database(): Database
  version: string
  timeoutMs?: number
  dependencies?: { cache(): Promise<void>; tasks: TaskHealth }
}

export type HealthBody =
  | {
      status: 'ok'
      version: string
      db: { status: 'up'; latencyMs: number }
      jobs: { lastCronAt: string | null }
    }
  | {
      status: 'error'
      version: string
      db: { status: 'down' }
    }

class ProbeTimeoutError extends Error {
  override readonly name = 'ProbeTimeoutError'
}

/**
 * `GET /api/health` 的实现：一次 `select 1` 往返计时，再读取实时的 `jobs.lastCronAt`
 * （不经过 getSetting 的 KV 缓存）。整个探测超过 `timeoutMs` 或任一步失败时返回 503，
 * 响应与日志都不包含连接串、主机名或驱动的错误消息。
 *
 * 借用入口的数据库，不关闭池；CF 每请求创建，Node 复用进程池。
 */
export async function healthResponse({
  database,
  version,
  timeoutMs = HEALTH_DB_TIMEOUT_MS,
  dependencies,
}: HealthOptions): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  if (dependencies) {
    const [databaseResult, cacheResult, queueResult, schedulerResult] = await Promise.allSettled([
      withTimeout(
        Promise.resolve().then(() => probe(database())),
        timeoutMs,
      ),
      withTimeout(
        Promise.resolve().then(() => dependencies.cache()),
        timeoutMs,
      ),
      withTimeout(dependencies.tasks.queue(), timeoutMs),
      withTimeout(dependencies.tasks.scheduler(), timeoutMs),
    ])
    const db =
      databaseResult.status === 'fulfilled'
        ? { status: 'up', latencyMs: databaseResult.value.latencyMs }
        : { status: 'down' }
    const cache = { status: cacheResult.status === 'fulfilled' ? 'up' : 'down' }
    const queue = queueResult.status === 'fulfilled' ? queueResult.value : { status: 'down' }
    const scheduler =
      schedulerResult.status === 'fulfilled'
        ? schedulerResult.value
        : { status: 'down', lastCronAt: null }
    const lastCronAt = scheduler.lastCronAt
    const at = lastCronAt === null ? Number.NaN : Date.parse(lastCronAt)
    const ready =
      db.status === 'up' &&
      cache.status === 'up' &&
      queue.status === 'up' &&
      scheduler.status === 'up' &&
      Number.isFinite(at) &&
      Date.now() - at <= 10 * 60_000
    return Response.json(
      {
        status: ready ? 'ok' : 'error',
        version,
        db,
        cache,
        queue,
        scheduler,
        jobs: { lastCronAt },
      },
      { status: ready ? 200 : 503, headers },
    )
  }
  try {
    const db = database()
    const { latencyMs, lastCronAt } = await withTimeout(probe(db), timeoutMs)
    const body: HealthBody = {
      status: 'ok',
      version,
      db: { status: 'up', latencyMs },
      jobs: { lastCronAt },
    }
    return Response.json(body, { headers })
  } catch (error) {
    log.error('health.db_down', { reason: describe(error) })
    const body: HealthBody = { status: 'error', version, db: { status: 'down' } }
    return Response.json(body, { status: 503, headers })
  }
}

async function probe(db: Database) {
  const started = performance.now()
  await pingDatabase(db)
  const latencyMs = Math.round(performance.now() - started)
  const lastCronAt = await readLastCronAt(db)
  return { latencyMs, lastCronAt }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // 超时后探测仍可能失败，避免它成为未处理的 rejection
  promise.catch(() => {})
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 只记录错误类别（超时 / 错误码），驱动的错误消息里可能带主机名与端口。 */
function describe(error: unknown): string {
  if (error instanceof ProbeTimeoutError) return 'timeout'
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code)) return code
  return 'error'
}

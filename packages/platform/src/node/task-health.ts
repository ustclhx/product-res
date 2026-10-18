import { type Database, readLastCronAt, recordLastCronAt } from '@product-res/db'
import type { QueueHealth, SchedulerHealth, TaskHealth } from '../capabilities.ts'
import type { ScheduledHandler } from '../scheduler.ts'

const PROBE_TIMEOUT_MS = 5_000
const HEARTBEAT_MAX_AGE_MS = 10 * 60_000

async function probe<T>(read: () => Promise<T>, failed: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(failed), PROBE_TIMEOUT_MS)
      }),
    ])
  } catch {
    // 驱动异常可能含连接串；健康响应仅保留依赖状态。
    return failed
  } finally {
    clearTimeout(timer)
  }
}

/** composition root 传入真实 adapter；缺少能力时明确返回 unavailable。 */
export function createNodeTaskHealth(
  probes: {
    queue?: { health(): Promise<QueueHealth> }
    scheduler?: { health(): Promise<SchedulerHealth> }
  } = {},
): TaskHealth {
  const { queue, scheduler } = probes
  return {
    queue: () =>
      queue
        ? probe(() => queue.health(), { status: 'down' })
        : Promise.resolve({ status: 'unavailable' }),
    scheduler: () =>
      scheduler
        ? probe(() => scheduler.health(), { status: 'down', lastCronAt: null })
        : Promise.resolve({ status: 'unavailable', lastCronAt: null }),
  }
}

/** 每次直读业务数据库，不使用运行时设置缓存；输出规范 UTC ISO 时间。 */
export async function readNodeCronHeartbeat(db: Database): Promise<string | null> {
  const value = await readLastCronAt(db)
  if (value === null) return null
  const at = new Date(value)
  return Number.isFinite(at.getTime()) ? at.toISOString() : null
}

/** 五分钟任务由 apps 注册；前置补偿完成后才记录实际成功时间。 */
export function createNodeCronHeartbeat(db: Database, handler: ScheduledHandler): ScheduledHandler {
  return async (context) => {
    await handler(context)
    await recordLastCronAt(db, new Date())
  }
}

/** Node readiness 可直接使用；过期心跳与未装配能力都不能冒充就绪。 */
export function createNodeTaskHealthResponse(
  health: TaskHealth,
  options: { version?: string } = {},
) {
  return async (): Promise<Response> => {
    const [queue, scheduler] = await Promise.all([
      probe(() => health.queue(), { status: 'down' } satisfies QueueHealth),
      probe(() => health.scheduler(), {
        status: 'down',
        lastCronAt: null,
      } satisfies SchedulerHealth),
    ])
    const lastCronAt = scheduler.lastCronAt
    const lastSuccess = lastCronAt === null ? Number.NaN : Date.parse(lastCronAt)
    const ready =
      queue.status === 'up' &&
      scheduler.status === 'up' &&
      Number.isFinite(lastSuccess) &&
      Date.now() - lastSuccess <= HEARTBEAT_MAX_AGE_MS
    return Response.json(
      {
        status: ready ? 'ok' : 'degraded',
        ...options,
        queue,
        scheduler,
        jobs: { lastCronAt },
      },
      { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}

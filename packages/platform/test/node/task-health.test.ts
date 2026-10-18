import { DBOS } from '@dbos-inc/dbos-sdk'
import { type Database, JOBS_LAST_CRON_AT_KEY } from '@product-res/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskHealth } from '../../src/capabilities.ts'
import { createNodeQueueAdapter } from '../../src/node/job-queue.ts'
import {
  createNodeCronHeartbeat,
  createNodeTaskHealth,
  createNodeTaskHealthResponse,
  readNodeCronHeartbeat,
} from '../../src/node/task-health.ts'

function heartbeatDb(initial: unknown = undefined) {
  let value = initial
  const writes: { key: string; value: string }[] = []
  const read = vi.fn(async () => (value === undefined ? [] : [{ value }]))
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: read }) }) }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: async () => {
          writes.push(row)
          value = row.value
        },
      }),
    }),
  } as unknown as Database
  return { db, read, writes }
}

function readyHealth(lastCronAt: string | null): TaskHealth {
  return createNodeTaskHealth({
    queue: { health: async () => ({ status: 'up' }) },
    scheduler: { health: async () => ({ status: 'up', lastCronAt }) },
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Node task health and successful heartbeat', () => {
  it('requires initialized DBOS and a running consumer even when databases are reachable', async () => {
    const initialized = vi.spyOn(DBOS, 'isInitialized').mockReturnValue(false)
    const assertOwnership = vi.fn(async () => {})
    const read = vi.fn(async () => [])
    const queue = createNodeQueueAdapter({
      db: { select: () => ({ from: () => ({ limit: read }) }) } as unknown as Database,
      executorId: 'health-test',
      ownershipToken: 'health-test-token',
      assertOwnership,
      isExecutorStopped: async () => false,
    })
    expect(await queue.health()).toEqual({ status: 'down' })
    expect(read).not.toHaveBeenCalled()
    initialized.mockReturnValue(true)
    expect(await queue.health()).toEqual({ status: 'down' })
    expect(assertOwnership).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
  })

  it('reports unassembled capabilities and rejects readiness', async () => {
    const health = createNodeTaskHealth()
    expect(await health.queue()).toEqual({ status: 'unavailable' })
    expect(await health.scheduler()).toEqual({ status: 'unavailable', lastCronAt: null })
    const response = await createNodeTaskHealthResponse(health, { version: 'test-version' })()
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      version: 'test-version',
      jobs: { lastCronAt: null },
    })
  })

  it.each(['queue', 'scheduler'] as const)(
    'maps a failing %s probe to down and 503',
    async (name) => {
      const lastCronAt = new Date().toISOString()
      const health = createNodeTaskHealth({
        queue: {
          health: async () => {
            if (name === 'queue') throw new Error('private database credential')
            return { status: 'up' }
          },
        },
        scheduler: {
          health: async () => {
            if (name === 'scheduler') throw new Error('private database credential')
            return { status: 'up', lastCronAt }
          },
        },
      })
      const response = await createNodeTaskHealthResponse(health)()
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = (await response.json()) as Record<string, { status: string }>
      expect(body[name]?.status).toBe('down')
      expect(JSON.stringify(body)).not.toContain('private')
    },
  )

  it('bounds stalled backend probes instead of hanging readiness', async () => {
    vi.useFakeTimers()
    const health = createNodeTaskHealth({
      queue: { health: () => new Promise(() => {}) },
      scheduler: { health: () => new Promise(() => {}) },
    })
    const response = createNodeTaskHealthResponse(health)()
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await response).status).toBe(503)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([null, 'invalid', '2026-10-13T00:00:00.000Z'])(
    'rejects missing, invalid or expired heartbeat: %s',
    async (lastCronAt) => {
      vi.useFakeTimers({ now: new Date('2026-10-13T00:10:00.001Z') })
      const response = await createNodeTaskHealthResponse(readyHealth(lastCronAt))()
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = (await response.json()) as { jobs: { lastCronAt: string | null } }
      expect(body.jobs.lastCronAt).toBe(lastCronAt)
    },
  )

  it('accepts a successful heartbeat up to exactly ten minutes old', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T00:10:00.000Z') })
    const response = await createNodeTaskHealthResponse(readyHealth('2026-10-13T00:00:00.000Z'))()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      status: 'ok',
      queue: { status: 'up' },
      scheduler: { status: 'up', lastCronAt: '2026-10-13T00:00:00.000Z' },
    })
  })

  it('awaits the prerequisite and writes actual success time, never the scheduled slot', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-13T00:00:00.000Z') })
    const { db, read, writes } = heartbeatDb()
    let finish: (() => void) | undefined
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const scheduledAt = new Date('2026-10-12T23:55:00.000Z')
    const run = createNodeCronHeartbeat(db, handler)({ scheduledAt })
    expect(handler).toHaveBeenCalledWith({ scheduledAt })
    expect(writes).toEqual([])
    expect(await readNodeCronHeartbeat(db)).toBeNull()
    vi.setSystemTime(new Date('2026-10-13T00:00:03.000Z'))
    finish?.()
    await run
    expect(writes).toEqual([{ key: JOBS_LAST_CRON_AT_KEY, value: '2026-10-13T00:00:03.000Z' }])
    expect(await readNodeCronHeartbeat(db)).toBe('2026-10-13T00:00:03.000Z')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('preserves the old heartbeat and propagates a prerequisite failure', async () => {
    const old = '2026-10-13T00:00:00.000Z'
    const { db, writes } = heartbeatDb(old)
    const error = new Error('cache deletion failed')
    const run = createNodeCronHeartbeat(db, async () => {
      throw error
    })
    await expect(run({ scheduledAt: new Date() })).rejects.toBe(error)
    expect(writes).toEqual([])
    expect(await readNodeCronHeartbeat(db)).toBe(old)
  })

  it('normalizes stored timestamps to UTC and rejects malformed records', async () => {
    expect(await readNodeCronHeartbeat(heartbeatDb('2026-10-13T08:00:00+08:00').db)).toBe(
      '2026-10-13T00:00:00.000Z',
    )
    expect(await readNodeCronHeartbeat(heartbeatDb('not a timestamp').db)).toBeNull()
  })
})

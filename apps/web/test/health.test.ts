import { env } from 'cloudflare:workers'
import { createDb, JOBS_LAST_CRON_AT_KEY, readLastCronAt, setting } from '@product-res/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type HealthBody, healthResponse } from '../src/server/health.ts'

const version = '1.2.3-test'

async function call(hyperdrive: Hyperdrive, timeoutMs?: number) {
  const response = await healthResponse({
    database: () => createDb(hyperdrive),
    version,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as HealthBody }
}

/** 响应中不得出现连接串、主机名、端口或账号 */
function expectNoConnectionDetails(text: string, hyperdrive: Hyperdrive) {
  const { host, port, user, password } = hyperdrive
  for (const secret of [hyperdrive.connectionString, host, String(port), user, password]) {
    expect(text).not.toContain(secret)
  }
  expect(text).not.toMatch(/postgres(ql)?:\/\//)
  expect(text).not.toContain('127.0.0.1')
  expect(text).not.toContain('localhost')
}

describe('GET /api/health', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('数据库可达时返回 200、往返耗时、版本与实时的 jobs.lastCronAt', async () => {
    const db = createDb(env.HYPERDRIVE)
    const previous = await readLastCronAt(db)
    const at = '2026-10-03T08:00:00.000Z'
    await db
      .insert(setting)
      .values({ key: JOBS_LAST_CRON_AT_KEY, value: at })
      .onConflictDoUpdate({ target: setting.key, set: { value: at } })
    try {
      const { response, body } = await call(env.HYPERDRIVE)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(body).toEqual({
        status: 'ok',
        version,
        db: { status: 'up', latencyMs: expect.any(Number) },
        jobs: { lastCronAt: at },
      })

      // 修改后立即可见：不经过任何缓存
      const later = '2026-10-03T08:05:00.000Z'
      await db.update(setting).set({ value: later }).where(eq(setting.key, JOBS_LAST_CRON_AT_KEY))
      const second = await call(env.HYPERDRIVE)
      expect(second.body.status === 'ok' && second.body.jobs.lastCronAt).toBe(later)
    } finally {
      if (previous === null) {
        await db.delete(setting).where(eq(setting.key, JOBS_LAST_CRON_AT_KEY))
      } else {
        await db
          .update(setting)
          .set({ value: previous })
          .where(eq(setting.key, JOBS_LAST_CRON_AT_KEY))
      }
    }
  })

  it('数据库拒绝连接时返回 503，且不泄露连接信息', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { response, text, body } = await call(env.HYPERDRIVE_REFUSED)
    expect(response.status).toBe(503)
    expect(body).toEqual({ status: 'error', version, db: { status: 'down' } })
    expectNoConnectionDetails(text, env.HYPERDRIVE_REFUSED)
    const logged = error.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(logged).toContain('health.db_down')
    expectNoConnectionDetails(logged, env.HYPERDRIVE_REFUSED)
  })

  it('数据库无响应超过时限时返回 503', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const started = Date.now()
    const { response, text, body } = await call(env.HYPERDRIVE_HANGING, 300)
    expect(response.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(body).toEqual({ status: 'error', version, db: { status: 'down' } })
    expectNoConnectionDetails(text, env.HYPERDRIVE_HANGING)
    expect(error.mock.calls.flat().join(' ')).toContain('"reason":"timeout"')
  })
})

import { newId } from '@product-res/shared'
import { eq, sql } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb, setting } from '../../src/index.ts'
import { env } from './env.ts'

const db = createDb(env.HYPERDRIVE)
const key = `node.lifecycle.${newId()}`
afterEach(async () => {
  await db.delete(setting).where(eq(setting.key, key))
})

it('连续请求共用有界池，借用 facade 关闭不终止进程资源，owner 关闭释放连接', async () => {
  const name = `node-pool-${newId()}`
  const owner = createDb(process.env.NODE_DB_TEST_URL as string, {
    max: 2,
    connection: { application_name: name },
  })
  try {
    const pids = new Set<number>()
    for (let batch = 0; batch < 4; batch++) {
      const rows = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const requestDb = createDb(owner.$client)
          expect(requestDb.ownsPool).toBe(false)
          const [row] = await requestDb.$client`select pg_backend_pid() as pid, pg_sleep(0.01)`
          await requestDb.close()
          return Number(row?.pid)
        }),
      )
      for (const pid of rows) pids.add(pid)
    }
    expect(pids.size).toBe(2)
    expect(owner.ownsPool).toBe(true)
    const [connections] = await db.$client`
      select count(*)::int as count from pg_stat_activity where application_name = ${name}`
    expect(connections?.count).toBe(2)
  } finally {
    await owner.close()
  }
  const [connections] = await db.$client`
    select count(*)::int as count from pg_stat_activity where application_name = ${name}`
  expect(connections?.count).toBe(0)
})

function gate() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 从 PG 验证等待者确实阻塞，避免仅凭执行速度误判锁生效。 */
async function waitForBlock(pid: number) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const [row] = await db.$client`select cardinality(pg_blocking_pids(${pid})) as blocked`
    if (Number(row?.blocked) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Expected transaction lock contention')
}

describe.each(['row', 'advisory'] as const)('%s 事务锁', (kind) => {
  it.each(['commit', 'rollback'] as const)(
    '%s 后等待者继续、写入一致且没有残留事务',
    async (ending) => {
      await db.insert(setting).values({ key, value: 0 })
      const acquired = gate()
      const finish = gate()
      const waiterStarted = gate()
      const rollback = new Error('caller rollback')
      const pids: number[] = []
      async function lock(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
        if (kind === 'row')
          await tx.select().from(setting).where(eq(setting.key, key)).for('update')
        else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
      }
      const holder = db.transaction(async (tx) => {
        const [row] = await tx.execute(sql`select pg_backend_pid() as pid`)
        pids.push(Number(row?.pid))
        await lock(tx)
        await tx.update(setting).set({ value: 1 }).where(eq(setting.key, key))
        acquired.resolve()
        await finish.promise
        if (ending === 'rollback') throw rollback
      })
      // 立即订阅失败，避免 rollback 在测试断言之前成为 unhandled rejection。
      const holderResult = holder.then(
        () => null,
        (error: unknown) => error,
      )
      await acquired.promise
      let waiterPid = 0
      const waiter = db.transaction(async (tx) => {
        const [row] = await tx.execute(sql`select pg_backend_pid() as pid`)
        waiterPid = Number(row?.pid)
        pids.push(waiterPid)
        waiterStarted.resolve()
        await lock(tx)
        const [value] = await tx.select().from(setting).where(eq(setting.key, key))
        return value?.value
      })
      try {
        await waiterStarted.promise
        await waitForBlock(waiterPid)
      } finally {
        finish.resolve()
      }
      expect(await holderResult).toBe(ending === 'rollback' ? rollback : null)
      expect(await waiter).toBe(ending === 'rollback' ? 0 : 1)
      const active = await db.$client`
      select pid from pg_stat_activity
      where pid in ${db.$client(pids)} and (state = 'idle in transaction' or xact_start is not null)
      and pid <> pg_backend_pid()`
      expect(active).toHaveLength(0)
      const locks = await db.$client`
      select pid from pg_locks where pid in ${db.$client(pids)} and locktype = 'advisory'`
      expect(locks).toHaveLength(0)
    },
  )
})

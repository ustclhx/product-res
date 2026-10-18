// 7.1 实测：经 Hyperdrive（关缓存）使用显式事务、SELECT ... FOR UPDATE、pg_advisory_xact_lock。
// 由 run.mjs 发起并发请求；所有时间点取数据库时钟 clock_timestamp()（同一时钟，可直接比较）。
// 只读写 setting 表中 key 以 `probe.7.1.` 开头的行（app 账号只有 DML）。
import postgres from 'postgres'

interface Env {
  HYPERDRIVE: { connectionString: string }
  PROBE_TOKEN?: string
}

const ROW_KEY = 'probe.7.1.row'
const KEY_PREFIX = 'probe.7.1.'
// pg_advisory_xact_lock(bigint)：在 pg_locks 中表现为 classid=0、objid=ADVISORY_KEY、objsubid=1
const ADVISORY_KEY = 710001
const MAX_HOLD_MS = 10_000

type Mode = 'row' | 'advisory' | 'none' // none：对照组，不加锁
type End = 'commit' | 'rollback' | 'abandon'

// 与 packages/db 的 createDb() 相同的连接参数
function connect(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: true })
}

type Sql = ReturnType<typeof connect>
type Tx = Parameters<Parameters<Sql['begin']>[0]>[0]

async function now(q: Sql | Tx): Promise<number> {
  const [r] = await q`select extract(epoch from clock_timestamp())::float8 * 1000 as t`
  return r.t as number
}

class Rollback extends Error {}

async function lock(env: Env, params: URLSearchParams) {
  const mode = (params.get('mode') ?? 'row') as Mode
  const end = (params.get('end') ?? 'commit') as End
  const hold = Math.min(Number(params.get('hold') ?? 3000), MAX_HOLD_MS)
  const lockTimeout = Math.min(Number(params.get('lockTimeout') ?? 20_000), 30_000)
  const tag = params.get('tag') ?? '?'
  if (
    !['row', 'advisory', 'none'].includes(mode) ||
    !['commit', 'rollback', 'abandon'].includes(end)
  ) {
    return Response.json({ error: 'bad mode/end' }, { status: 400 })
  }

  const sql = connect(env)
  const out: Record<string, unknown> = { tag, mode, end, hold }
  let signalAcquired: () => void = () => {}
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve
  })

  const work = sql.begin(async (tx) => {
    const [b] = await tx`
      select extract(epoch from clock_timestamp())::float8 * 1000 as t,
             pg_backend_pid() as pid, txid_current() as xid`
    out.beginAt = b.t
    out.pid = b.pid
    out.xid = String(b.xid)
    // 防止 B 永久挂起：超过 lockTimeout 仍拿不到锁则报 55P03
    await tx.unsafe(`set local lock_timeout = '${lockTimeout}ms'`)

    // 拿到锁的时刻在同一条语句中取，不多算一次往返
    const [l] =
      mode === 'none'
        ? await tx`select extract(epoch from clock_timestamp())::float8 * 1000 as t`
        : mode === 'row'
          ? await tx`
            with locked as (select key from setting where key = ${ROW_KEY} for update)
            select extract(epoch from clock_timestamp())::float8 * 1000 as t from locked`
          : await tx`
            select pg_advisory_xact_lock(${ADVISORY_KEY}),
                   extract(epoch from clock_timestamp())::float8 * 1000 as t`
    out.acquiredAt = l.t
    out.waitMs = (out.acquiredAt as number) - (out.beginAt as number)

    // 持锁期间读-改-写计数器：锁有效时并发请求不会丢失更新
    const [row] = await tx`select (value->>'counter')::int as c from setting where key = ${ROW_KEY}`
    out.counterBefore = row?.c ?? null
    // abandon 也先按 hold 持锁，让晚发的 B 在 A 返回前真正争锁。
    if (end === 'abandon') await tx`select pg_sleep(${hold / 1000})`
    signalAcquired()
    if (end === 'abandon') {
      // 不提交也不回滚：响应返回后 Worker 结束，客户端连接被丢弃
      await new Promise(() => {})
    }
    await tx`select pg_sleep(${hold / 1000})`
    await tx`
      update setting set value = jsonb_build_object('counter', ${(row?.c ?? 0) + 1}::int),
                         updated_at = now()
      where key = ${ROW_KEY}`
    out.releaseAt = await now(tx)
    if (end === 'rollback') throw new Rollback()
  })

  try {
    if (end === 'abandon') {
      await Promise.race([acquired, work])
      out.respondedAt = await now(connect(env))
      return Response.json(out)
    }
    await work
  } catch (err) {
    if (!(err instanceof Rollback)) {
      out.error = { message: (err as Error).message, code: (err as { code?: string }).code }
      return Response.json(out, { status: 500 })
    }
  }
  // 事务结束（COMMIT / ROLLBACK 已返回）之后的时刻；可能落在连接池中的另一条连接上，时钟相同
  out.endedAt = await now(sql)
  return Response.json(out)
}

// 检查锁是否已释放。
// tryLock=1：在新事务中 pg_try_advisory_xact_lock 与 FOR UPDATE NOWAIT（会短暂持锁，调用方须串行）；
// 否则只读 pg_locks / pg_stat_activity，可并发调用以覆盖连接池中的多条连接。
async function check(env: Env, tryLock: boolean) {
  const sql = connect(env)
  return sql.begin(async (tx) => {
    const [me] = await tx`
      select pg_backend_pid() as pid, extract(epoch from clock_timestamp())::float8 * 1000 as t`
    const result: Record<string, unknown> = { at: me.t, pid: me.pid }
    if (tryLock) {
      const [a] = await tx`select pg_try_advisory_xact_lock(${ADVISORY_KEY}) as ok`
      result.advisoryLockFree = a.ok
      try {
        await tx`savepoint s`
        await tx`select key from setting where key = ${ROW_KEY} for update nowait`
        await tx`release savepoint s`
        result.rowLockFree = true
      } catch {
        await tx`rollback to savepoint s`
        result.rowLockFree = false
      }
    }
    // 其他会话持有的同一 advisory key（排除本事务自己）
    const [h] = await tx`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and classid = 0 and objid = ${ADVISORY_KEY} and objsubid = 1
        and pid <> pg_backend_pid()`
    result.otherAdvisoryHolders = h.n
    // 本库 app 账号下事务已开启超过 2s 且空闲的连接，即残留的未结束事务
    // （并发 check 彼此之间会短暂处于 idle in transaction，故按事务时长过滤；共享环境，仅供参考）
    result.idleInTransaction = await tx`
      select pid, state, extract(epoch from now() - xact_start)::float8 as xact_age_s
      from pg_stat_activity
      where datname = current_database() and usename = current_user
        and state like 'idle in transaction%' and pid <> pg_backend_pid()
        and now() - xact_start > interval '2 seconds'`
    const [r] = await tx`select (value->>'counter')::int as c from setting where key = ${ROW_KEY}`
    result.counter = r?.c ?? null
    return Response.json(result)
  })
}

async function setup(env: Env) {
  const sql = connect(env)
  await sql`
    insert into setting (id, key, value) values (gen_random_uuid(), ${ROW_KEY}, '{"counter":0}')
    on conflict (key) do update set value = excluded.value, updated_at = now()`
  return Response.json({ ok: true, key: ROW_KEY })
}

async function cleanup(env: Env) {
  const sql = connect(env)
  const rows = await sql`delete from setting where key like ${`${KEY_PREFIX}%`} returning key`
  return Response.json({ deleted: rows.map((r) => r.key) })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.PROBE_TOKEN || request.headers.get('x-probe-token') !== env.PROBE_TOKEN) {
      return new Response('forbidden', { status: 403 })
    }
    const url = new URL(request.url)
    switch (url.pathname) {
      case '/lock':
        return lock(env, url.searchParams)
      case '/check':
        return check(env, url.searchParams.get('tryLock') === '1')
      case '/setup':
        return setup(env)
      case '/cleanup':
        return cleanup(env)
      default:
        return new Response('not found', { status: 404 })
    }
  },
}

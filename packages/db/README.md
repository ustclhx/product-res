# 数据库连接与生命周期

`createDb` 接受原 Hyperdrive 结构、Postgres 连接字符串或 postgres.js `Sql`。Database 的 schema、事务、prepare、scoped 与账本规则保持原有行为，db 不依赖 platform。

| 输入 | 默认连接上限 | ownsPool / close |
| --- | --- | --- |
| Hyperdrive | 每请求/事件 5 | false；close 不调用 end，CF 请求运行时回收 |
| string | 每进程 10，可传 postgres.js options | true；close 有界关闭该自有池 |
| Sql | 沿用 owner 的池 | false；close 不终止借用池 |

CF 每请求/事件调用 `createDb(env.HYPERDRIVE)`，不跨请求缓存 I/O；公开数据保留独立 cached Hyperdrive 输入。默认 `fetch_types:false`、`prepare:true` 未变，CF 不调用已知在 workerd 有关闭问题的 sql.end。

Node 在启动时创建 owner，之后请求 facade 借用同一 `$client`，不每请求新建池。公开数据可借用 app 池，不引入查询缓存：

```ts
import { createDb } from '@product-res/db'

const owner = createDb(config.DATABASE_URL, { max: config.DB_POOL_MAX })
const requestDb = createDb(owner.$client)
await requestDb.close() // 仅释放调用方生命周期，不关闭共享 SQL 池

// shutdown：停止接受请求/任务 → 排空 active requests 与 waitUntil → 关闭缓存/SQL。
await owner.close()
```

web/jobs 各自拥有有限 app 池，建议各 max 10；migrator 专用进程 max 1。总预算为各 web/jobs 副本的 max 之和，再加迁移、B 引擎、探活和运维连接，并预留 PG 管理连接。增加副本前必须对照 PG max_connections 计算；不把每请求 facade 计作新池。运行时只使用 app 凭据，migrator/readonly 不交给业务。

## Node 业务集成验证

`pnpm --filter @product-res/db test:node` 必须有 app 与 migrator 两个连接配置（进程环境优先，其次根 `.env.worktree`），不配置会失败而非跳过：

- `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
- `MIGRATION_DATABASE_URL`

仅接受相同 host/database 的 `/product_res_wt_*` 隔离 worktree 库，或 CI 中 `/product_res_ci`。本地使用已有 PG17 容器和 worktree 专属数据库。global setup 沿用 migrator 的现有 SQL 迁移与迁移锁，不生成或提交迁移 SQL。

独立 Node Vitest 配置仅替换五个既有数据库测试的 CF env import 为真实进程 Sql fixture；原断言原样复用，不加载 cloudflare:*、不模拟 Workers API。CF 默认项目继续执行原测试，只将 Node 专属目录排除。Node fixture 以 app max 3 / migrator max 1 持有资源，并在结束时关闭。

同时原样运行 `packages/credits/test` 的 Node 业务用例（现有 suite 本来使用 postgres.js），覆盖重复/并发 grant、余额 10 的两个并发 hold 8 仅一个成功、capture/release 单赢家、调用方事务回滚和账本不变量。此配置只引用这些测试，不修改 credits 代码或断言。

新增 lifecycle 验证连续请求共用 max 2 池、借用 close 不终止共享资源、owner close 释放实际连接；PG blocking_pids 证明行锁与 advisory_xact_lock 等待，分别验证提交/回滚后等待者继续、写入一致、无残留锁或 idle-in-transaction。

2026-10-12 本 worktree PG17：Node 9 文件、86 用例通过。默认 CF/单元测试命令仍为 `pnpm --filter @product-res/db test`；类型检查仍为 `pnpm --filter @product-res/db typecheck`。未来 Node CI（组 5.3）应显式运行 test:node，不用默认 test 的可选 CF 集成跳过策略替代。

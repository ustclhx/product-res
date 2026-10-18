# 2.4 实测：注册 / 登录 / 修改密码的耗时（本地 workerd）

决定密码哈希用 Better Auth 默认的 scrypt 还是 Web Crypto 的 PBKDF2（design.md 风险条目：超过 50ms 时替换）。结论与数据见 `docs/04-auth-and-tenancy.md` §1「密码哈希（2.4 实测）」。

```bash
pnpm --filter @product-res/auth probe:cpu          # 默认每项 20 次（另有 3 次预热）
PROBE_ROUNDS=50 pnpm --filter @product-res/auth probe:cpu
```

需要本地 PG（与集成测试相同，连接串取自 `.env.worktree`）。不访问任何外部服务；不在 `pnpm test` 中运行。

## 测什么

`auth-cpu.probe.ts` 在 vitest-plugin 的 workerd 中运行（与集成测试同一个 `test/wrangler.jsonc`，Miniflare 模拟 KV），用 `performance.now()` 计时：

1. 本地 workerd 的时钟在纯计算期间是否推进（线上 Workers 的时钟只在 I/O 后推进，Worker 内无法这样计时）；
2. 哈希原语：scrypt（`better-auth/crypto`，workerd 中走 `node:crypto` 原生实现，N=16384、r=16、p=1）与 PBKDF2-HMAC-SHA256（`src/password.ts`，100,000 次迭代）的哈希 / 校验；
3. 本地 workerd 是否接受超过 100,000 次的 PBKDF2 迭代；
4. 经 `auth.handler` 的完整流程：注册、登录、密码错误的登录、修改密码，分别用 PBKDF2 与 scrypt（`vi.doMock` 替换 hasher）；关闭 Turnstile 与 RL_AUTH；
5. 对照：不涉及密码的 `get-session`（绕过 Cookie 缓存、KV 命中）与单次 `select 1`。

## 局限

- 计时是墙钟时间，包含本地 PG 与 Miniflare KV 的往返；对照组显示这两项都在 1ms 以内，因此流程耗时可以近似为 CPU 时间的上限。
- `performance.now()` 在 workerd 中只有毫秒精度。
- 本机为 Apple M4；线上 Cloudflare 边缘服务器的单核性能通常更低，原生 scrypt / PBKDF2 的耗时会相应增加。线上 CPU 时间需在部署后从 Workers 日志的 `cpuTime` 字段确认。

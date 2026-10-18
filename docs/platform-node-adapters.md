# Node 基础平台适配器（A 3.1–3.3）

从 `@product-res/platform/node` 显式装配，业务继续只依赖中立的 `KeyValueStore`、`RateLimiter`、`BackgroundTasks` 和 `RequestMetadata`。本批不改 Cloudflare 适配器、不装配生产 Node web/jobs 入口，不实现持久队列或调度器；入口接线与 Nitro shutdown 属于组 5，任务引擎属于 B。

## 共享缓存与防刷

启动时调用 `await createNodeCache({ url, namespace, policies?, timeoutMs? })`。`url` 来自已校验的运行时缓存配置，只交给服务端；支持 ioredis 的 `redis://` / `rediss://` 连接，认证值不得打印。连接和命令默认最多等待 5 秒，启动握手及 PING 也受同一上限约束。连接/命令失败转换为 `AppError('CACHE_UNAVAILABLE', ..., {status:503})`，没有驱动 cause、主机或凭据；驱动错误只记录固定日志事件。HTTP 调用方按既有 AppError 映射返回 503；限流 `success:false` 仍由业务层返回 429，副作用必须在限流成功后发生。

web/jobs 的 `namespace` 必须一致，同一部署环境独占命名空间。通过 `cache.kv('auth'|'settings'|'models')` 挑选用途，分别用于认证 secondaryStorage、运行时设置与模型缓存。键由环境、`kv`、用途和原业务 key 的长度前缀组成；`rate` 键包含策略与原业务 key，避免分隔符、缓存用途与策略之间碰撞。原业务 IP/邮箱/workspace/API key 维度不变。敏感会话校验仍实时查库。

KV 支持原字符串和 JSON 读取，缺失/过期返回 null；put 是字符串写入，`expirationTtl` 为正整数秒，delete 可跨客户端失效。Node 的 EX 精确到秒，不使用 CF 的 60 秒下限；不带 TTL 的 SET 覆盖会移除旧 TTL。非法 JSON 保留解析错误，不能伪装成缓存未命中。

`cache.rateLimiter.limit(policy,key)` 使用一个 Lua 操作同时 INCR 与首次 EXPIRE。窗口从首次请求开始，后续调用不延长过期时间；多实例共享计数，策略/key 分别隔离。

| 策略 | 默认限额 | 窗口 |
| --- | --- | --- |
| auth / RL_AUTH | 10 | 60 秒 |
| ai / RL_AI | 20 | 60 秒 |
| api / RL_API | 60 | 60 秒 |

入口可用 `policies: { auth:{limit,periodSeconds}, ai:..., api:... }` 显式配置三策略，数值必须是正安全整数。缓存用于防刷，精确配额/积分仍由 PG 控制。禁用离线队列、自动重连和未完成命令重放，故障期间不放行、不回退内存，也不自动重放可能已经执行的 INCR；连接中断后持续返回 503，恢复需由进程资源 owner 重新装配或重启。`cache.ping()` 用于实时依赖探测；`cache.close()` 只在请求和后台任务排空后调用。

## HTTP 信任与关联

启动时调用 `createNodeRequestMetadata(trustedProxyCidrs)` 编译 IPv4/IPv6 CIDR，非法项拒绝装配。入口将该函数用于 `(request, socket.remoteAddress)`；peer 必须来自真实 TCP socket，不能从请求头或业务参数取值。`TRUSTED_PROXY_CIDRS` 默认空，由组 2 的配置加载及组 5 的入口传入。

只有可信 peer 才读取 X-Forwarded-For，从右向左剥离可信代理，遇到第一非可信 hop 停止；整条链包含非法项则回退 peer。没有有效 peer 时返回 null。不读取 cf-connecting-ip、X-Real-IP 或请求中的 requestId。IPv6 地址规范化，IPv4-mapped IPv6 与 IPv4 使用相同防刷 IP。

仅信任 Caddy/Traefik 所在专用 ingress 子网，禁止配置任意公网或整个 Docker 网段；代理须覆盖/正确追加客户端可控 XFF，web 不暴露直连宿主端口。IP 只是防刷信号，不代替鉴权。

每次解析生成 UUIDv7 requestId；可选 cf-ray 仅作诊断。入口用 `withNodeRequestContext(metadata, handler)` 包装 handler，将同一 ID 放入共享日志上下文和响应 `x-request-id`，同时将 metadata 注入业务请求上下文。包装保留响应状态、headers 与 body 流；错误由入口在同一请求上下文中转换成 Response 后返回，以保持错误响应 ID。

## 响应后延续与停机

每进程创建一个 `createNodeBackgroundTasks()`。`waitUntil(promise)` 注册即附带 rejection handler，异常只记录固定事件 `platform.background.failed` 与注册时日志上下文，不输出 rejection 的正文/stack。正常运行没有响应后 30 秒时限，不取消已注册 Promise；客户端断开只关闭输出分支，服务端消费、usage 和结算 Promise 必须独立注册。

`beginRequest()` 返回幂等 release 函数。在接收请求时调用，只有在该请求所有服务端工作已完成或已交给 waitUntil 后才 release；流式响应可在 finish/close 释放输出分支，后台消费必须仍在集合中。`drain(timeoutMs=30000)` 等待在途请求与任务集合清空，允许未完成请求继续注册后台任务。超时返回 `{completed:false,pendingTasks,activeRequests}` 并记录未完成数量，不能宣称工作持久完成。

SIGTERM/SIGINT 或 Nitro shutdown hook 调用同一个幂等 `shutdown({stopReceiving,closeResources,timeoutMs})`：

1. `stopReceiving()` 同步发起停止接收新请求/引擎工作，不等待 server.close 回调。
2. 排空在途请求和后台 Promise。
3. 调用 `closeResources()` 关闭缓存与自有 SQL 池；同一 deadline 包含排空与资源关闭。

shutdown 返回 drain 结果及 `resourcesClosed`；资源关闭失败或超过剩余 deadline 都安全记录且返回 false，关闭 Promise 的 rejection 不会成为未处理异常。入口负责根据结果关闭残留 socket、设置退出状态并退出，不能仅返回 shutdown Promise 而让活跃 socket/timer 继续持有进程。资源关闭回调应立即发起全部关闭并自带驱动超时；缓存可 `close()`，借用 DB facade 不应关闭共享池。Compose stop_grace_period 应大于应用 deadline，Nitro 强制退出需与此顺序对齐，避免抢先退出。本批真实 Node 子进程证明 SIGTERM 完成/超时路径，生产 Nitro 接线仍由组 5 验收。

waitUntil 无 crash durability：SIGKILL、进程崩溃或机器故障可丢失工作；持久作业交给 B，账本幂等、usage checkpoint 和 hold 回收保持原保护。

## 验证命令

`pnpm --filter @product-res/platform test` 包含 Node 请求/HTTP 断开/SIGTERM 用例及原 CF 适配器回归；`pnpm --filter @product-res/platform typecheck` 同时检查中立/Node、CF 与测试类型。

Valkey 集成独立运行，缺少 TEST_VALKEY_URL 直接失败，不跳过。临时容器只绑定本机随机端口，命名为本 worktree；仅清理本任务启动的资源：

```sh
docker run -d --name selfhost-a3-valkey -p 127.0.0.1::6379 valkey/valkey:8.1.6-alpine
TEST_VALKEY_URL="redis://$(docker port selfhost-a3-valkey 6379/tcp)" pnpm --filter @product-res/platform test:node:integration
docker stop selfhost-a3-valkey
docker rm -v selfhost-a3-valkey
```

该 URL 仅用于无认证的隔离本地容器；有认证的 URL 只能从已加载的环境取得，不放命令参数或日志。用例验证跨客户端缓存、TTL/删除、三策略并发计数、窗口不延长，以及连接不可达/运行中断开的安全 503；运行中断开通过测试专用 TCP 代理完成，不停止共享服务。后续组 5 应将独立集成命令接入 Node CI 的临时 Valkey。

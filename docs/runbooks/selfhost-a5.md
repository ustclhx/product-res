# A 5.1–5.3：Node 生产构建、启动与 CI

## 版本与产物

锁定 `nitro@3.0.260903-beta` 与 `srvx@1.0.5`，在本仓库 Vite 8.3.2、TanStack Start 1.168.60 / plugin-core 1.171.49 上验证。采用 Nitro `node_server` preset，支持 Node 22 LTS（至少 22.12）；生产 HTTP smoke 也已在 Node 22.23.3 验证。

- 根 `pnpm build` 仍产出 Cloudflare `apps/web/dist/{client,server}` 与 jobs `dist`。
- 根 `pnpm build:node` 产出两个 app 的 `.output/server/index.mjs`，web 静态/预渲染文件位于 `.output/public`。
- 分别在 app 目录运行 `pnpm start:node`；web 默认 3000，jobs 默认 3001，`HOST` / `PORT` 可覆盖；web 也支持 Nitro 的 `NITRO_HOST` / `NITRO_PORT`。
- 在 listen 前加载各 app 当前目录 `.env`、进程环境和受支持的 `_FILE` 密钥，通过模板相关 Node schema 校验。运行时配置见 config 与 Node adapter 文档，构建不需要这些配置。
- Node 构建不读取部署 dotenv 或连接数据库，公开页沿用降级；本次无生产凭据构建生成 18 个中英文预渲染页面。
- Node 固化完整 40 位 Git SHA；源码归档须提供合法 `APP_VERSION`。根脚本在 Turbo 算 hash 之前确定版本，SHA 属于 `build:node.env`，两个目标任务名、inputs 与 outputs 分开，`.output` 不覆盖 `dist`。

先用独立最小 Start/Nitro fixture 验证 SSR、真实 Server Function RPC、分块流、静态文件及无 DB 预渲染，再接入完整应用。完整产物 smoke 使用现有 `/login` SSR、`getSeoOrigin` RPC、CSS 和中英文 HTML；没有新增生产测试端点。

Nitro 将 Start SSR 与 HTTP runtime 分别构建。HTTP entry 创建唯一进程资源，通过原始 Request 的 symbol 字段传入 WebRuntime；SSR entry 重新建立自己 bundle 内的 WebRuntime 与日志上下文，因此响应和业务日志共享 requestId。实际 TCP peer 来自 srvx `request.runtime.node.req.socket.remoteAddress`，可信代理 CIDR 仍按 A3 的规则处理。

## 启动与退出

两个进程各拥有有限 app SQL 池和 Valkey 客户端，共用部署的 `CACHE_NAMESPACE`。jobs 不启动消费者或 Cron；任务能力保持 unavailable，等待组 9.1 正式装配 B。Node 文件/Workers AI 能力也保持 unavailable，媒体在副作用前拒绝。

`GET /internal/live` 仅检查进程存活，返回 no-store；jobs 同时报告 queue/scheduler unavailable 与 null 心跳，web 含完整 SHA。完整依赖 readiness 属于 A8.1，不能用本次 liveness 宣称队列或完整认证 e2e 已就绪。

Nitro 默认 close hook 发生在 HTTP close 之后，srvx 默认机制还使用后台集合快照，不能保证等待在途请求后来注册的结算。故 `node_server` 的正式 `entry` 配置采用自有监听入口，关闭默认 gracefulShutdown，复用 A3 的动态任务跟踪。SIGTERM / SIGINT 的幂等顺序为：停止接收并拒绝后续请求 → 排空 handler、HTTP 输出与 waitUntil → 关闭 Valkey/自有 SQL 池及 Nitro close hooks → 关闭残留 socket 并退出。所有阶段共用 `SHUTDOWN_TIMEOUT_MS`，不完整时退出 1；正常完成退出 0。web 等待监听成功，端口占用走同一脱敏启动失败/资源关闭路径。

构建期 Nitro preview 只 import fetch，没有生产 listen/config/resource/signal 副作用。公开页的 DB/auth/cache getter 明确 unavailable，使用既有失败降级，不能伪造生产能力。

Node 未添加 Workers CPU 或响应后 30 秒限制。模型业务 timeout、缓存连接/命令 timeout、健康探测 timeout 与停机 deadline 仍各自生效。waitUntil 无 crash durability，SIGKILL/机器故障仍依赖既有 usage checkpoint、账本幂等与 hold 回收；持久任务由 B 提供。

jobs 通过 esbuild 编译 workspace 源码，外置第三方依赖，包括原生模块的加载边界；产物检查验证所有 emitted externals 为直接 production dependency 且能从产物路径解析。platform 的 B barrel 当前使 jobs 保留 DBOS/pg import，但不装配引擎。web 使用 Nitro 原生 external/tracing，并剪除未使用的 B 导入；没有 `cloudflare:*`、workerd 或 Sentry Cloudflare 运行时导入。原生依赖的 Linux/架构构建属于后续镜像验收。

## 生产 HTTP 断连与 A6.3

测试用隔离 PG17、Valkey 和本地 OpenAI-compatible SSE 服务，启动实际 `.output/server/index.mjs`，通过真实会话与套餐执行现有 chat handler。客户端收到首个 text delta 后取消响应，服务端继续获取最终 `100` input / `1000` output usage，保存 `first last`、completed 消息和 captured hold，余额由 100 降到 89，扣费 11。第二次在断连后立即发 SIGTERM，最终余额 78、上游完整结束、退出 0，没有取消上游或重复扣费。没有访问真实模型服务，也没有生产 mock 开关。

两出口正常 usage、per_call、超额、停止/错误估算封顶及重复结算复用既有 `vitest.ai-node.config.ts` 套件。本次生产 HTTP 断连补齐 A6.3 的剩余验收；队列/邮件/Compose e2e 仍等待后续组 9。

## Cloudflare 产物对比

基线 commit 为 `272066053fa15af6b6c0a36c08ee89c84a433ef6`。在同一 checkout、同一依赖/数据库状态下，分别用该提交原始 `vite.config.ts` 与抽取共用配置后的默认配置执行 `pnpm --filter @product-res/web build`，按相对路径枚举 `dist`，计算 SHA-256。两边均为 690 文件，无新增/删除；672 文件逐字节相同，包含 Worker entry、Wrangler 配置、JS/CSS、sourcemaps、OG 和定价快照。18 个预渲染 HTML 仅 TanStack match 的 hydration `u:<13位毫秒时间>` 不同；只归一化 `,u:\d{13}(?=,s:)` 后 18 页也逐字节相同。预渲染范围和默认 `dist/server/wrangler.json` 部署入口均保持。

开始时、安装 Nitro 前也保存了一轮 690 文件散列；该轮与最终产物受到测试数据库套餐变化和 pnpm optional-peer 路径变化影响，不能用其原始 chunk 文件名散列衡量配置行为。上述控制实验固定这些输入，检查配置改动本身；默认 CF 全量测试、构建和 Playwright e2e-smoke 另行验证依赖接入后的行为。

重做对比时按顺序构建，保存第一轮非敏感产物/散列，再构建第二轮；不要并行运行两个目标的生成器（两者共用 Paraglide/content 生成目录）。不复制或打印 `.dev.vars` 的内容；随机 fallback secret 不属于部署内容。

## 测试与 CI

Node CI job 独立创建 PG17 和 Valkey，初始化既有三角色，使用隔离 `product_res_ci`，无 staging secrets 或部署步骤。保持原 check、e2e-smoke 和 deploy-staging 工作流。Node job 顺序执行（本地 Node 基础 runner 12 个项目、687 用例通过，jobs Node unit 28 用例、生产 jobs smoke 1 用例、web 生产 HTTP smoke 5 用例通过）：

```sh
pnpm --filter @product-res/web test:node
pnpm --filter @product-res/jobs test:node
pnpm --filter @product-res/jobs test:node:integration
pnpm build:node
pnpm --filter @product-res/web test:node:production
```

web runner 先生成文案/内容，再执行 config、AI、platform Node unit、DB/credits、Valkey、auth、billing、entitlements、web AI/public/files/admin 的现有 Node 套件。PG/Valkey 缺失直接失败，不跳过；共享测试库的业务套件顺序执行。CF-specific 适配器仍由原 workers-pool 项目验证。

本地提供 worktree 的 PG 配置与独立 `TEST_VALKEY_URL` 后运行相同命令。另完成根 `pnpm check`、`check:deps`、`check:singletons`、`dedupe --check`、`typecheck`、`test`、`build` 及默认 Playwright e2e-smoke。CI 结果以本 PR 的 checks 为准；合并后的 main staging SHA 验收仍属于协调者/A8.3。

PR #126 实现提交 `9da1959` 的 [CI run 38280750963](https://github.com/ustclhx/product-res/actions/runs/38280750963) 三个 job（check、node、e2e-smoke）全部通过，5.1–5.3 与 6.3 已勾选。后续提交仅补验收记录与勾选。

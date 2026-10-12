# saas-template 自托管部署模板需求（Docker Compose）

更新：2026-10-12。提出方：product-res（eBay 跟卖选品平台）。实施方：saas-template。本文只描述需求和验收标准，具体技术选型由 saas-template 决定。

## 1. 目标

为 saas-template 增加一个**自托管部署目标**作为扩展能力：在任意一台 Linux 云服务器上，用 Docker Compose 原生运行全部服务，与云服务器供应商无关。

- **Cloudflare 仍是主目标：** 现有 Cloudflare 部署能力完整保留，自托管只是新增的可选目标。改造不得降低 Cloudflare 目标的功能、性能或测试覆盖。

- **与供应商无关：** 只依赖 Linux、Docker Engine 和 Docker Compose v2。不使用任何云厂商专有的服务、SDK 或元数据接口；换一家云服务器、换一个区域，部署步骤都不变。
- **业务代码不分叉：** 业务代码通过适配层访问平台能力。部署目标的差异收敛在适配层、配置和 Compose 文件中。
- **首个使用方：** product-res 将部署在新加坡的一台 ECS 上；ECS 只是“一台普通 Linux 服务器”，不使用阿里云的任何专有服务。

### 非目标

- Kubernetes、多节点集群、自动扩缩容。
- 跨机器高可用。单机部署，靠备份和恢复演练保障数据安全。
- 绑定某一家对象存储、邮件或监控服务商。

## 2. 现状：模板对 Cloudflare 的依赖清单

依据 saas-template `e40bd89`（2026-10-12）的源码统计，不含测试和探针：

| 能力 | 当前 Cloudflare 实现 | 使用情况 |
|---|---|---|
| 运行时 | workerd + `@cloudflare/vite-plugin`；`import { env } from 'cloudflare:workers'` | 约 90 个文件通过 `cloudflare:workers` 读取全局 env；13 处使用 `Cloudflare.Env` 类型 |
| 数据库连接 | Hyperdrive（`HYPERDRIVE`、`HYPERDRIVE_CACHED`、`HYPERDRIVE_MIGRATOR`），`createDb()` 按请求创建客户端 | `env.HYPERDRIVE` 94 处、`HYPERDRIVE_MIGRATOR` 19 处 |
| 缓存/KV | KV `CACHE`：Better Auth `secondaryStorage`、配置缓存 | 36 处 |
| 对象存储 | R2 `FILES`；预签名 URL 固定为 `<account>.r2.cloudflarestorage.com` | 41 处；`packages/storage/src/presign.ts` |
| 队列 | Queues `EMAIL_QUEUE`、`EVENTS_QUEUE`；消费者批量 10、最多重试 5 次 | 15 处 |
| 持久多步任务 | Workflows（`WorkflowEntrypoint`、`step`、`NonRetryableError`，跨 Worker 的 `sendEvent`） | `AI_MEDIA_WORKFLOW` 12 处 |
| 定时任务 | Cron Triggers（5 条：每 5 分钟、每 10 分钟、每小时、每日 03:00、04:00） | `apps/jobs` |
| 限流 | Rate Limiting 绑定 `RL_AUTH`、`RL_AI`、`RL_API` | 12 处 |
| 请求后台延续 | `waitUntil`（客户端断开后继续读完模型流并结算） | AI 对话 3 个文件 |
| AI | AI Gateway（`AI_GATEWAY_*`）、Workers AI 绑定 `env.AI` | `packages/ai` |
| 人机验证 | Turnstile | 认证页面和 growth 表单 |
| 客户端 IP / 请求标识 | `cf-connecting-ip`、`cf-ray` | 认证保护、日志 |
| 错误监控 | `@sentry/cloudflare` | web 和 jobs |
| 密钥 | Wrangler secrets、`.dev.vars` | — |
| 测试 | `cloudflare:test`（vitest workers 池） | jobs 和集成测试 |

## 3. 功能需求

优先级：**P0** = product-res M0 的前置条件；**P1** = 应当提供；**P2** = 可选。

### 3.1 运行时与配置

| 编号 | 需求 | 优先级 |
|---|---|---|
| R1 | web 和 jobs 以 Node.js（LTS）进程运行，TanStack Start 使用 Node 服务端输出 | P0 |
| R2 | 提供统一的 env 访问接口，替代 `cloudflare:workers` 的全局 env；业务代码不再直接 import `cloudflare:*` | P0 |
| R3 | env 由 `packages/config` 的 Zod schema 统一校验；缺失或非法时进程启动即失败并给出明确提示 | P0 |
| R4 | 密钥支持 `.env` 和 `*_FILE` 两种方式（`*_FILE` 指向挂载的密钥文件）；镜像和仓库不含任何凭据 | P0 |
| R5 | 允许使用原生 Node 模块（例如图片处理库），不受 Workers 打包体积限制 | P0 |
| R6 | 请求和后台任务都没有平台强加的 CPU 时长上限；长任务只受业务自身的超时配置约束 | P0 |

### 3.2 数据库

| 编号 | 需求 | 优先级 |
|---|---|---|
| D1 | 进程级连接池直连 Postgres 17，替代 Hyperdrive；`createDb` 接受连接串或连接池，并保持对 Cloudflare 目标的兼容 | P0 |
| D2 | 保留现有的 `app`、`migrator`、`readonly` 三个最小权限账号 | P0 |
| D3 | 迁移以一次性容器执行（使用 `migrator` 账号），部署流程中先迁移、再启动应用 | P0 |
| D4 | 保持事务、`SELECT … FOR UPDATE`、`pg_advisory_xact_lock` 的现有语义 | P0 |
| D5 | Postgres 不对公网开放端口，只在 Compose 内网可达 | P0 |

### 3.3 缓存、限流、对象存储

| 编号 | 需求 | 优先级 |
|---|---|---|
| C1 | KV 替换为 Compose 内的开源缓存服务（例如 Valkey/Redis），实现 Better Auth `secondaryStorage` 和配置缓存 | P0 |
| C2 | 限流使用同一缓存服务实现，保持 `RL_AUTH`、`RL_AI`、`RL_API` 的配置语义 | P0 |
| S1 | 对象存储改为通用 S3 兼容接口：endpoint、region、bucket、path-style 均可配置；预签名 URL 不写死域名 | P1 |
| S2 | Compose 提供可选的自带对象存储服务（例如 MinIO），也可以改接外部任意 S3 兼容服务 | P1 |

### 3.4 队列、定时任务、持久多步任务

product-res 的每日采集流水线是主要使用方，这部分要求最高。

| 编号 | 需求 | 优先级 |
|---|---|---|
| Q1 | 队列：至少一次投递、按队列配置重试次数和退避、死信记录、批量消费 | P0 |
| Q2 | 支持在业务数据库事务内入队（事务回滚时任务不发出），或提供等价的 outbox 机制 | P0 |
| Q3 | 每个队列可配置消费并发度和速率上限（product-res 需要按外部 API 额度控制调用节奏） | P0 |
| J1 | 定时任务在 jobs 容器内调度，支持 cron 表达式和**时区配置**（product-res 使用 Asia/Singapore） | P0 |
| J2 | 同一定时任务不会并发重复执行（例如用数据库锁选主）；服务器停机期间错过的运行有明确的补跑策略（可配置跳过或补跑一次） | P0 |
| J3 | 保留现有 heartbeat 机制，健康检查能看到最近一次定时任务运行时间 | P0 |
| W1 | 持久多步任务：步骤结果持久化、失败按步骤重试、`sleep`、带超时的 `waitForEvent`、不可重试错误、外部 `sendEvent` | P1 |
| W2 | 容器重启后，未完成的多步任务从最后一个成功步骤继续执行 | P1 |
| W3 | 事件早于 `waitForEvent` 到达时会被保留（当前 Cloudflare 实测保留至少 60 分钟），自托管版本至少保持同等语义 | P1 |

### 3.5 HTTP 入口与安全

| 编号 | 需求 | 优先级 |
|---|---|---|
| H1 | Compose 内置反向代理（例如 Caddy 或 Nginx），对外只开放 80/443；支持 ACME 自动签发证书，也支持自带证书 | P0 |
| H2 | 客户端 IP 从可信代理头读取（例如 `X-Forwarded-For`），可信代理列表可配置，替代 `cf-connecting-ip` | P0 |
| H3 | 请求 ID 由应用生成；`cf-ray` 存在时附带，不存在时不影响功能 | P0 |
| H4 | 容器以非 root 用户运行；只有反向代理容器暴露端口 | P0 |
| H5 | Turnstile 保留为可选开关；关闭时认证流程正常可用 | P1 |

### 3.6 后台延续与 AI

| 编号 | 需求 | 优先级 |
|---|---|---|
| A1 | 提供 `waitUntil` 的等价实现：请求结束后继续跟踪后台 Promise，进程优雅退出时等待它们完成（有超时上限） | P0 |
| A2 | AI 文本模型支持直接配置 OpenAI 兼容的 base URL 和密钥（例如经由 NewAPI 接入 DeepSeek）；AI Gateway 变为可选 | P0 |
| A3 | 用量记录、预算和结算逻辑（`packages/ai`）在两种部署目标下行为一致 | P0 |
| A4 | Workers AI 绑定在自托管目标下默认关闭，相关功能自动隐藏或降级 | P2 |

### 3.7 可观测性与邮件

| 编号 | 需求 | 优先级 |
|---|---|---|
| O1 | 结构化 JSON 日志输出到 stdout，Docker 日志开启滚动（大小和保留份数可配置） | P0 |
| O2 | `/api/health` 报告数据库、缓存、队列、最近定时任务时间和部署版本（完整 git SHA） | P0 |
| O3 | Sentry 改用 Node SDK，可选开启 | P1 |
| E1 | 邮件发送可配置为 Resend 或通用 SMTP | P1 |

### 3.8 备份与恢复

| 编号 | 需求 | 优先级 |
|---|---|---|
| B1 | 每日基础备份 + 持续 WAL 归档到任意 S3 兼容存储；保留策略可配置（默认 7 天每日 + 4 周每周） | P0 |
| B2 | 每日 `pg_dump` 逻辑备份 | P1 |
| B3 | 提供恢复脚本和 runbook：在一台新服务器上恢复到指定时间点 | P0 |
| B4 | 提供恢复演练脚本：恢复到临时实例并运行校验 | P1 |
| B5 | 支持把备份同步一份到第二家存储服务商（防止单账号丢失） | P1 |

### 3.9 构建、部署与项目生成

| 编号 | 需求 | 优先级 |
|---|---|---|
| P1 | CI 构建 web、jobs、migrate 镜像，同时支持 amd64 和 arm64，推送到任意 OCI 镜像仓库（默认 GHCR），镜像标签为 git SHA | P0 |
| P2 | 部署方式：在服务器上执行 `docker compose pull && docker compose up -d`；提供通过 SSH 执行的部署脚本或 GitHub Actions 工作流 | P0 |
| P3 | 部署后自动检查 `/api/health` 返回的 SHA 与目标版本一致；不一致时提示并给出回滚命令 | P1 |
| P4 | 提供一键初始化脚本：在一台全新的 Ubuntu/Debian 服务器上安装 Docker、配置防火墙（只开放 22/80/443）、生成 `.env` 骨架 | P1 |
| P5 | `create-project` 增加部署目标参数（例如 `--target selfhost`），并且在关闭 billing、credits、营销、i18n 等模块后，自托管目标仍能正常构建和运行 | P0 |
| P6 | Cloudflare 目标保持为主目标，现有 CI 和 staging 发布不受影响；自托管目标在 CI 中至少完成构建和单元测试 | P0 |

## 4. 参考 Compose 拓扑

```
                 Internet
                    │ 80/443
             ┌──────▼──────┐
             │ proxy       │  Caddy/Nginx，ACME 证书
             └──────┬──────┘
          ┌─────────┴─────────┐
   ┌──────▼──────┐     ┌──────▼──────┐
   │ web (Node)  │     │ jobs (Node) │  调度器 + 队列消费 + 多步任务
   └──────┬──────┘     └──────┬──────┘
          ├─────────┬─────────┤
   ┌──────▼──┐ ┌────▼────┐ ┌──▼───────────┐
   │postgres │ │ valkey  │ │ minio (可选)  │
   └────┬────┘ └─────────┘ └──────────────┘
        │
   ┌────▼──────────┐       ┌──────────────┐
   │ backup        │──────►│ 任意 S3 兼容  │
   └───────────────┘       └──────────────┘
   migrate：一次性容器，部署时先运行
```

- 全部服务都配置健康检查、`restart: unless-stopped` 和资源上限。
- 数据卷：postgres、valkey、minio、proxy 的证书。
- 资源基线：2 核 4 GB 内存的服务器能够运行全套服务（product-res 的数据规模：每日约 3000 行快照，一年约 100 万行）。

## 5. product-res 的具体使用场景（供模板验证参考）

| 场景 | 涉及的需求 |
|---|---|
| 每日 02:00（新加坡时间）启动采集流水线，按步骤执行，总时长可能 1–2 小时 | J1、J2、W1、W2、R6 |
| 调用 eBay API 前在数据库事务内预扣额度，并发和速率受控 | D4、Q2、Q3 |
| 详情补全、商品簇归并的任务批量入队 | Q1、Q3 |
| 图片相似度计算需要原生图片处理库 | R5 |
| 通过 NewAPI 调用 DeepSeek，用量按次记录 | A2、A3 |
| 出站访问 eBay、DataForSEO、1688 等外部 API | 不限制容器出站网络 |
| 团队共用一个账号，不需要计费、积分、营销页 | P5 |
| `listing_snapshots` 按月分区 | D3（迁移需要支持原生 SQL） |

## 6. 验收标准

本期只需在**本地**（开发机 Docker）和**新加坡 ECS** 上跑通，不要求在多家云服务商上验证。

1. 本地和新加坡 ECS 都能按文档从空白环境部署到可访问，部署过程不使用任何厂商专有配置。
2. Cloudflare 目标的现有测试、staging 自动发布和健康检查不受影响。
3. 模板现有的单元测试和集成测试在 Node 目标下全部通过；认证 e2e（注册、验证、登录、空间切换）通过。
4. 定时任务按配置的时区准时运行；同时启动两个 jobs 实例时，同一定时任务不会重复执行。
5. 队列消费失败后按策略重试，达到上限后进入死信；在事务内入队、随后回滚时，任务不会被执行。
6. 多步任务执行到一半时重启 jobs 容器，任务从断点继续并最终完成。
7. 执行一次恢复演练：从 S3 备份恢复到本地或 ECS 上的临时实例，恢复到指定时间点，数据校验通过。
8. 服务器重启后，所有服务自动恢复，健康检查返回正确的版本 SHA。
9. 除反向代理的 80/443 外，没有对外开放的端口；所有容器以非 root 用户运行。

## 7. 需要模板方决定的问题

1. **队列和多步任务的技术选型**：基于 Postgres 的方案（便于在事务内入队、少一个组件），还是基于 Redis 的方案？
2. **默认是否内置对象存储服务**，还是默认要求配置外部 S3 兼容服务？
3. **反向代理**：Caddy 还是 Nginx？

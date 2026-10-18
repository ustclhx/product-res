# C 共享接线：配置、观测与构建

本批只覆盖 C 1.1、1.4、2.1–2.4、3.1、3.3。S3/SMTP adapter 实现未修改；经用户授权，Sentry adapter 仅补安全 debug metadata 白名单，
没有移植 B 媒体 workflow、改 staging 触发器或承接 D 的镜像/发布/部署。

## Node 配置

所有错误只报告字段名；密钥继续通过既有 env/固定 `_FILE` allowlist 读取。

| 能力 | 参数与启用规则 |
| --- | --- |
| S3 | `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 必需；`S3_FORCE_PATH_STYLE` 只接受字符串 true/false，默认 true。任一原始字段出现便要求完整配置；全部未配置保持 unavailable。 |
| SMTP | `EMAIL_TRANSPORT=smtp` 时要求 `SMTP_HOST`、`SMTP_PORT`、`EMAIL_FROM`；`SMTP_TLS_MODE` 默认 starttls，可显式 implicit/none。user/password 必须成对；from/replyTo 只接受单邮箱，可带显示名。不要求 Resend key，不跨通道回退。 |
| Sentry | `SENTRY_DSN` 可选，空值关闭；`SENTRY_ENVIRONMENT` 为 development/staging/production/smoke，可省略，无默认值。只有 DSN 非空且 staging/production/smoke 才加载 SDK。 |

新增 `_FILE` 仅限 S3 两个凭据、SMTP_PASSWORD、SENTRY_DSN，不对 host/port/user/endpoint
开放任意文件读取。URL 禁止内嵌密码、query/fragment，S3 同时禁止 username；production 环境
要求 S3/DSN 使用 HTTPS。SMTP none 仅供显式受控内部中继或本地协议 fixture，不能自动降级。
SMTP 配置语法在资源创建前拒绝，服务可达性由异步发送与原重试处理，不在启动时 verify。
Cloudflare 的邮件 enum/helper 保持 log/resend，不加载任何 Node adapter。

## 观测与停机

web 构建先生成 Nitro 输出，再将其入口改为 `application.mjs`，独立编译早期 bootstrap
为 `index.mjs`；启动命令仍为 `pnpm start:node`。jobs 的 `index.node.ts` 同样先初始化
observer，再动态导入 runtime，esbuild splitting 保留加载顺序。复制部署产物时必须保留
整个 `.output/server` 和 traced node_modules，不能只复制单个入口。preview 导入无配置、
资源池、SDK 初始化或 signal 副作用。

web 的三个 bundle 各有自己的日志 ALS 与 AppError 类。桥接传当前调用点的身份快照，
在产生错误的 bundle 内识别 AppError，再在 observer bundle 内按原对象缓存安全错误摘要；
保留低于 500 的过滤、机器码、源码 frame 和同对象去重。runtime 包装复制属性描述符，
保持 getter 惰性及 own/enumerable，文件 handler 展开依赖仍能读到 db/auth。
Node envelope 沿用 adapter 白名单，受信任资源错误在 Nitro/SSR 边界重建为调用方 AppError，
保留 S3 502/机器码，避免文件响应吞错时退化成 INTERNAL_ERROR。异常文本的最后安全边界
只在 Sentry 发送路径：Node beforeSend 白名单移除任意异常 message/stack/cause 原文，
保留安全机器码与结构化源码 frame。shared redact 的日志路径继续保留原有
name/message/stack/cause 与按字段名脱敏，CF/shared 日志回归保持原样。

SIGTERM/INT 沿用 A 的绝对 deadline。web 停 HTTP、排空请求/waitUntil、关闭缓存/DB/Nitro；
jobs 停领取、DBOS 排空、关闭业务/缓存池。之后监控仅使用剩余时间 close/flush，剩余零时
跳过 SDK close(0)，因为 SDK 的零超时表示无限等待。监控挂起/失败不改变业务资源结果，
不会另加退出预算；SIGKILL、预算耗尽或递归 fatal 可能丢失尚未发送的事件。

## Source maps

```sh
pnpm build:node
node --test scripts/sentry-node-maps.test.mjs
# 仅上传步骤通过进程环境注入 SENTRY_AUTH_TOKEN、SENTRY_ORG、SENTRY_PROJECT。
# SENTRY_RELEASE 必须为当前两份产物固化的完整 Git SHA。
node scripts/sentry-node-maps.mjs --upload
```

根 Node build 无上传凭据也通过，自动离线注入 debug ID，并删除 `.output/public` 下全部 maps。
web Nitro/SSR/bootstrap 与 jobs chunks 均带 server maps；jobs 构建先清理旧 server chunks。
两 app 的 `.output/node-build.json` 保存完整 SHA 与 dist，上传前必须同版本匹配。
上传沿用 release → inject → upload → finalize，只选择 `.output/server`，dist 分别为
web-node/jobs-node，不串用 CF 的 dist/server、web/jobs。上传凭据不在应用 schema、
模板配置或 build ARG 中；非 upload 的 CLI 环境移除 SENTRY_*。

web 的 SSR 代码先由 Vite service 环境编译到 `node_modules/.nitro/vite/services`，再由 Nitro
rolldown 二次打包进 `.output/server/_ssr`。`vite.node.config.ts` 在二次打包 load 时交出中间
map 以串接到 TypeScript，并关闭 Nitro 默认 `sourcemapMinify`（它会删除 sourcesContent，
并清空来源全在 node_modules 的 mappings）。inject 前 `assertNodeMaps` 拒绝缺源码、空 mappings
或未串接的中间 map；已构建时测试会把 `sentry-test.ts` 的 throw 位置映射回源码并读取 sourcesContent。
生产 HTTP 对 map 路径返回 404，不把 server 输出当作公开静态目录。

## 本批验收与边界

配置 39 个用例、shared 22 个用例通过；Node 文件/HTTP/Sentry Docker runner 18 个用例
验证实际上传确认下载、权限/配额/清理、storage-only task/hold 不变、并发管理员身份、
真实 transport 捕获后可达/挂起/禁用三模式 SIGTERM 退出，以及 map URL 404。
bridge fixture 另验证两空间隔离、跨 bundle 业务码/过滤与去重。
jobs 的 65 个 Node unit 及真实持久 SMTP/生产停机/Cron 验收见 jobs 接线记录。
maps fixture 验证路径/dist/SHA、上传凭据隔离与公开 maps 删除。实际产物 web/jobs envelope 保留 debug_meta.images，并逐项匹配本地 map 的 debugId；签名 URL、非法 UUID、缺失文件与任意 metadata 正文被白名单拒绝。
根 check、依赖/单实例/dedupe、typecheck、test、CF build 与 Node build 是 PR 门槛。

1.5–1.7 的 profile/CORS/全栈资源/外部 S3、2.5 的真实 Sentry 项目源码映射、3.4 的认证
邮件端到端、4.x 的后续跨组验收均不在本批，保持待办。本地 transport/协议 fixture
不替代真实服务联通或部署证据；不手工部署 staging、不合并或归档 change。

# Node Sentry adapter：C 2.1–2.2 模块交付

本批新增 web/jobs 的 `src/node/observability.ts`，各自提供
`initializeNodeObservability({ dsn, environment, release })`。SDK 精确锁定
`@sentry/node@11.6.0`，与现有 Cloudflare SDK 系列一致；不新增观测 package，
不让业务导入目标 SDK。两个应用保持少量相同的安全代码，避免跨 apps 依赖或改动 shared。

## 开启与调用契约

- 配置对象由 composition 显式提供，adapter 不读取 env 或 `_FILE`。
- 只有非空 DSN 且 environment 为 `staging` / `production` / `smoke` 时加载和初始化 SDK。
  缺 DSN、缺 environment、development 均不加载 SDK、不创建 transport，不发网络请求。
- `release` 必须由调用者提供构建固化的完整 Git SHA。dist 固定为 `web-node` / `jobs-node`。
- 每个进程只初始化一次，不能在请求、消息、Cron 或预渲染中重复初始化。
- web 返回对象的 `enabled/captureError` 实现现有 WebRuntime.observability；
  jobs 的 `tagContext/captureException` 实现现有 JobObserver。
- `run(fn)` 为整个异步工作单元建立新的 isolation scope 和 current scope，返回原结果或原异常。
  capture 另外建立独立身份快照，兼容鉴权后 `setLogContext`；`tagContext` 不写全局 scope。
  允许的身份标签是 requestId、workspaceId、userId、jobId、taskId、scheduleId、cron。
- 同一个异常对象在本进程 observer 内最多捕获一次；primitive 异常不跨任务去重。
  web 过滤 redirect、notFound、低于 500 的 AppError；jobs 过滤低于 500 的 AppError。
  所有主动采集都先保留固定事件名和安全码的共享 JSON 日志。

## 发送安全边界

`nodeBeforeSend` 先调用既有 `sentryBeforeSend`，再按白名单重建事件。它丢弃
message、原始 stack 文本、cause 文本、details、extra、contexts、request、breadcrumbs、
用户邮箱、附件入口之外的正文等事件内容；不依赖敏感字段名或凭据正则识别任意正文。
只保留事件/版本元数据、身份 ID、安全异常类型、机器码和结构化源码位置。
AppError 的 code 是内部受信任机器码（大写字母/数字/下划线，最多 64 字符），其余异常
统一为 `INTERNAL_ERROR`。身份字段由现有应用 ALS 契约提供，不能用来放用户正文或外部凭据。

结构化 frame 只保留实际存在的本地 JS/TS 文件及行列号，不保留任意函数名、源码行、变量；
外部 URL、查询/fragment、无效 file URL 和不存在的伪造文件位置被丢弃。
这同时覆盖 `Error.stack` 中伪造函数名、链接凭据与签名 query 的风险。
生产上传映射仍须在 C 2.3 验证；运行时保留生成 JS 的本地位置，不表示真实源码映射已验收。

SDK 使用 Node 11.6 的实际 API：`defaultIntegrations:false`，仅启用 adapter 内的
NodeUncaughtException integration；不安装 HTTP、DB、AI、Queue、Console、LinkedErrors 或 RequestData integrations。
`dataCollection` 关闭用户资料、headers、cookies、正文、query、DB/AI/Queue 内容、局部变量和源码行。
关闭运行时模块注入和 OpenTelemetry setup，static trace lifecycle + sample rate 0，
丢弃 log/metric/transaction，不启用 SpanStreaming、debug、Spotlight 或 client reports。

未处理 rejection 沿用 Node 原生 throw 策略，不新增会改变退出语义的 rejection 监听器。
默认致命异常经 SDK client 采集，安全日志后在 2 秒 fatal flush deadline 内退出 1；已有
uncaughtException 处理器存在时沿用该处理器的退出策略。SDK 11.6 的默认 uncaught integration
在 flush 期间第二次异常会打印原文，因此使用本模块的最小 integration：第二次异常直接
安全退出，client.close 时移除监听器。递归 fatal 退出可能丢失未发出的事件。
正常 SIGTERM/INT 的共享 deadline
接线属于 C 2.4，本批没有接入或宣称完成。

## 独立 fixture

```sh
pnpm --filter @product-res/web exec vitest run --project unit src/node/observability.test.ts
pnpm --filter @product-res/jobs exec vitest run --config vitest.unit.config.ts test/node-sentry.unit.test.ts
```

web 4 个核心用例：子进程 resolve hook 证明禁用时不加载 SDK；完整 Node bundle 的
metafile 无 CF SDK；本地 HTTP 接收端捕获真实默认 transport envelope，验证并发身份、
过滤、去重、恶意异常、全局 scope PII/breadcrumbs 不外泄；真实致命异常子进程验证
自动采集、安全日志及退出码（另覆盖 flush 等待期间连续两次 fatal）。jobs 4 个核心用例使用真实 SDK transport envelope，
验证禁用零初始化、并发消息 jobId/身份隔离、安全 frame/机器码、过滤，以及拒绝 transport 时
真实邮件 consumer 的 ack/retry、终态 DLQ 写入与 sink 失败语义不变。

这些 fixture 不使用外部 DSN 或凭据，不修改现有 CF Sentry/shared 脱敏用例。
它们证明 adapter 模块，不替代入口集成、真实 Sentry 项目、source map 或退出验收。

## 共享接线补丁（协调者串行整合）

### 配置与依赖

本批已在 `apps/{web,jobs}/package.json` 增加 `@sentry/node:11.6.0` 并更新 lockfile；
根 manifest 没有新增依赖。协调者合并其他组依赖时按并行计划重生成 lockfile。

`packages/config/src/node-schema.ts` 的字段已经存在，但仍为任意 string；建议接线时明确：

- `SENTRY_ENVIRONMENT`: `z.enum(['development','staging','production','smoke']).optional()`；
  无默认值，缺失继续关闭监控。
- `SENTRY_DSN`: 可选且空值继续关闭；非空校验 HTTP(S) DSN、public key 与项目 ID，
  不允许 password/query/fragment。真实生产用 HTTPS，本地协议 fixture 可用 HTTP。
  无效值只报告变量名，不让 SDK 打印原始 DSN。
- 将 `SENTRY_DSN` 加入固定 `nodeSecretNames`，复用已有 `_FILE` 冲突/空文件/读取失败规则。
  不添加 SENTRY_AUTH_TOKEN 到应用 schema 或 `_FILE` allowlist。
- `release` 直接来自现有构建 `__APP_VERSION__` / jobs `applicationVersion`，
  不新增部署可覆盖运行时版本的配置字段。

### 早期 ESM 与 web

初始化应早于应用模块导入；遵循 [Sentry Node ESM/--import 指南](https://docs.sentry.io/platforms/javascript/guides/node/)。
Node bootstrap/preload 在生产分支读取并校验配置，await 初始化后再 dynamic import 应用入口。
构建期 Nitro preview 不执行 preload、不读取部署密钥、不初始化 SDK。若采用 `--import`
产物，构建脚本、启动命令与运行镜像复制清单须同时包含该文件，并以实际产物测试证明顺序。
不要仅在 `http.ts` 的 listen 前调用，却已经静态导入了整个应用。

web 的 Nitro 与 Start 分别构建，须传同一个进程 observer，不能在两个 bundle 各自 init。
可由 Node bootstrap 持有并传入资源工厂；若跨 bundle 必须交换，使用 Node 专属
`Symbol.for('saas.node.observability')` 保存 observer 对象，不能在全局对象保存用户身份。

1. `createNodeWebProcess` 接受已初始化 observer，替换 `runtime.ts` 当前关闭 stub，
   每个 requestRuntime 引用同一 observer。
2. `http.ts` 请求入口用 `observer.run(() => withNodeRequestContext(...))` 包裹整条
   请求链，继续原生 Request 转换、background 计数、响应完成和 abort 行为。
3. `server.node.ts` 顶层 catch 调用同一 observer.captureError；移除原始 `{error}`
   的重复日志，保持原响应状态/业务错误体。共享 `server/sentry.ts` 已转发此 observer，
   同一 Error 对象重复通知会去重。
4. Node `createStartHandler` 复用 CF `server.ts` 的 loader match 错误检查，确保
   SSR loader 已被框架转换的异常也进入 captureServerError，不只覆盖顶层 throw。

### jobs 成员与 Cron

1. `index.node.ts` 在校验配置后初始化 observer，再 dynamic import `startNodeJobs`，
   通过新增的 NodeJobsOptions observer 参数传入，替换 runtime 的 logJobObserver。
2. 持久 queue callback 在批次 jobId 的 ALS 内用 `observer.run` 包裹，外围 catch
   `observer.captureException(error); throw error`；平台仍拥有领取/retry/持久化结果。
3. email/billing 每个成员在现有 withLogContext 回调内再包 `observer.run`，使整个成员
   的自动/主动采集都有独立 scope。不得只在整批 scope 写每个成员的身份。
4. scheduler 的注册单元在 jobId/scheduleId 的 ALS 内用 `observer.run` 包裹；
   Cron handler 外围 capture 后重新抛出，平台仍记录原失败结果。
   registration 只包现有任务，保留 B 的并行组/重试/DLQ 与媒体 gate。

### 共享日志与后续验收

Node envelope 已独立安全，adapter 不要求修改 shared。现有 shared redact 仍原样保留
任意 Error.message/stack/cause，其他业务日志和 web 原始顶层 catch 仍可能泄漏。
若验收要求共享日志也保护任意异常原文，由协调者按 design 增加最小 shared 补丁：
Error 输出固定安全类型/机器码，丢弃 message/stack/cause 原文，保留真正需要的安全定位字段；
同步 CF/shared 回归，不以扩充字段名或匹配少数 token 的正则代替正文保障。

接线后必须重新验证 HTTP/成员/Cron 的实际生命周期、异常传播、loader 和外围 DLQ 错误。
本批 **2.1、2.2 保持未勾选**：早期 ESM/入口接线与全链路共享日志验收尚未完成。
2.3–2.5 未实施，正常停机、debug metadata/source map 上传及真实项目验收由后续批次完成。
无需用户提供外部凭据来复核本批 fixture。

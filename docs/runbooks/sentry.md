# Sentry 服务端错误与 source map

适用范围：`add-observability-and-optional-features` 1.2，web/jobs 的服务端异常。
staging 只由 main 自动发布；本分支不手动部署。原接入验收已由协调者完成，见 §6；
Workflow 原始错误补报修复（#160 后续）仍需合并后按 §3 复核。

## 1. 配置与安全

| 配置 | 位置 | 用途 |
|---|---|---|
| `SENTRY_DSN` | web-staging、jobs-staging 的 Wrangler secrets | 服务端发送事件 |
| `SENTRY_ENVIRONMENT` | 对应 Wrangler 环境 vars | 仅 staging / production / smoke 启用；development 与测试默认不初始化 |
| `SENTRY_AUTH_TOKEN`、`SENTRY_ORG`、`SENTRY_PROJECT` | GitHub staging environment secrets | CI 创建 release、上传 source map、finalize |
| `APP_VERSION` | CI 构建/部署参数 | 完整提交 SHA；web health version 与 Sentry release 相同 |

不要将上传 token 放进 Worker secrets、Wrangler vars、`.sentryclirc`、前端构建变量或产物。
本地真值只从被忽略的 `.env.local` 读入进程环境；不要打印、复制到日志/PR 或作为命令参数。
source map 含源代码，只上传至指定 Sentry 项目，不发布为静态文件，也不分享整个 dist。
`beforeSend` 使用统一脱敏器；不要用真实用户对话、付款信息或凭据作为测试异常内容。

## 2. 自动发布产物与 release

`.github/workflows/deploy-staging.yml` 只接受本仓库 main push 的成功 CI，或 main 的手动运行。
PR CI 不读取 staging secrets，也不上传 source map。

1. jobs 用 staging Wrangler dry-run 输出 `apps/jobs/dist`，web 用 staging Vite 构建输出 `apps/web/dist`。web 预渲染保留不可达的本地 Hyperdrive 占位连接，绝不连接真实库。
2. `sentry-cli releases new <完整SHA>`；对 web SSR 与 jobs 产物分别 `sourcemaps inject`。
3. 分别 `sourcemaps upload --release <完整SHA> --dist web|jobs --validate --strict --wait`。上传完成后删除 web `dist/client/**/*.map`，SSR/jobs map 在私有 Worker 目录内。
4. jobs 使用 `dist/index.js --env staging --no-bundle --var APP_VERSION:<完整SHA>`；web 使用 Vite 输出的 `dist/server/wrangler.json --no-bundle`。部署直接读取注入过 debug ID 的 JS，不能再次构建。
5. 版本健康检查与 staging 冒烟成功后 `releases finalize <完整SHA>`。失败运行不 finalize；修复后从 main 重新运行，不能跳过上传步骤。

Sentry 的 release / SDK release 必须完全相同；dist 分别固定为 `web`、`jobs`，避免同名产物冲突。
Debug ID 注入后的 JS 注释 `debugId` 应与相应 map 的 `debugId`（CLI 3）或 `debug_id` 相同。上传前检查两个入口 map 存在，缺失即停止。

官方依据：[Sentry CLI source maps](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/)、
[release 创建与 finalize](https://docs.sentry.io/cli/releases/)、
[Wrangler deploy / no-bundle](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)。

## 3. 合并后的 staging 验收（协调者执行）

1. 等待 main 自动发布全部成功。读取 `GET /api/health`，记录 UTC 时间、完整 `version`、`db.status=up` 与 Actions run 链接。
2. 在指定 Sentry 项目 **Project Settings → Source Maps → Artifact Bundles** 确认该 SHA 的 web/jobs 两组 artifact bundle；release 页面确认已 finalize。
3. 使用平台管理员账号新鲜登录 staging。在同源页面的浏览器控制台执行以下一次性请求；使用浏览器会话，不粘贴 Cookie/token：

   ```js
   const response = await fetch('/api/admin/observability/sentry-test', {
     method: 'POST',
     credentials: 'same-origin',
   })
   console.log({ status: response.status, requestId: response.headers.get('x-request-id') })
   ```

   预期 500：授权与审计成功后，Worker 入口故意抛出测试异常。503 表示该环境未启用 Sentry，应先核对 DSN 与环境 gate；权限或同源校验失败不算成功触发。
4. 在 Sentry Issues 查询 `environment:staging release:<完整SHA> requestId:<响应请求ID>`。打开事件，确认 release、dist=`web`、requestId，且堆栈显示仓库 TypeScript 源路径、函数、行号与源码上下文，不能仅有打包后的 `index.js` 行号。检查事件 JSON 不含 Authorization、Cookie、邮箱、支付凭据与对话内容。
5. jobs 原始错误补报修复合并后，由协调者等待 main 自动发布成功，确认 health `version` 等于合并提交的完整 SHA，再复跑既有故障套件的 `workers-error` 场景；可另核 `fal-submit-response-lost`。按场景对应 request ID 与同一 release 查询 Sentry，确认 dist=`jobs`、仅上报一次、事件保留原始业务错误与我方 TypeScript 源码堆栈，并检查事件 JSON 脱敏。Workflow 的预期如下：

   - SDK 在 step 最终尝试上报（mechanism=`auto.faas.cloudflare.workflow`）后，外围捕获跳过，不再上报引擎包装错误。
   - 首次尝试抛出 `NonRetryableError` 或引擎提前终止、SDK 未上报时，run 级捕获改报对应 step 回调最后抛出的原始错误，保留我方堆栈；不能使用其他并发 step 的错误。
   - 引擎错误未执行 step 回调、没有对应原始错误时，仍上报引擎包装错误；run 自身以及 Queue/Cron 异常仍应上报。
   - 重试后成功的 step 不上报错误。

   不新增公开 jobs 触发接口，不用破坏业务数据的方式制造错误。
6. 保存脱敏证据：UTC、完整 SHA、Actions run、event ID/事件链接、request ID、映射后的源路径与行号、web/jobs dist、脱敏检查结论。协调者完成所需 staging 验收后才勾选 1.2；此 runbook 不提前宣称通过。

## 4. 本地一次真实事件

应用本地开发和测试默认不发送，即使 `.env.local` 有真实 DSN 也不会自动启用。
显式运行 `scripts/sentry-probe.mjs` 做一次真实事件验证：该脚本用 Miniflare 的
`dispatchFetch` 复用生产的 `sentryOptions`、`withSentry` 与统一 `beforeSend`，仅在探针中模拟 staging 环境，
不新增应用公开路由，也不改变应用的 development gate。探针用 Node 传输桥发送已经脱敏的
SDK envelope，并确认 Sentry 接收端 HTTP 状态；应用使用 SDK 的默认 Cloudflare 传输。DSN 从忽略的 `.env.local` / 进程环境
读入，只发送固定测试异常，不把上传 token 或应用凭据放进事件。
本机探针发送成功后以 Sentry event ID 确认事件，记录 request ID、UTC、release 和脱敏结果。
本地未上传该次构建 source map 的事件只证明发送链路；可读堆栈仍以 main staging 发布产物验收为准。

显式命令（凭据值不出现在参数中）：

```sh
node --env-file=/Users/hxlee/workspace/product-res/.env.local scripts/sentry-probe.mjs
```

2026-10-11T18:26:46.456Z 实测：Sentry 接收端 200；发送前 SDK envelope 不含测试
Authorization/查询串令牌或对话内容。release=`f01d3377b549c2e08748b524ac9119a27311ac99`，
requestId=`03630046-7fe8-45af-bd88-5077170ad292`，
eventId=`a9a002c620074b97a8f328a04a1e5a43`。
当前本地上传 token 查询事件返回 403，因此这次只确认接收，不能宣称事件已经出现在 Issues。
协调者可按上述 event ID 在指定项目核对，或为本地 token 提供事件读取权限后再次显式运行。
探针不创建 release、不上传 source map；staging 的可读堆栈仍待合并后验证。

## 5. 排查

- 没有事件：确认 Worker secret DSN 存在、`SENTRY_ENVIRONMENT` 为 staging/production/smoke，并确认请求真正到达 Worker。认证失败、业务已处理错误和静态 assets 请求不会产生未处理异常事件。
- release 不一致：比较事件 release、health version、Actions 检出 SHA 与 jobs 部署 `APP_VERSION` var，必须都是完整 SHA。
- 没有源码映射：确认 bundle 的 release/dist、debug ID、map 的 `sourcesContent`，以及部署确实读取注入后的 JS。可在仅含 Sentry 环境变量的受控终端运行 `pnpm exec sentry-cli sourcemaps explain <event-id>`；不要开启含敏感请求详情的 debug 日志。
- Workflow 引擎帧：`ContextImpl.wrapper` 等 Cloudflare Workflows 引擎代码不属于仓库源码，无法用项目 source map 映射属于预期。引擎脚本也可能叫 `index.js`，误关联我方 debug ID/map 时会出现 `js_invalid_sourcemap_location`；不能仅凭该引擎帧判定 bundle 注入、上传或部署损坏。若 step 回调已抛错，应检查 SDK step 事件或 run 级补报事件中的原始错误及项目 TypeScript 帧，并按同一 request ID、release 与步骤确认仅有一次上报；未执行回调的引擎错误才保留包装错误。当前保留 jobs 的 `dist/index.js`：去重与原始错误补报对应已核实的捕获问题，改名会扩大构建/注入/部署链路修改且不能提供引擎源码；若后续仍有独立的同名误关联，再单独评估改名。
- 上传失败：检查 GitHub staging secrets 与 token 的项目上传权限；保持失败阻止部署，不增加忽略错误或本地上传绕过。

## 6. 验收记录

| 环境 | 状态 | 证据 |
|---|---|---|
| 本地真实事件 | 接收端 200；入库确认待协调者（查询 403） | `a9a002c620074b97a8f328a04a1e5a43`，详见 §4 |
| main staging 可读堆栈 | 2026-10-14 协调者已核验 web 与 jobs SDK step 的 TypeScript 帧及脱敏；另发现 jobs 重复上报 | [事件与源码映射证据](./evidence/staging-acceptance/2026-10-13/acceptance-2026-10-13j-sentry-verification.json) |

OpenSpec 1.2 已由协调者在 main 勾选；此修复不更改任务勾选、不手动部署 staging。
本次 Workflow 原始错误补报的 staging 复核待 main 合并自动发布后进行，历史事件不代表修复已上线。

## 7. Node 本地真实项目触发（C 2.5）

本次经协调者确认复用现有 `environment=smoke` 与纯完整 HEAD SHA release，
dist 为 `web-node` / `jobs-node`；smoke 在这里表示本地 Node 验收。
没有修改 schema、监控 gate、上传脚本、项目设置、token 或 staging CI。
构建时的 HEAD 记录在证据的 `buildSourceSha`，后续只提交测试、文档与证据。

显式运行顺序如下，默认测试不会执行真实项目探针：

```sh
pnpm build:node
node --env-file=/Users/hxlee/workspace/product-res/.env.local apps/web/test/sentry-local/upload.mjs
node --env-file=/Users/hxlee/workspace/product-res/.env.local apps/web/test/sentry-local/run.mjs
```

upload 包装器复用既有 release → inject → 两个 Node dist upload → finalize 流程，
先验证产物 metadata 与当前完整 SHA 一致。上传子进程只接收所需 Sentry 上传变量；
CLI 输出只保留步骤/结果，403 立即失败，不查找其他凭据。
build 不加载 dotenv，实际 web/jobs 子进程只取得 DSN，不取得上传 token、org 或 project。
探针将本地 DSN 的末尾路径分隔符按 URL 规范化为既有 schema 接受的数字项目路径，
仍使用同一授权项目与公钥，未更换凭据。

探针使用名字含 `c-verify` 的临时 Docker PG/Valkey/SMTP，结束删除自己的容器。
实际启动已上传 maps 的两个生产 Node 输出。管理员通过本地认证工厂完成验证与
bootstrap 提升，生产 HTTP 入口仍执行同源、实时管理员与先审计保护；只调用一次
`sentry-test` 并核对 500 和一条已提交审计。另一条有效邮件经实际持久 inbox/DBOS
到 jobs，由既有 SMTP fixture 的永久 550 路径失败一次并进入持久终态。
未增加公开 jobs 故障接口，也未更改业务实现；公开 `.map` 请求核对为 404。

2026-10-14 本地触发记录见
[`c-2.5-sentry-node-trigger.json`](./evidence/selfhost/c-2.5-sentry-node-trigger.json)。
upload 与生产触发通过，只证明准备与触发完成；事件入库、可读 TypeScript 帧、
脱敏和重复事件仍需协调者在指定 Sentry 测试项目核验，2.5 保持未勾选。

协调者分别查询证据中的 release 与 requestId：

```text
environment:smoke release:<buildSourceSha> dist:web-node requestId:<web.requestId>
environment:smoke release:<buildSourceSha> dist:jobs-node requestId:<jobs.requestId>
```

按记录的 UTC 触发时间定位两条事件，确认 event release/dist/requestId，
Artifact Bundles 的两个 Node dist、debug ID 与源码帧对应；预期我方源码位置分别见
`web.expectedSource` / `jobs.expectedSource`，这些字段不是已映射的核验结论。
保存实际 event ID/链接、源文件/行号与源码上下文，并检查 JSON 无认证头、Cookie、
邮箱、OTP/邮件正文、DSN 或其他凭据，同一触发没有重复上报。全部通过后再勾选 2.5。

2026-10-14 首次核验中 web-node 事件未映射到 `sentry-test.ts`（`js_invalid_sourcemap_location`、
`js_missing_sources_content`）：Nitro 二次打包的 `_ssr/ssr.mjs.map` mappings 为空且只指向中间产物，
`application.mjs.map` 缺 sourcesContent。修复见 [selfhost-c-wire Source maps](./selfhost-c-wire.md#source-maps)；
需用新完整 SHA 重新构建、上传、触发后复核，旧 release 的事件不会因修复而改变。

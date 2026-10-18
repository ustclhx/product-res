# A 8/9：Node 认证与 Compose 尾部验收

最新服务器状态（2026-10-16 UTC）：[1888e7d需求矩阵](evidence/selfhost/server-acceptance-1888e7d/matrix.md)已补齐实际ACME签发/续期、R2与备份恢复、B6.4批准夹具后的复验及真实整机reboot。worker技术验收通过，A9.4仅待协调者审阅。下文为原本机验收快照，其环境/SHA及历史未完成项不代表最新服务器状态。

本轮处理 Node 认证 500、协调者追加授权的 B ownership 补修与 A 8.1、8.2、8.3、9.2、9.3；不勾选 ACME、C 存储/媒体、D 正式交付或 A 9.4。

## 认证修复

srvx 1.0.5 的惰性 NodeRequest 继承原生 Request prototype，但没有 Undici 内部槽。
Nitro 将 HTTP entry 与 Start SSR 分开打包；SSR 中 `new Request(input)` 不经过 srvx 的包装，
误认输入为原生 Request，读取内部 `window` 时抛错。最小生产回归先通过真实
`/api/auth/get-session` 得到 500，断言报 `reading 'window': expected 500 to be 200`。

Node HTTP entry 改为根据 URL、method、headers、body、signal 创建原生 Request，再附加请求
runtime 并交给 Nitro。保留 body 流与取消信号，不缓存正文。Cloudflare 入口没有修改。
生产回归覆盖 get-session、注册/登录的正常 Turnstile 拒绝、真实 sign-out 与旧会话失效；
另外保留 SSR、RPC、静态资源、无 DB 预渲染、AI 客户端断开与 SIGTERM 完整结算。
关闭 Turnstile 后的成功注册/密码登录由下述 Compose e2e 验证。

## 授权补修：B 容器 ownership

原 Compose 重启将 jobs 留在 unhealthy：旧 owner 文件保留了 PID 1 与旧 PID namespace，
原判定只允许同 namespace 的 ESRCH，不能证明新容器中的同号 PID 属于另一 incarnation。
经协调者授权，Linux owner 增加 boot ID 与进程启动时间；同 hostname 的 boot/namespace
变化或同 namespace 下启动时间变化提供退出证明，其他 hostname、活进程和读取失败继续拒绝。
旧记录缺启动时间时不能凭活 PID 放行。advisory lock、exclusive guard 与 incarnation token
保留；未清空 owner 文件、未随机更换 executor ID。

Node 入口默认 ID 从 hostname 派生；Compose 将 hostname/ID 固定，owner 目录挂持久卷。
验收配置声明两套互异且稳定的 hostname/ID，各自使用正式引擎与同一 owner 卷；依次停止
一个副本，由另一个消费真实注册验证邮件，再用原身份重启。down/up 后核对 PID 1 复用、
namespace 改变与历史 incarnation 记录保留。跨 hostname 自动接管仍不在契约内。
详细恢复和手动处置规则见 [Node job engine runbook](node-job-engine.md)。

## 可重复的空卷验收

从本 worktree 根目录运行：

```sh
node deploy/selfhost/test-acceptance.mjs
```

脚本使用仓库外 0700 临时目录与随机测试 secrets、自签 CA；没有真实 Provider/staging 凭据。
根据 Git 跟踪清单复制源码，在临时构建副本将 multiTenant、requireEmailVerification 开启、
Turnstile/OAuth 关闭，不改根模板。Node 生产镜像仍使用正式 Dockerfiles 和完整提交 SHA；
这个模板变体是本地验收镜像，不作为正式发布镜像。匿名 Docker 配置使用当前 daemon，避免
读取宿主 Docker Hub 凭据；保留 BuildKit 和 Dockerfile 专用 ignore 语义。

正式 Compose 与测试 override 组合，所有服务/网络/卷以 `selfhost-final` 开头；仅 Caddy
发布 80/443。PG17、Valkey、一次性 migrate、web、真实 B jobs 均使用正式入口。
测试增加非 root capture 服务，仅在 internal data 网络监听 8025，不配置 host ports。
jobs 只读挂载测试 preload，将原 Resend sender 的 POST 定向到 capture，并剥离 Authorization。
原队列、渲染、幂等键和 ack 链路全部保留；不从数据库取验证 token，不向外部发信。
捕获正文仅在内存，Playwright 通过 `docker compose exec` 读取并解析，不写日志/trace/video。
Dockerfile ignore 显式排除捕获夹具，连 migrate 的源码镜像也不携带它。

脚本检查迁移成功依赖、配置和实际 UID，等待真实下一 UTC 五分钟 heartbeat，验证 TLS CA、
完整 readiness 200，执行 Playwright；停止 jobs/cache 验证 503，再重启依赖进程恢复连接。
创建数据后执行 down/up 保留卷，验证 PG 用户与 Valkey AOF 键仍在。最后向主进程 stdout
写非敏感 JSON，跨越 20k 日志阈值，核对实际 3 个日志文件和 requestId、无 secret 值。
只读日志 helper 仅挂载本任务 web 日志目录。所有验收服务均非 root；此短命 helper 用于
读取 Docker 自身日志目录。无论成功或失败，finally 执行 down -v 并删除临时 secrets。
不操作其他容器，不清理其他镜像/缓存。

### 最终 Compose 证据（2026-10-13 本地 / 2026-10-12 UTC）

验收镜像 SHA 为 `0c11b8787b211323a309c377d50e4fdbafc90816`。
健康接口返回 200/no-store，db/cache/queue/scheduler 均 up，真实成功 heartbeat
为 `2026-10-12T19:10:00.957Z`；停止 jobs/cache 分别得到 503，恢复后回到 200。
业务迁移与 DBOS 迁移按序成功，migrate exit 0。仅代理发布 80/443，资源限制和
json-file 配置通过 compose config 检查；实际 UID 为 PG/Valkey 999、web/jobs/capture
1000、Caddy 10001。owner 卷为 UID 1000/0700，两个 owner 均 PID 1，记录有效
namespace、boot ID 与启动时间，且 hostname/ID 互异且稳定。

两个副本轮流停止时，另一个都通过真实 B queue 送达一封新注册验证邮件；停止的
副本以原 ID 重新启动成功。随后 down/up 保留卷，TLS verify-full 的 app 查询核对
用户数完全一致，Valkey AOF 标记保留，owner namespace 改变且历史 incarnation
记录数增加。向主进程 stdout 写入非敏感 JSON 后，实际保留三个日志文件（含 `.2`），
requestId 可查、随机 secret 值未出现。最终 `selfhost.acceptance.passed` 后
`selfhost.acceptance.cleaned`，本次服务、网络和卷全部删除，临时 secrets 已删除。

## 隔离测试矩阵

本机使用独立 `selfhost-final-tests` PG17/Valkey，只绑定宿主 loopback 测试端口；它不是生产
Compose 拓扑。三角色和权限脚本与项目相同，连接配置只在任务临时目录/进程环境中。
业务/Node HTTP 使用一个 worktree 测试库；B engine、workflow、scheduler 和 jobs wire 分库，
避免不同注册集、历史队列及已存在的心跳污染初始断言。先业务 SQL 迁移，再 DBOS 迁移。
执行结束对该隔离 Compose 同样 down -v。

| 命令/范围 | 本轮结果 |
| --- | --- |
| pnpm check | 通过，Biome 与业务写入边界/脚本检查 |
| pnpm check:deps | 通过，7 项边界用例 |
| pnpm check:singletons | 通过 |
| pnpm dedupe --check | 通过 |
| pnpm typecheck | 14/14 通过 |
| pnpm test | 169 文件/1250 项，26/26 任务通过；15 任务复用未改变代码的缓存 |
| pnpm build | 默认 CF web/jobs 2/2 通过，18 页预渲染 |
| pnpm --filter @product-res/web test:e2e:smoke | 1/1 通过，28.3 秒；注册、真实退出/登录、本地支付 provider |
| pnpm build:node | Node web/jobs 2/2 通过，18 页无生产凭据预渲染 |
| pnpm --filter @product-res/web test:node | 12 组/687 项通过 |
| pnpm --filter @product-res/jobs test:node | 11 文件/44 项通过 |
| pnpm --filter @product-res/web test:node:production | 1 文件/7 项通过，5.01 秒 |
| pnpm --filter @product-res/jobs test:node:integration | 2 文件/2 项通过，96.29 秒；真实 retry/DLQ、五分钟 heartbeat 与停机 |
| pnpm --filter @product-res/platform test:job-engine | 2 文件/13 项通过，1127.96 秒，含真实完整六次退避与崩溃恢复 |
| TEST_WORKFLOW_LONG=1 pnpm --filter @product-res/platform exec vitest run --config vitest.workflow.config.ts | 11/11 通过，3779.04 秒，包含真实 61 分钟 pipeline、重启与 60+ 分钟早到事件 |
| TEST_SCHEDULER_LONG=1 pnpm --filter @product-res/platform exec vitest run --config vitest.scheduler.config.ts | 10/10 通过，623.23 秒，含真实 601 秒心跳停摆 |
| 补修后 platform Node 单元与 ownership 定向集成 | Node 5 文件/38 项通过（含 ownership 10 项）；既有 engine 6 项通过，91.45 秒 |
| 补修后 workflow/scheduler 快速集成 | workflow 10 项通过，113.43 秒；scheduler 9 项通过，31.11 秒；长用例在独立完整运行中等待/执行 |
| Node生产 Compose Playwright：playwright.selfhost.config.ts | 1/1 通过，14.8 秒；完整验证邮件/退出/密码登录/团队与个人空间切换 |
| node deploy/selfhost/test-acceptance.mjs | 通过；空卷、双副本发信/重启、PG/Valkey/owner 持久化与实际三文件日志轮转，finally down -v 完成 |

Node 聚合包含 config 33、AI 113、platform 基础 16、DB/credits 86、Valkey 3、auth 3、
billing 296、entitlements 14、web AI 50、public 29、files 拒绝路径 10、admin 34。
公共 shared/ui/email/storage 单元与 platform task-health 等由根 test 覆盖。

长 Workflow 的早到事件在 `2026-10-12T18:08:18.524345Z` 创建，
于 `2026-10-12T19:09:25.848662Z` 消费，真实保留 **3667.324317 秒**。
完整 11 项无跳过；7 个 native sleep 原结果、wait deadline、18 个 callback 各一次
与 15 个幂等副作用断言均通过。补修后的快速重跑不重复等待长时钟用例，
其显式跳过只对应上述独立完整运行，不隐藏队列/事件相关用例。

跳过/独立范围逐项说明：

- credits 单独 Node 命令不重复执行：DB Node 配置已经复用同一批账本与并发用例。
- B workflow/scheduler 的默认长测试开关均显式开启，本轮不跳过其真实时钟验收。
- CF adapter、workerd 邮件与 R2 用例仍在根 CF 测试中执行；不把 CF harness 的业务用例
  冒称已经逐项移植到 Node。Node 的验证邮件/退出/空间行为由生产 Compose 补齐。
- auth CPU probe 只测 CF CPU，默认未启用，不属于 Node 业务验收。
- C 的 Node S3/文件和媒体成功链路未交付，独立验收；本轮只验证缺能力时 503 且无预扣。
- 本轮首次 B engine/workflow 缺业务迁移导致 setup 失败；补齐隔离库正式业务迁移后重跑。
  jobs wire 首次复用了生产烟测库，已有 heartbeat 导致初始 503 断言失败；新建独立库重跑。
  CF smoke 首次未显式覆盖 cached Hyperdrive，数据库匹配保护拒绝启动；覆盖两绑定后通过。
  Compose 首轮误选未验证登录重发的回跳 `/app` 邮件；改为先读取注册邮件再做登录拒绝检查。
  会话状态查询显式 `disableCookieCache=true`，与敏感鉴权守卫一致：旧签名 cookie 的缓存展示
  不代表有效业务会话，仍保留旧 cookie 重放时页面拒绝与实时会话为空的断言。
  持久化探测首次误用 web 的传递依赖，随后本地 app socket 被生产 PG 策略正确拒绝；
  最终改为测试 CA 的 verify-full app TLS 查询，没有放宽 pg_hba 或生产权限。
  B 补修后 workflow 快速重跑首次受并发构建负载影响，原唤醒截止断言迟 326ms；
  定向重跑与完整快速组随后均通过，保留原断言和时限。长时钟组在补修前启动，
  容器身份变更另由补修后的 Node ownership、engine/短 workflow/scheduler 与真实 Compose 验证。
  以上修正环境/测试入口，没有弱化业务断言或时限，没有改 CF 的会话缓存语义。

## CI 与 staging 边界

`.github/workflows/ci.yml` 与 `deploy-staging.yml` 无修改。CF e2e-smoke 仍独立运行，
Node job 没有 staging secrets/部署步骤。staging 保持 main CI push 成功后触发，按完整 SHA
checkout，迁移 → jobs/web 发布 → health SHA 检查 → staging Playwright。

本轮开始时 main `30731bfdfef267a0841bd534e2349d1a7a61d197` 的
[CI 38288222594](https://github.com/ustclhx/product-res/actions/runs/38288222594) 和
[自动 staging 38288882367](https://github.com/ustclhx/product-res/actions/runs/38288882367)
均通过；只读请求 staging `/api/health` 返回 200，version 同为完整 `30731bfdfef267a0841bd534e2349d1a7a61d197`，lastCronAt 非空。这是本分支基线的证据，不能替代本 PR 合入后的 run/health。
本分支不手工部署 staging、不自行合并；8.3 要求本 PR 合入后的 main 自动 staging 与完整 SHA，
取得该证据前保持未勾选，由协调者合入后补验。

交付前 rebase 到 `62ac48d66cca59d022fae322d6193c3f0f57c470`（#132/#133）。
新增内容是 Cloudflare staging reduced Cron 与 staging CDP 登录支持；Node 仍使用
默认五条 UTC 调度。补跑 jobs Node 11 文件/54 项与三套 jobs tsc 均通过，最终 PR CI
再验集成后的根检查、CF smoke 和 Node 构建/测试。上述 Compose 镜像与长时钟证据
记录的是 rebase 前完整 SHA；auth/ownership 实现和 Compose 文件在 rebase 中没有改变。

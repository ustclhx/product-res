# A 4.4：存储、growth 与公开页迁移

本批只完成 `add-selfhost-foundation` 4.4。Cloudflare 为默认目标；不实现 C 的 S3 后端，不修改 B 的引擎或组 6 的 AI 出口。

## 接口与接线

业务从 `@product-res/storage` 使用 `Storage` 和 `MediaOutputCopier`。R2 签名、multipart 与 FixedLengthStream 仅在 `@product-res/storage/cloudflare`，接口细节见 [storage README](../../packages/storage/README.md)。web/jobs 的 Cloudflare composition 显式装配两个工厂，数据库配额、确认、分享撤销、媒体幂等与清理仍由原业务函数处理。

`WebRuntime.files` 为可选 `Capability<Storage>`：Node 在 C 未交付时使用 `{ available: false }`，省略字段也明确拒绝。HTTP 文件入口与文件 Server Function middleware 在读取认证、数据库或写文件之前检查能力。两个媒体提交 POST 通过 `getFileMediaHttpDeps()` 先检查文件能力，再获取原 AI 依赖；即使 B 已提供 Workflow，也不会产生任务行或 credit hold。媒体 GET、取消和文本聊天保留原路径。C 接入时装配真实 `Storage`、`MediaOutputCopier` 与既有 AI 下载能力，不提供成功占位实现。

`WebRuntime.publicDb` 是借用的 Database facade；Cloudflare 使用 cached Hyperdrive，Node 后续使用 app pool。定价读取不关闭借用池；构建快照脚本关闭自己创建的连接。公开语言路径只使用 URL/Cookie，不提前取 db/auth；数据库不可达时展示定价快照，支付配置错误时关闭购买。

growth 使用 runtime 标量、可信 clientIp、auth policy 限流及中立邮件队列。Newsletter 在新增/重置订阅前检查队列，后台邀请在事务前检查队列；waitlist 报名独立于发信能力。Turnstile 关闭后 IP/邮箱限流继续执行。

## 验证与剩余范围

- `pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm dedupe --check`。
- `pnpm typecheck`、`pnpm test`、`pnpm build`：包含现有 CF 存储、growth、公开定价与 jobs 媒体 runner，默认 web 构建实际预渲染公开页。
- `pnpm --filter @product-res/web exec vitest run --config vitest.files.node.config.ts`：Node 文件 HTTP 拒绝与隔离 PG 上媒体提交拒绝，核对任务/hold 数量未变，Workflow 未调用。
- `pnpm --filter @product-res/web exec vitest run --config vitest.public.node.config.ts`：真实 Node 子进程加载公开/i18n/SEO 模块，以不可用 db/auth/publicDb 渲染英文、中文公开组件与快照；不加载 Cloudflare 模块。
- storage 中立/Node 类型检查不注入 Workers 声明，并在真实 Node 子进程导入 package export；CF 签名、字节限额、MIME、并发配额与失败清理沿用原用例。

Node 测试文件使用 `.node.ts`，与默认 CF integration 的 `.test.ts` 收集规则隔离。媒体 Node 用例要求 worktree/CI 的隔离 PG，不连接 staging。

经协调者确认，本批验收中立公开页无 DB 降级与 CF 实际预渲染；Node **生产输出**无 DB 预渲染由组 5 验收。C 的真实 S3/Node 文件和媒体验收、合并后 main 自动 staging 发布与验证仍由后续 owner/协调者完成，本批不手工部署。

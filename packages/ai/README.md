# AI 平台迁移（A 4.3）

`packages/ai` 的模型注册、预算、检查点、结算及媒体 Provider/runner 契约已经使用业务类型，
不需要 Workers 全局声明。模型列表的 `ModelCache` 只要求 KV 的文本读取、写入与删除，
可直接接入平台 `KeyValueStore`。第 6 组已新增 `src/text/model.ts` 的 OpenAI 兼容直连出口，
保留 Gateway/BYOK，并按目标能力过滤 Workers AI。

Web AI、媒体回调及公开 API 从请求 `WebRuntime` 读取数据库、认证、缓存和限流。
`WebRuntime.ai` 由目标入口显式装配 AI 标量配置、后台延续、媒体 Workflow、Workers AI
及文件签名能力。未装配 AI 时返回 503；媒体 Workflow unavailable 在任务创建或预扣前拒绝。
公开媒体文件签名通过能力注入，业务路由不再持有 R2 环境。Cloudflare 入口继续使用原绑定，
`waitUntil` 保留 receiver，Workflow 状态通过平台适配器归一化。

限流使用 `ai`/`api` policy，保留原来的 workspace/user、API key/workspace 键。
同一聊天业务测试套件由 CF 和 Node 入口复用，验证真实 Postgres 上的预算、预扣、结算、
用量检查点、停止、重复结算和客户端响应流断开后的后台消费。Node 使用平台后台任务
集合与有界 drain；测试模型为 AI SDK 模拟模型。

验证命令（仓库根目录）：

```sh
pnpm --filter @product-res/ai test
pnpm --filter @product-res/web exec vitest run test/ai-chat.test.ts test/ai-media-tasks.test.ts test/public-api.test.ts test/public-media.test.ts
pnpm --filter @product-res/web exec vitest run --config vitest.ai-node.config.ts
```

Node 配置必须使用同一个隔离 worktree/CI 数据库的 app/migrator 连接；缺失或数据库不匹配
立即失败，不静默跳过。默认 CF 测试不会收集 `.node.ts` 入口。

第 6 组通过真实出口工厂与 OpenAI SDK 解析 fixture SSE，在 Node 上复用全部聊天业务断言，
分别验证 direct 与 Gateway 的正常 usage、按次、超额、停止/错误估算封顶、检查点和幂等。
SDK 把部分缺失计数变成 0 的行为在工厂边界还原为 unknown；真实 0 保留，原结算断言不放宽。
所有请求使用 fixture，未发起真实外部 AI 调用。

模型注册表接收 `workersAi` 可用性，缓存保留完整模型数据，读取后按目标过滤。Node 没有 binding，
请求/后台默认不可用，隐藏模型选择与 provider 选项；直接聊天和媒体提交在预扣/任务创建前拒绝。
Cloudflare 装配 binding 时保留 Workers AI 同步媒体路径。组 5 Node composition 须注入
`workersAi: { available: false }`、Node schema 的 `AI_TEXT_EGRESS` / `OPENAI_BASE_URL` / `OPENAI_API_KEY`
和平台后台任务集合，不复制 CF binding 或 Gateway 缺省配置。

Node response reader.cancel 的完整结算已由业务 fixture 验证；Node **生产 HTTP** 断开 smoke
仍待组 5 生产输出后补，6.3 保持待办。B/C 的持久媒体执行和对象存储未验收。

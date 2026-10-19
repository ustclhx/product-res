# Proposal

## Why

部署在 Cloudflare 代理（橙云）或 Cloudflare Tunnel 之后时，边缘在源站开始响应前或两段数据之间约 100 秒无字节即返回 524（Free/Pro/Business 不可调）。推理模型在 reasoning 不展示时，站内对话流与 OpenAI 兼容流都可能长时间不写出任何字节，深度推理超过 100 秒时连接被切断，而服务端仍在生成并结算（issue #249）。

## What Changes

- 站内对话流在静默满间隔（默认 25 秒，可注入）时发送 transient 数据片段 `data-keepalive`，`useChat` 不将其写入消息 parts；真实输出重置计时，结束、失败与取消时清理定时器。
- OpenAI 兼容流式接口在同一间隔写 SSE 注释行 `: keepalive`，客户端按 SSE 规范忽略。
- 两条流在等待首个上游 token 前写出首片段，使响应头尽早发出。
- 文档注明 Cloudflare 约 100 秒边缘读超时与心跳行为。
- 不改变预扣、检查点与结算语义。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `ai-chat`：新增流式空闲心跳要求。
- `public-api`：新增 OpenAI 兼容流的 SSE 注释心跳要求。

## Impact

- `apps/web/src/features/ai/text-stream.ts`、`apps/web/src/features/api-keys/completions.ts` 及其单元测试。
- `docs/06-ai.md`、`docs/runbooks/selfhost-proxy.md`。
- 无数据库、配置或依赖变化。

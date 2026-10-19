# Design

## Context

`createChatStream` 产出内部片段流 `fullStream`，站内经 `toUIMessageStreamResponse` 序列化为 AI SDK UI message 流，公开 API 由 `completions.ts` 转为 OpenAI SSE。`displayReasoning` 关闭时 reasoning 只累计不发出；重试退避与结算等待期间同样没有输出。

## Decisions

**D1 心跳在片段生产端统一计时。** 在 `createChatStream` 的 `emit` 后重新计时，静默满 `heartbeatMs`（默认 `STREAM_HEARTBEAT_MS = 25_000`）发出内部 `keepalive` 片段，两条序列化路径各自转换。这样隐藏 reasoning、重试退避与结算等待都被覆盖，计时只有一处。备选「各序列化器自带 setInterval」需要两套定时器且无法感知生产端真实输出，否决。25 秒低于 Cloudflare 100 秒与 Nginx 默认 60 秒读超时，并留有余量。

**D2 站内使用 transient 数据片段。** 写 `{ type: 'data-keepalive', data: null, transient: true }`；AI SDK 对 transient 数据片段只回调 `onData`，不写入消息 parts，不影响 `messageRetrying`、reasoning 展示与持久化。

**D3 公开 API 使用 SSE 注释。** `: keepalive\n\n` 是 SSE 规范要求客户端忽略的注释行，官方 SDK 与 `eventsource-parser` 均跳过；不发送空 `data` 分片，避免破坏只按 JSON 解析 data 的客户端。

**D4 定时器生命周期。** 流关闭前（含失败时发出 error 片段之后）、消费方取消时，以及 `done` 以任何方式结束时清理定时器，测试以 fake timers 断言无残留。

**D5 响应头尽早发出。** UI 流的 `start` 与 OpenAI 流的 role 首片段已在等待上游前写出；把 SSE 生成提取为 `completionEventStream` 以便单元测试锁定这一行为。

## Risks / Trade-offs

- 消费方不读取时心跳片段会在内部队列累积，每 25 秒一个，量级可忽略。
- 心跳不延长 Workers `waitUntil` 断开后 30 秒的结算时限，结算语义不变。

## ADDED Requirements

### Requirement: 流式对话接口空闲心跳
OpenAI 兼容对话接口的流式响应 SHALL 在等待首个上游 token 前写出首个分片；上游静默达到心跳间隔（默认 25 秒）时 MUST 写出 SSE 注释行 `: keepalive`，不得写出额外的 data 分片。兼容客户端的解析结果 MUST 与无心跳时一致。

#### Scenario: 推理阶段长时间无正文
- **WHEN** 开发者发起流式请求，模型思考超过一个心跳间隔才输出正文
- **THEN** 期间收到 SSE 注释心跳，官方 SDK 得到的正文、结束原因与 usage 不变

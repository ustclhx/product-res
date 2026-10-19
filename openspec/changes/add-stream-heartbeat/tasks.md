# Tasks

## 1. 实现

- [x] 1.1 `createChatStream` 静默满间隔发出 keepalive 片段，真实输出重置计时，结束/失败/取消清理定时器；UI 流序列化为 transient `data-keepalive`。
- [x] 1.2 OpenAI 兼容流把 keepalive 写成 SSE 注释 `: keepalive`，提取 `completionEventStream`。

## 2. 验证与文档

- [x] 2.1 fake timers 单元测试：隐藏 reasoning 超过间隔产生心跳、真实输出重置、结束/取消/失败后无残留定时器、首片段先于上游 token、官方 OpenAI SDK 解析含注释的流。
- [x] 2.2 文档注明 Cloudflare 约 100 秒边缘读超时与心跳行为（`docs/06-ai.md`、`docs/runbooks/selfhost-proxy.md`）。

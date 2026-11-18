# public-api Specification

## Purpose

允许空间通过 API Key 以编程方式使用站点的 AI 能力，计费、权益与限流规则与站内使用完全一致。

## Requirements

### Requirement: 功能开关
公开 API 只在 `features.publicApi=true` 时可用；关闭时所有 `/api/v1` 路径 MUST 返回 404，API Key 管理界面 MUST 隐藏。

#### Scenario: 开关关闭
- **WHEN** `features.publicApi=false`，客户端调用 `/api/v1/chat/completions`
- **THEN** 返回 404

### Requirement: API Key 管理
空间 owner 与 admin SHALL 能创建、命名、设置过期时间与撤销 API Key；Key 的完整值 MUST 只在创建时显示一次，之后只显示前缀；每个 Key 绑定一个空间，且要求套餐权益允许使用公开 API。

#### Scenario: 创建后再次查看
- **WHEN** owner 创建 Key 后刷新页面
- **THEN** 只能看到 Key 的前缀与名称，无法再次查看完整值

#### Scenario: 撤销后调用
- **WHEN** 使用已撤销的 Key 调用接口
- **THEN** 返回 401

### Requirement: OpenAI 兼容对话接口
系统 SHALL 提供与 OpenAI Chat Completions 兼容的子集接口（含流式），模型名使用站点模型注册表中的 key；计费、余额与欠费检查、超额规则 MUST 与站内对话一致。

#### Scenario: 用官方 SDK 调用
- **WHEN** 开发者用 OpenAI 官方 SDK 把 baseURL 指向本站并发起流式请求
- **THEN** 收到兼容格式的流式响应，空间积分按该模型的计费方式扣除

#### Scenario: 余额不足
- **WHEN** 空间余额不足时调用对话接口
- **THEN** 返回 402 与可识别的错误码

### Requirement: 媒体任务接口
系统 SHALL 提供创建媒体任务与查询任务状态的接口，行为与站内提交一致（参数校验、并发上限、计费、结果持久化），任务结果以短期有效的下载地址返回。

#### Scenario: 通过 API 生成图片
- **WHEN** 客户端创建图片任务并轮询状态直到成功
- **THEN** 响应中包含结果文件的短期下载地址

### Requirement: 按 Key 限流
公开 API SHALL 按 API Key 与空间限流，超出时返回 429 并包含重试等待时间。

#### Scenario: 超出频率
- **WHEN** 某 Key 在短时间内请求超过限额
- **THEN** 返回 429 与 `Retry-After`

### Requirement: 流式对话接口空闲心跳
OpenAI 兼容对话接口的流式响应 SHALL 在等待首个上游 token 前写出首个分片；上游静默达到心跳间隔（默认 25 秒）时 MUST 写出 SSE 注释行 `: keepalive`，不得写出额外的 data 分片。兼容客户端的解析结果 MUST 与无心跳时一致。

#### Scenario: 推理阶段长时间无正文
- **WHEN** 开发者发起流式请求，模型思考超过一个心跳间隔才输出正文
- **THEN** 期间收到 SSE 注释心跳，官方 SDK 得到的正文、结束原因与 usage 不变

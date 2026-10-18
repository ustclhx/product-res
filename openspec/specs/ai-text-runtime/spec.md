# ai-text-runtime Specification

## Purpose
定义文本模型在 Cloudflare Gateway 与自托管直连环境中的出口配置和计费兼容性，使模型端点变化不改变预算、用量与账本，并明确不支持的 Workers AI 能力如何对用户呈现。

## Requirements

### Requirement: 可选 Gateway 与兼容端点
文本 AI SHALL 支持管理员配置 OpenAI 兼容 base URL 与 API key，Gateway SHALL 为可选出口。直连无需 Gateway 凭据且不发送其鉴权头；Cloudflare 默认保留现有 Gateway/BYOK 行为。端点 MUST 不由普通请求任意指定。（A2）

#### Scenario: 自托管直连
- **WHEN** 配置合法兼容 base URL/key 且没有 Gateway 配置
- **THEN** 使用注册表的模型 ID 调用该端点，不因缺 Gateway account/id/token 而拒绝

#### Scenario: 原 Gateway 用户
- **WHEN** Cloudflare 继续使用 Gateway BYOK
- **THEN** 保留原鉴权与 Provider key 处理，不把占位 key 发送给 Provider

### Requirement: 相同预算与结算
两目标 SHALL 共用模型定价快照、用量记录、预算、预扣与结算逻辑，保持正常输出、per_call、真实用量超额、停止/出错估算封顶、检查点与幂等账本规则；客户端断开 MUST 不跳过已注册的后台结算。（A3）

#### Scenario: 相同输入与用量
- **WHEN** 两目标接收相同定价快照、输入及最终模型用量
- **THEN** 预算、账本金额和消息终态一致，重复结算不重复扣费

#### Scenario: 停止或错误
- **WHEN** 生成停止或失败且仅有估算用量
- **THEN** 保持现有预扣封顶与检查点兜底规则，不因直连改变收费

### Requirement: Workers AI 能力不可用
Node SHALL 默认关闭 Workers AI binding 能力，隐藏用户模型入口与后台不可选项；直接调用 MUST 在任务创建或积分预扣前拒绝。Cloudflare 的 Workers AI 能力 SHALL 保持。（A4）

#### Scenario: 请求不可用模型
- **WHEN** Node 用户直接提交 workers-ai 模型
- **THEN** 返回明确不可用错误，无预扣或任务副作用

## Why
补证后 AI 草稿仍可能显示可采用；失败调用的 token 消耗没有完整落库，试点难以判断真实成本。落实已确认 P0 的 D4、D5。

## What Changes
- 读取时计算草稿时效和原因，采用时继续服务端校验；优先显示最新可用草稿，保留历史及人工输入。
- 按调用尝试记录成功、截断、校验失败与未知结果的已知用量和诊断信息；支持工作区内汇总、CSV 导出。
- 保持现有预算、人工复核及未知结果不自动重试的边界。

## Capabilities
### New Capabilities
- `assistant-draft-freshness`: 草稿时效展示、最新可用稿选择及采用保护。
- `model-attempt-accounting`: 逐尝试模型用量、诊断、汇总和导出。
### Modified Capabilities
无。

## Impact
NewAPI provider、持久任务、候选聚合与评估采用 API、前端草稿与用量展示；增量 JSON 字段，无破坏性数据库迁移。部署独立 ECS 试点，不改变共享 NewAPI 配置。

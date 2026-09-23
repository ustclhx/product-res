# model-attempt-accounting Specification

## Purpose
保留模型每次尝试的实际已知用量和结果诊断，包括输出被业务校验拒绝时的消费，帮助试点测量成本、定位失败并区分未记录、未知与真实零值，支持工作区隔离的汇总和导出。

## Requirements
### Requirement: Attempt receipts include unsuccessful generation
系统 SHALL 按尝试保存节点、模型、输入规模、已知 token、耗时、请求上限、结束原因、请求标识和已知费用；截断或结构/引用校验失败 MUST 保留收到的 usage，不因输出无效而丢弃。

#### Scenario: Truncated response includes usage
- **WHEN** 返回 length 结束原因且带 usage
- **THEN** 草稿不被采用，但该失败尝试的 token 和诊断可以查询

#### Scenario: Unknown response or historical attempt
- **WHEN** 未收到 usage 或历史尝试没有记录
- **THEN** 显示未知或未记录，不按零计费；未知结果不自动重试，新尝试单独记账

### Requirement: Isolated summaries and safe export
系统 SHALL 提供当前工作区按项目/候选查看、汇总及 CSV 导出，明确已知与未知覆盖，不重复累计 node_run 和 attempt，不混加不同币种，不输出秘密或原始模型正文。

#### Scenario: Export with filter
- **WHEN** 已登录成员导出某候选用量
- **THEN** 只返回其工作区该候选的逐尝试记录，CSV 文本安全转义且未知字段不伪造为零

## Purpose

通过同机 NewAPI 为真实试点提供有界的补证、评估与复盘整理，在输入证据、调用版本、失败状态和人工采用之间保持清晰边界，使模型输出可审阅而不会替代业务负责人决定。

## ADDED Requirements

### Requirement: Configured NewAPI access
系统 SHALL 从服务端配置选择 NewAPI 地址、凭据及模型，检查模型可用性并记录真实调用元数据；不能以状态接口成功代替推理验收，不能改变共享网关的全局渠道或额度。

#### Scenario: Model list succeeds but generation fails
- **WHEN** 模型列表正常而生成请求超时或被拒绝
- **THEN** 系统报告节点未完成并保留分类错误，不宣称 AI 已接通或生成有效评估

### Requirement: Evidence grounded node outputs
真实节点 SHALL 接收冻结的标准、证据与明确任务，复盘节点还必须绑定批准快照、指定结果版本和确定性比较。输出仅为待人工检查的结构化草稿；每条事实引用必须属于该次输入，未知与建议独立，模型不得执行批准或外部业务动作。

#### Scenario: Source text contains instructions
- **WHEN** 商品描述或材料正文要求模型忽略规则或批准商品
- **THEN** 系统将其视为不可信数据，不授予执行权；不合格结构或引用被拒绝，候选状态不推进

#### Scenario: Review references actual outcome
- **WHEN** 用户运行真实偏差复盘
- **THEN** 输出可追溯到所选结果和原批准版本，不能用后来修改的假设替代原批准依据

### Requirement: Traceable attempts and adoption
系统 SHALL 保存模型/提示词/schema/输入版本、request ID、耗时、用量及已知费用，并明确合法输出尚未人工采用。格式或引用不合格不得成为正式评估；超时或远端状态未知不得静默重新发起可能计费请求。

#### Scenario: Valid response with foreign citation
- **WHEN** JSON 格式正确但包含其他候选引用
- **THEN** 系统拒绝采用并保留脱敏失败记录，可由人检查后明确发起新尝试

#### Scenario: Human saves an accepted draft
- **WHEN** 分析人员核验有效草稿并修订保存
- **THEN** 系统生成新人工评估版本，保留模型来源与人工修改，仍需负责人批准

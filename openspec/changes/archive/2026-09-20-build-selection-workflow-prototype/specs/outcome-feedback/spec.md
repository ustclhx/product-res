## Purpose

让实际或示例经营结果能够追溯至原候选和当时批准的假设，使用一致口径解释偏差，并把改进建议经人工确认用于下一轮。该结构演示数据闭环，但不把示例或缺失结果作为真实收益证据。

## ADDED Requirements

### Requirement: Linked outcome intake
系统 SHALL 支持手工/CSV 预览回填，关联项目、候选、批准评估和可选 SKU/Listing/测试标识；保留来源、样例标记、观察窗口、币种及录入者。未匹配、多义匹配和重复结果 SHALL 明示，确认前不写入。

#### Scenario: Unknown SKU mapping
- **WHEN** 结果表中的 SKU 找不到唯一候选
- **THEN** 系统要求用户映射或跳过该行，不按商品名称猜测关联

### Requirement: Comparable forecast and actual review
系统 SHALL 对照批准快照中的预期与实际销售、采购/平台/履约/广告成本、退款等字段；仅在窗口、币种、数量及口径可比时计算差异。缺值 SHALL 保持未知；收入和退款 SHALL 有明确避免重复扣除的口径。

#### Scenario: Missing advertising cost
- **WHEN** 实际广告费用缺失
- **THEN** 系统展示其他可比指标并标注贡献利润不可完整计算，不将费用当零、不称净利润

#### Scenario: Incompatible periods or currency
- **WHEN** 预测与实际窗口或币种不同且未明确换算口径
- **THEN** 系统显示不可直接比较，要求补充口径，不自动给出偏差结论

### Requirement: Human-approved learning record
系统 SHALL 允许记录偏差原因和可解释的标准调整建议；只有决策负责人确认才能创建下一轮标准版本。建议 SHALL 保留结果依据、调整前后值、适用范围及确认/拒绝原因，不追溯修改旧项目决定。

#### Scenario: Accept MOQ adjustment suggestion
- **WHEN** 负责人基于结果确认一个下一轮 MOQ 规则调整
- **THEN** 系统保存建议及确认记录，形成可供新项目选择的新标准版本，旧候选的规则和决策不变

#### Scenario: Reject AI feedback suggestion
- **WHEN** 负责人拒绝模拟 AI 规则建议并说明原因
- **THEN** 系统保留拒绝反馈且现行标准不变，不自动调参或训练模型

### Requirement: Outcome coverage without fabricated success
系统 SHALL 显示获批候选中待回填、已回填、明确未上市的数量；观察和否决候选及原因仍可查询，但不虚构其经营结果。

#### Scenario: Approved candidate has no sales yet
- **WHEN** 用户尚未提供结果或观察窗口未结束
- **THEN** 系统显示待结果及原因，不能显示闭环已验证或作为成功样本

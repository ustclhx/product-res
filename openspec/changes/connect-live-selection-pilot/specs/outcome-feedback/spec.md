## MODIFIED Requirements

### Requirement: Linked outcome intake
系统 SHALL 支持手工/CSV 预览回填，关联项目、候选、批准评估和可选 SKU/Listing/测试标识；保留来源、样例标记、观察窗口、币种及录入者。未匹配、多义匹配和重复结果 SHALL 明示，确认前不写入。试点回流 SHALL 按工作区与批准轮次确认 SKU/Listing/测试映射，区分 REAL、TEST、DEMO；测试订单不能计入真实经营统计。

#### Scenario: Unknown SKU mapping
- **WHEN** 结果表中的 SKU 找不到唯一候选
- **THEN** 系统要求用户映射或跳过该行，不按商品名称猜测关联

#### Scenario: Test orders used for integration
- **WHEN** 团队导入测试订单验证结果映射
- **THEN** 记录带 TEST 标记并可演练复盘，真实经营覆盖与收益统计不包含它们

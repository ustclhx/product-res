## MODIFIED Requirements

### Requirement: Traceable evidence and data quality
系统 SHALL 为证据保留候选、字段/主张、值和单位、币种/窗口、来源定位、观察与录入时间、事实/估算/假设分类、核验状态、版本和独立样例标记；缺失、过期和冲突 SHALL 明示。外部证据还 SHALL 保留来源批次与映射版本，获取成功不自动变为已核验事实；核验或替代均追加版本。

#### Scenario: Replace outdated supplier quote
- **WHEN** 用户录入新报价替换过期报价
- **THEN** 系统生成新证据版本，旧评估仍可查看原报价，当前初筛提示需要重算

#### Scenario: Normalize market observation
- **WHEN** 真实市场接口返回商品价格或页面购买量标签
- **THEN** 系统按来源语义保存观测和未核验状态，不把页面标签认定为真实成交订单

#### Scenario: Research criteria without commercial thresholds
- **WHEN** 负责人确认只有必需证据、尚无商业淘汰规则的研究标准
- **THEN** 系统允许空规则列表但要求至少一项必需证据，缺失或未核验证据仍要求补证，不自动填入演示阈值或批准候选

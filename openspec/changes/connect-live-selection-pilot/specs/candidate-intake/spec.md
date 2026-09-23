## MODIFIED Requirements

### Requirement: Two candidate entry paths
系统 SHALL 支持在演示模式调用示例发现服务、在试点模式调用已配置真实来源，以及手工或 CSV 导入已有候选。两种入口 SHALL 创建同类候选对象并保存项目、渠道、市场、来源、外部标识或链接、进入时间及样例标记。真实发现 SHALL 绑定来源批次，查询完成不自动纳入。

#### Scenario: Discover by category
- **WHEN** 用户在演示模式为已确认项目输入方向并请求发现
- **THEN** 系统展示与该示例方向匹配的候选，明确说明模拟数据；用户选择后才纳入候选池

#### Scenario: No sample coverage
- **WHEN** 方向不在示例数据支持范围
- **THEN** 系统显示无可用样例并提供手工导入入口，不编造当前市场商品

#### Scenario: Select from a real discovery batch
- **WHEN** 试点用户选择当前项目真实发现批次的条目
- **THEN** 系统保存来源与真实标记并纳入同类候选，后续补证、人审和结果回填要求不变

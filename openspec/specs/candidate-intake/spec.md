# candidate-intake Specification

## Purpose

把从方向发现的机会和团队已有的商品清单纳入同一选品项目，保存原始来源和进入方式，并通过预览校验与明确去重保证后续证据、任务和结果能够关联到稳定商品身份。

## Requirements

### Requirement: Two candidate entry paths
系统 SHALL 支持按方向调用示例发现服务，以及手工或 CSV 导入已有候选。两种入口 SHALL 创建同类候选对象并保存项目、渠道、市场、来源、外部标识或链接、进入时间及样例标记。

#### Scenario: Discover by category
- **WHEN** 用户为已确认项目输入方向并请求发现
- **THEN** 系统展示与该示例方向匹配的候选，明确说明模拟数据；用户选择后才纳入候选池

#### Scenario: No sample coverage
- **WHEN** 方向不在示例数据支持范围
- **THEN** 系统显示无可用样例并提供手工导入入口，不编造当前市场商品

### Requirement: Import preview and validation
系统 SHALL 在 CSV 提交前预览字段映射、无效行和重复项；有效行仅在用户确认后写入。无效值、过大文件和不支持的格式 SHALL 给出可修正提示，不静默丢弃。

#### Scenario: Mixed valid and invalid rows
- **WHEN** CSV 包含有效候选与缺少商品名称的行
- **THEN** 系统显示行号和错误，用户可以修正或明确选择仅提交有效行，写入数量与预览一致

### Requirement: Scoped duplicate detection
系统 SHALL 按项目、渠道、市场和外部商品标识优先识别确定性重复，保留多个来源记录；相似名称只提示，不自动合并。不同项目的候选 SHALL 不被自动合并。

#### Scenario: Reimport existing candidate
- **WHEN** 同一项目重复导入相同外部商品标识
- **THEN** 系统复用候选身份，保留新增来源，不重复创建候选、证据权重或下游任务

#### Scenario: Similar title across markets
- **WHEN** 两行名称相似但市场或外部标识不同
- **THEN** 系统保留独立候选并允许人工查看，不以名称推定为同一商品

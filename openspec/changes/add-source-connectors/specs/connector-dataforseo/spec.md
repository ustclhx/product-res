# Spec Delta

## Purpose

定义 DataForSEO 连接器提供的季节与关键词数据，以及 Amazon 补充数据的核验。

## ADDED Requirements

### Requirement: 季节曲线
系统 SHALL 每周为启用方向的关联关键词获取 Google Trends 5 年周度曲线和关键词月搜索量历史，按“关键词 × 周/月 × 来源”保存。

#### Scenario: 新增关键词
- **WHEN** 方向新增一个关联关键词
- **THEN** 下一次每周同步获取该关键词的 5 年曲线，之前的周不补零

### Requirement: 按金额预算
DataForSEO 的预算单位 SHALL 为美元/月，调用前按任务单价预扣；达到安全线后 MUST 停止定时任务。

#### Scenario: 达到月度安全线
- **WHEN** 当月已用金额达到安全线
- **THEN** 当月剩余的定时任务不再发出，数据中心显示原因

### Requirement: Amazon 补充数据核验
系统 SHALL 核验 DataForSEO 的 Amazon 商品、卖家和评论结果所含字段与单价，核验通过的数据类型才可启用为补充来源。

#### Scenario: 评论不可用
- **WHEN** 核验发现评论结果不含正文
- **THEN** 回执记录“评论正文未返回”，该数据源不声明评论能力

# Spec Delta

## Purpose

定义 Jungle Scout API 连接器提供的销量估算、产品数据库和关键词数据。

## ADDED Requirements

### Requirement: 销量估算
系统 SHALL 为跟踪的 Amazon 商品获取 Jungle Scout 的销量估算，按日保存，获取方式标记为“第三方估算”。

#### Scenario: 与其他来源并列
- **WHEN** 同一 ASIN 同日已有卖家精灵的估算
- **THEN** 两个估算作为不同来源的观测并存，互不覆盖

### Requirement: 产品数据库与关键词
系统 SHALL 支持按方向的类目和条件查询产品数据库用于方向扩展，并获取关键词的站内搜索量与历史。

#### Scenario: 方向扩展
- **WHEN** 方向配置了 Amazon US 类目和价格区间
- **THEN** 查询结果中的新 ASIN 被加入跟踪候选

### Requirement: 合同额度
Jungle Scout 的预算 SHALL 按合同的月度请求数配置，默认日均分配并滚动结余；达到安全线后 MUST 停止定时任务。

#### Scenario: 月底额度用尽
- **WHEN** 当月已达安全线
- **THEN** 定时任务停止，人工刷新仍可使用到硬上限

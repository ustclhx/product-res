# Spec Delta

## Purpose

在跟卖选品页面展示候选线索与商品簇详情。

## ADDED Requirements

### Requirement: 候选列表
跟卖候选列表 SHALL 支持平台切换（Amazon / eBay）与方向筛选，按综合分 × 置信度排序；列包括商品簇、等级、综合分、置信度、命中信号、风险标签、最晚决定日与数据来源。eBay 线索 MUST NOT 显示 BSR 列。没有数据时显示空状态，MUST NOT 显示示例数据。

#### Scenario: 切换到 eBay
- **WHEN** 用户切换到 eBay
- **THEN** 列表只显示 eBay 线索，表头没有 BSR

### Requirement: 商品簇详情
详情页 SHALL 展示 7 维雷达、置信度明细、价格与销量曲线、季节曲线叠加、风险明细、来源对比和簇成员；每个数值可以查看来源、获取方式与时间。用户 SHALL 能在详情页拆分成员、合并簇，并能对单个商品发起遵守额度的人工刷新。

#### Scenario: 查看来源
- **WHEN** 用户把鼠标移到月销量估算上
- **THEN** 显示各来源的值、主值来源、离散度和获取时间

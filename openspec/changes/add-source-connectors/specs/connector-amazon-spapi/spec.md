# Spec Delta

## Purpose

定义 Amazon SP-API 连接器提供的目录、竞争价格和 FBA 费用预估。

## ADDED Requirements

### Requirement: 目录与竞争价格
系统 SHALL 通过 SP-API 获取商品的标题、品牌、类目、尺寸重量、图片，以及最低价、Buy Box 价和卖家数，并遵守各接口的官方限流；遇到限流响应 SHALL 退避重试。

#### Scenario: 限流
- **WHEN** 接口返回限流错误
- **THEN** 任务按退避策略重试，不计为失败，不影响其他数据源

### Requirement: FBA 费用预估
系统 SHALL 按“商品 × 价格 × 配送方式（FBA / FBM）”获取费用预估并保存费用明细与时间。预估失败时，核算 SHALL 回退到费率表，并 MUST 标记该费用为“非官方预估”。

#### Scenario: 预估成功
- **WHEN** 对某 ASIN 在 19.99 美元、FBA 下请求费用预估
- **THEN** 保存佣金与配送费明细，来源为 SP-API，获取方式为官方

#### Scenario: 预估失败
- **WHEN** 费用预估接口对该 ASIN 返回错误
- **THEN** 核算使用费率表计算并显示“非官方预估”标记

### Requirement: 品牌分析仅核验
本期 SHALL 只核验品牌分析报表是否可用并记录回执，MUST NOT 定时同步该报表。

#### Scenario: 无品牌备案
- **WHEN** 卖家账号没有品牌备案
- **THEN** 回执记录“品牌分析不可用”，其他 SP-API 能力照常

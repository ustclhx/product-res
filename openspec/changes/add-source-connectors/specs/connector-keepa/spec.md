# Spec Delta

## Purpose

定义 Keepa 连接器提供的 Amazon 快照与历史数据，以及令牌桶额度的处理。

## ADDED Requirements

### Requirement: 令牌桶流控
Keepa 任务 SHALL 按套餐每分钟令牌数限速，并用响应中的剩余令牌与补充时间校准；令牌不足时 MUST 等待补充而不是失败。

#### Scenario: 令牌耗尽
- **WHEN** 响应显示剩余令牌为 0、60 秒后补充
- **THEN** 队列暂停约 60 秒后继续，任务不进入死信

### Requirement: 商品快照与历史
系统 SHALL 为跟踪的 Amazon 商品保存价格、BSR、卖家数、评分、评论数的当前值和日粒度历史；首次跟踪某商品时 SHALL 导入其可得的历史曲线，用于历史回放。BSR MUST 原样保存，不在连接器内换算为销量。

#### Scenario: 首次跟踪
- **WHEN** 一个 ASIN 首次进入跟踪列表
- **THEN** 系统保存该 ASIN 可得的价格、BSR、卖家数历史，每个日期一条观测

### Requirement: 卖家店铺新品与条件找品
系统 SHALL 按对标店铺池拉取 Amazon 卖家的商品列表以发现新品，并支持按方向的类目和条件查找商品用于方向扩展。

#### Scenario: 卖家上新
- **WHEN** 对标卖家新增一个 ASIN
- **THEN** 该 ASIN 被记录首次发现时间并加入跟踪

### Requirement: 按需请求附加数据
附加的 offers 数据 SHALL 只对属于线索的商品请求，以控制令牌消耗。

#### Scenario: 普通商品
- **WHEN** 同步一个不属于任何线索的商品
- **THEN** 请求中不包含 offers

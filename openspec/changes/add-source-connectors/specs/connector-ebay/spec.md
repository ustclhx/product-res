# Spec Delta

## Purpose

定义 eBay 官方接口（Browse、Taxonomy）连接器提供的数据、额度和已售量的处理方式。

## ADDED Requirements

### Requirement: 卖家新品发现
系统 SHALL 按对标店铺池中每个 eBay 卖家拉取最新上架的商品，遇到已发现过的商品即停止翻页，每店每日最多 2 页。新发现的商品 SHALL 记录首次发现时间并进入详情补全。

#### Scenario: 增量翻页
- **WHEN** 某卖家第 1 页中第 8 个商品已在系统中
- **THEN** 只保存前 7 个新商品，不请求第 2 页

### Requirement: 分档快照
系统 SHALL 每日为热点商品（近 7 天有动销或属于线索）、每 3–7 天为普通商品采集价格、可售量和已售量（如可得）快照，并保证 eBay Browse 当日消耗不超过安全线 4500、任何情况下不超过 5000。

#### Scenario: 额度不足时降档
- **WHEN** 当日剩余安全额度不足以覆盖全部普通档商品
- **THEN** 优先完成热点档，普通档中最久未更新的先采集，其余顺延

### Requirement: 已售量来源与回退
连接器 SHALL 先核验 `estimatedSoldQuantity` 在批量和单个查询中是否返回，并按结论：批量可得则用批量；仅单个可得则热点档改为逐个查询；都不可得则用相邻快照可售量的减少推算已售量。推算值 MUST 标记为“推算”，可售量增加（补货）的日期 MUST NOT 计为负销量或零销量。

#### Scenario: 推算遇到补货
- **WHEN** 某商品可售量从 50 变为 80
- **THEN** 当日已售量记为缺失，不记 0 或负数

#### Scenario: 官方字段可得
- **WHEN** 核验确认批量查询返回 `estimatedSoldQuantity`
- **THEN** 已售量观测的获取方式为“官方”，来源为 eBay Browse

### Requirement: 类目同步
系统 SHALL 每周同步 eBay US 类目树，供选品方向选择类目。

#### Scenario: 类目更新
- **WHEN** eBay 新增一个叶子类目
- **THEN** 下一次同步后该类目可以在方向配置中选择

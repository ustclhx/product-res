## ADDED Requirements

### Requirement: 店铺池
用户 SHALL 能粘贴 eBay 或 Amazon 店铺链接，把店铺加入店铺池，并标记类型（对标、热门、观察）和关联方向。系统 MUST 从链接解析出平台卖家 ID；无法解析时给出明确提示，不猜测。店铺池按空间隔离。

#### Scenario: 添加 Amazon 店铺
- **WHEN** 用户粘贴带 `seller=A1B2C3` 的链接
- **THEN** 店铺池新增 Amazon 店铺 A1B2C3

#### Scenario: 无法识别的链接
- **WHEN** 用户粘贴一个商品详情链接
- **THEN** 系统提示无法识别店铺，不创建记录

### Requirement: 店铺新品发现
系统 SHALL 记录被追踪店铺的商品及其首次发现、最近出现和下架日期。eBay 店铺 SHALL 通过官方 Browse 卖家新品发现。Amazon 店铺 SHALL 通过关键词搜索结果加报价中的卖家归属来发现，页面 MUST 标注该方式覆盖不完整。

#### Scenario: eBay 凭据未配置
- **WHEN** eBay 来源未配置
- **THEN** eBay 店铺显示"来源未配置"，Amazon 店铺照常追踪

### Requirement: 分档追踪
被追踪商品 SHALL 分为热点（每日）、普通（每 5 天）、冷门（停追）三档，按出单信号与线索状态自动升降档，并记录原因。被追踪商品总数 MUST 不超过配置的上限（默认 100）。

#### Scenario: 销量区间上升
- **WHEN** 普通档商品的 bought 区间在 7 天内上升
- **THEN** 该商品升为热点档，次日起每日快照

### Requirement: 店铺新品出单线索
被追踪店铺上架 30 天内的新品首次出现出单信号时（eBay 已售增量 ≥ 5，或 Amazon bought 下界 ≥ 50），系统 SHALL 生成来源为"店铺新品出单"的线索。同一商品 MUST 不重复生成。

#### Scenario: 新品开始出单
- **WHEN** 对标店铺 10 天前上架的 Amazon 新品今天进入 50+ bought
- **THEN** 生成一条店铺新品出单线索

### Requirement: 店铺指标
系统 SHALL 按日计算店铺的上新速度、新品存活率、新品命中率、出单区间合计和方向迁移。样本少于 5 个时 MUST 显示为空。

#### Scenario: 新店铺样本不足
- **WHEN** 店铺加入后仅发现 3 个新品
- **THEN** 新品命中率显示为空，不显示 0%

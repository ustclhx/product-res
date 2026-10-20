## ADDED Requirements

### Requirement: 经 AIsa 调用 DataForSEO
配置了 `AISA_API_KEY` 时，DataForSEO 连接器 SHALL 通过 AIsa 网关调用（Bearer 认证），请求体与响应体保持与直连一致。费用 SHALL 按响应体的 `cost` 结算，渠道记为 aisa。AIsa 返回 402 时 MUST 当日停止该来源；返回 401 时标记凭据失效。

#### Scenario: AIsa 余额不足
- **WHEN** AIsa 返回 402
- **THEN** 当日 DataForSEO 剩余任务停止，数据中心提示额度耗尽，不进死信重试

### Requirement: Amazon 数据采集
连接器 SHALL 提供以下任务：Amazon 关键词搜索结果、ASIN 详情、卖家报价、关键词搜索量。归一化 MUST：
- 用存档的真实响应做夹具测试；
- 把 "N+ bought" 解析为区间；
- 从详情文本中解析 BSR 和首次上架日期；
- 解析失败的字段记为缺失。

#### Scenario: 搜索结果中没有销量徽标
- **WHEN** 搜索结果中某商品没有 `bought_past_month`
- **THEN** 该商品不写 bought 观测，其余字段照常写入

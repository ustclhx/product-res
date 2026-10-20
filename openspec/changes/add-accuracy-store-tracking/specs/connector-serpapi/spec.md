## ADDED Requirements

### Requirement: SerpApi Amazon 商品
连接器 SHALL 用 `amazon_product` 引擎采集价格、评分、评论数、bought 区间和结构化 BSR；页面展示的评论正文有则写入评论表。预算 SHALL 按月度次数控制（默认硬上限 250、安全线 230），默认只对热点档商品做交叉采集。请求摘要与日志 MUST 不含 api_key。

#### Scenario: 月度次数接近上限
- **WHEN** 本月已用 230 次
- **THEN** 日常任务停止，余量只留给人工刷新

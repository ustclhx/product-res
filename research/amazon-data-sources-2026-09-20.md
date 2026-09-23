# Amazon 第三方数据源（截至 2026-09-20）

范围：面向 product-res 快速真实 demo；只核查供应商一手文档/定价页。本文验证的是文档陈述，未使用任何账号、API key 或真实调用。

## 对比

| 来源 | 可取字段/接口 | 历史与销量边界 | 注册、费用、美国可用性 | 适合度 |
|---|---|---|---|---|
| **Keepa API** | `/product` 按 ASIN 返回产品与完整价格/排名历史、offers；亦有 deals、best-sellers、seller、tracking。典型字段含 ASIN/title、价格类型（Amazon/新/旧/Buy Box/FBA 等）、sales rank、offers、rating、category。官方总览：[API docs](https://keepa.com/api-docs/)；字段：[Deal object](https://keepa.com/api-docs/deal-object.html)。 | 历史是 Keepa 观测的价格/排名时间序列，不是成交订单。best-sellers 文档明确列表按销售排名、通常每小时更新且可能缓存一小时；子类排序不一定等于 Amazon 实际排序，且只保留最近 36 个月历史月榜。[best-sellers](https://keepa.com/api-docs/best-sellers.html) | 必须在 Keepa 订阅 API plan 获取私有 key；token bucket 按分钟补充、请求消耗 token。[plans/tokens](https://keepa.com/api-docs/plans-tokens.html) 支持 `domain=1` amazon.com（US）及其他域名。官方文档未给出免费试用或具体当前美元价，需登录定价页核实。 | **历史增强候选**：适合 demo 展示长期价格/排名趋势；不能把 `monthlySold`/排名反推成真实销量，UI 应标“估算/代理指标”。 |
| **Rainforest API** | `type=product`：ASIN/URL/GTIN、title、variants、price、rating/reviews、bestsellers rank、offers、seller；`search`、`offers`、`reviews`、`bestsellers`、`stock estimation`、`sales estimation` 等。[common parameters](https://docs.trajectdata.com/rainforestapi/product-data-api/parameters/common)、[product](https://docs.trajectdata.com/rainforestapi/product-data-api/parameters/product)、[offers result](https://docs.trajectdata.com/rainforestapi/product-data-api/results/offers) | 产品/offer 是抓取时点快照；`sales estimation` 是供应商估计，不能称实际 Amazon 销量。`stock estimation` 从购物车推断库存；offers 文档警告 Amazon 不总返回 total pages。[offers](https://docs.trajectdata.com/rainforestapi/product-data-api/results/offers) | 需要账户 API key。官方页说明可从全球 Amazon domain 实时取数，故 `amazon.com` 可用。[overview](https://docs.trajectdata.com/rainforestapi)；公开文档当前未列具体计划价格/免费试用，需账户/销售确认。Collections 结果仅保留 14 天，非活动 collection 两个月删除。[collections limits](https://docs.trajectdata.com/rainforestapi/collections-api/limits) | **深度详情候选**：实时商品、offer、搜索体验好；无长期历史，需自行定期采样；销量只能展示为“估算”。 |
| **DataForSEO Amazon Merchant API** | Amazon products/ASIN/sellers/reviews；字段包括 title、URL/image、ASIN、categories、price_from/to、currency、rating/votes、labels、delivery、`bought_past_month` 等。[products live advanced](https://docs.dataforseo.com/v3/merchant/amazon/products/live/advanced/)；seller endpoint：[sellers](https://docs.dataforseo.com/v3/merchant/amazon/sellers/live/advanced/) | `bought_past_month` 是 Amazon 页面展示的购买数标签，不是全量真实订单；页面/排名/价格为抓取结果，不能做销量真值。没有供应商维护的产品历史，需自行存快照。 | Pay-as-you-go：官方产品页列 Standard $0.0015/页（最多 45 分钟）、Priority $0.003（最多 1 分钟）、Live $0.005（最多 1 分钟）；$1 免费试用 credit，$50 最低充值，credits 不过期。[pricing](https://dataforseo.com/amazon-product-api)；US location 可从 locations 接口取得。[task post](https://docs.dataforseo.com/v3/merchant-amazon-products-task_post/) | **首轮接入选择**：字段清晰、US 产品/ASIN 查询便宜；更适合一次性检索和自建历史，不适合直接宣称真实销量。 |

## 留存、展示与合规边界

- 本轮只找到 Rainforest 明确的数据集保留窗口（collection 结果 14 天）；Keepa/DataForSEO 的公开 API 文档页未核实出可直接引用的统一“允许长期缓存/对外展示”条款。实现前必须逐一阅读当前服务协议、许可和 Amazon 相关条款；不要把“能返回字段”推断成“可永久存储或公开转售”。
- 在确认账号许可范围后，Demo 可考虑保存自己计算的聚合指标（例如抓取时间、价格变化、排名变化），但展示应标注来源、时间戳、marketplace（amazon.com）、“第三方观测/估算”，并保留 ASIN/原始链接以便核验；不要展示或暗示订单量、收入、库存或销量为 Amazon 官方真实数据。
- 不存供应商 API key 到前端；后端代理并记录请求时间、来源和估算标签。不要抓取或展示不在授权范围内的原始 HTML/图片；具体可留存字段和再分发权限必须以已签订计划条款为准。

## 按本轮目标排序

1. **首轮 demo：DataForSEO**。先用 $1 trial 做小样本；`bought_past_month` 仅作为 Amazon 页面标签并注明其语义，不等同真实成交。
2. **后续历史增强：Keepa**。在取得订阅 API key 后，用 `amazon.com`、ASIN、当前价和价格/排名序列展示长期观察，不输出销量真值。
3. **深度详情备选：Rainforest**。使用 product/search/offers；历史记录需考虑自行采样，sales estimation 保持估算属性。

## 已验证与未验证

已验证：上述接口名称、关键字段、Keepa `amazon.com` domain、Rainforest 全球 domain/14 天结果窗口、DataForSEO 价格与 $1/$50 充值条件，均来自链接的一手文档。未验证：任何实际 API 调用、当前账号开通状态、延迟/覆盖率、供应商条款是否允许目标产品的长期留存和公开展示；这些都需要账号或法务/销售确认。

## 本次实施范围

用户优先接入方便的小规模 demo，因此首轮选择 DataForSEO Amazon US；Keepa 作为后续历史数据增强。另选 SerpApi Google Shopping US 支持自建站市场观察。此选择是工程判断，不是已实测质量排名。

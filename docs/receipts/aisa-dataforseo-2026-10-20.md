# AIsa → DataForSEO Amazon 核验回执（2026-10-20）

## 账户
- 套餐：Go-to-Market Builder，余额 $50.00，到期 2026-11-17。
- Key：未设置消费上限（`unlimited: true`）。
- Key 存放：服务器 `secrets/optional/AISA_API_KEY`，0600，UID 1000。

## 计费
- 计费方式：按 DataForSEO 响应体中的 `cost` × 1.0 收费。
- `batch_quote` 只按目录参考价给出估算，每次 $0.012，并标注"可能超出"。实际扣费以 `customer_cost_micros_usd` 为准。

| 调用（live/advanced，US，en_US） | 报价估算 | 实际扣费 |
|---|---|---|
| merchant/amazon/products（关键词 "kids backpack"，1 页） | $0.012 | **$0.0033** |
| merchant/amazon/asin（B0756FCPPN） | $0.012 | **$0.0050** |
| merchant/amazon/sellers（B0756FCPPN） | $0.012 | **$0.0033** |

本次核验共花费 $0.0116。

**未实测：**
- 异步 standard 队列（task_post / task_get）在 MCP 路由中不可执行，需走 HTTP 网关实测，单价通常更低。
- Labs Amazon 批量搜索量的报价估算为 $0.1356/次，未调用。

## 字段
**products（搜索结果页）**
- 结果：100 个自然结果 + 4 个广告。ASIN 在 `data_asin` 字段，100/100 有值。
- `price_from`、`rating`（含 `votes_count` 评论数）、`is_best_seller`、`is_amazon_choice`、`delivery_info`：104/104 有值。
- **`bought_past_month`：84/104 有值**。取值是区间下界（50、100、200、300、400、600、1000），对应页面上的 "N+ bought in past month"。缺失的 20 个是页面未显示该徽标。

**asin（详情页）**
- 有 `details` 和 `product_information`，其中可以解析出：
  - **Best Sellers Rank**（主类目和子类目排名）；
  - **Date First Available**（可用于判断新品）；
  - 评论数和评分、类目路径、`parent_asin`、`product_asins`（变体）。
- 样本中的 `bought_past_month` 为 null（该商品页面未显示徽标）；`top_local_reviews` / `top_global_reviews` 为空，**评论正文不可依赖此接口**。

**sellers（报价）**
- 每个在售报价有：卖家名、发货方、价格、成色、配送。样本有 2 个报价。

## 结论
- AIsa key 可用。DataForSEO Amazon 的搜索、详情、报价三个接口都可以经 AIsa 实时调用。
- 销量区间主要靠搜索结果页的 `bought_past_month`。BSR 和首次上架日期从详情页解析。
- 原始响应保存在协调者的临时目录，未入库。

## SerpApi 交叉核验（同日）
- 账户：免费档，每月 250 次，key 存放于 `secrets/optional/SERPAPI_API_KEY`（0600，UID 1000）。
- 样本：`amazon_product`，ASIN B0007QCQGI，消耗 1 次。

| 字段 | SerpApi | DataForSEO 搜索结果页 |
|---|---|---|
| bought | "7K+ bought in past month" | 7000 |
| 价格 | $31.48 | $31.48 |
| 评论数 | 45,483 | 45,400（显示值四舍五入） |
| BSR | 结构化：`extracted_rank` 1994（主类目）、#1（子类目） | 需从详情页文本中解析 |
| 评论正文 | 本次未返回 `reviews_information` | — |

结论：两个来源的 bought 区间与价格一致，可以互为交叉验证。SerpApi 的 BSR 是结构化字段，更方便。两边的评论正文都不稳定。

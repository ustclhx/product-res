# Design

背景与取舍见 `docs/plan/data-sources-design.md`（定稿）。本文只记录实施决策。

## D1 观测分级与区间

- `observation` 增加以下列：
  - `tier smallint not null`：0–4，对应 T0 真值、T1 官方、T2 页面展示、T3 第三方估算、T4 推算；
  - `value_low numeric null` / `value_high numeric null`：区间上下界，上界开放时为空；
  - `channel text null`：经由渠道，例如 `aisa`；
  - 主键不变。
- **区间写法：** "N+ bought" 写为 `value_low=N`，`value_high` 取 Amazon 徽标的下一档（50→100、100→200 … 1K→2K、7K→8K、10K→20K，档位表放代码常量）。`value` 存区间的对数中点，供算法使用。原始文本存在原始响应里，不另存。
- **迁移回填：** 已有行按 `method` 推出层级：official→1、import→2、estimate→3、derived→4。
- **主值：** `packages/marketdata` 的读取接口返回主值、全部来源值、区间和层级。
  - 主值先取层级号最小的（T0 优先于 T1）；同层级按 `metric_priority` 排；
  - 被抽检判定失去主值资格的来源（D5）跳过；
  - 只有失去资格的来源有值时，仍然返回，但标 `disqualified`。

## D2 DataForSEO 经 AIsa

- **传输方式：** 连接器配置 `transport: 'direct' | 'aisa'`，默认按凭据自动选择：有 `AISA_API_KEY` 用 aisa，否则有 `DATAFORSEO_LOGIN` 用 direct。
  - aisa 的 Base URL 为 `https://api.aisa.one/apis/v1/dataforseo`，`Authorization: Bearer`；
  - 请求体、响应体与 direct 相同。
- **计费：** 结算取响应体中的 `tasks[].cost`（与 direct 一致），渠道记 `aisa`。
- **AIsa 错误：** 402 视为额度耗尽（当日停止该来源）；401 视为凭据失效；429 退避重试。
- **使用 live 接口：** 异步 standard 队列在 MCP 路由中不可执行，HTTP 网关是否支持未核验。本期统一用 live；之后若核验通过，可加 standard 队列降本。
- **实测单价**（2026-10-20）：products $0.0033、asin $0.005、sellers $0.0033。预扣按 $0.006/次，结算按实际。
- **新增能力（DataKind / 任务类型）：**

| 任务 | 端点 | 归一化指标 |
|---|---|---|
| `amazon-search` | `merchant/amazon/products/live/advanced`（keyword，1 页） | 每个 ASIN：price、rating、review_count、bought_month（区间，T2）、is_best_seller、is_amazon_choice；新发现的 ASIN 写入 `marketplace_product` |
| `amazon-asin` | `merchant/amazon/asin/live/advanced` | price、rating、review_count、bsr_main 和 bsr_sub（从 `details` 或 `product_information` 文本中解析 "Best Sellers Rank"）、first_available（写商品属性）、parent_asin、品牌、类目路径 |
| `amazon-offers` | `merchant/amazon/sellers/live/advanced` | offer_count、lowest_price、每个报价的卖家名和发货方（写入 store_listing 归属，见 D4） |
| `amazon-keyword-volume` | `dataforseo_labs/amazon/bulk_search_volume/live` | 关键词 search_volume_month（T3） |

- **解析：** 以存档的真实响应为夹具，从 `docs/receipts` 对应的原始响应脱敏后放入 `packages/connectors/test/fixtures`。解析失败的字段记为缺失，不补零。

## D3 SerpApi 连接器

- 来源 ID `serpapi`；凭据 `SERPAPI_API_KEY`；预算单位为次/月，硬上限 250（免费档），安全线 230。
- 任务 `amazon-product`（`engine=amazon_product`）产出：price、rating、review_count、bought_month（区间，T2）、bsr_main / bsr_sub（取 `extracted_rank`）。`reviews_information.authors_reviews` 有值时写 `review` 表，来源记 serpapi。
- **用途：** 交叉验证，不取代主采集。每日只对热点档商品各采集 1 次，按月预算日均分配（约每天 8 次），优先最近进入线索或 bought 区间变化的商品。
- `api_key` 放在查询参数中。HTTP 层记录请求摘要时必须去掉该参数（`http.ts` 的脱敏规则扩展到查询参数）。

## D4 店铺池与店铺新品

- `tracked_store`：
  - 字段：`workspace_id`、platform、marketplace、seller_key（eBay 用户名或店铺名；Amazon 卖家 ID）、display_name、url、kind（benchmark / hot / watch）、reason、status（active / paused / removed）、direction_ids、created_at；
  - 用 `scoped()` 查询。与现有选品方向的对标店铺并存：方向配置读取时合并两处，不迁移旧数据。
- **链接解析**（纯函数，带测试）：

| 平台 | 支持的链接形式 |
|---|---|
| eBay | `ebay.com/str/<store>`、`ebay.com/usr/<user>`、带 `_ssn=<user>` 的搜索链接 |
| Amazon | 带 `seller=<ID>` 或 `me=<ID>` 的链接、`/sp?seller=<ID>` |

  无法解析时给出明确提示，不猜测。
- `store_listing`（部署级）：
  - 字段：platform、seller_key、product_id、first_seen_on、last_seen_on、delisted_on、discovery（`browse-seller`、`search-offer`）；
  - 唯一键：（platform、seller_key、product_id）。
- **eBay 新品：** 复用现有 Browse 卖家新品任务，范围扩到店铺池中的 eBay 店铺。没有 eBay 凭据时该来源为"未配置"，不阻塞其他任务。
- **Amazon 新品：**
  - 每个 Amazon 店铺配置 1–5 个搜索词（默认取关联方向的关键词），每 3 天跑一次 `amazon-search`。
  - 对新出现的 ASIN 跑一次 `amazon-offers`，卖家名或 ID 命中店铺池的，写入 `store_listing`。
  - 店铺页显示"发现方式：关键词覆盖"和该店铺最近 30 天的发现数，并明确提示覆盖不完整。
- **成本控制：** 每日报价调用设上限（默认 30），超出的顺延。

## D5 分档追踪

- **范围：** 被追踪商品 = 店铺池商品 ∪ 线索商品 ∪ 人工加入，上限 100 个（测试规模，可配置）。
- **档位与频率：**

| 档位 | 频率 | 升档条件 | 降档条件 |
|---|---|---|---|
| 热点 | 每日 | 新进线索、7 天内 bought 区间上升、eBay 已售增加 | 30 天无变化降一档 |
| 普通 | 每 5 天 | — | 30 天无变化降一档 |
| 冷门 | 停追 | — | — |

- 档位存在被追踪商品的状态表中，变更时记录原因。
- **Amazon 快照：** 每日任务按档位挑出到期商品，跑 `amazon-asin`。热点商品另由 SerpApi 交叉采集（D3）。
- **出单信号：** eBay 已售增量 ≥ 5（`estimatedSoldQuantity` 或推算），或 Amazon bought 区间下界 ≥ 50。上架 30 天内的店铺新品首次出现出单信号时，生成线索，来源记为"店铺新品出单"，进入现有选品流水线。

## D6 店铺指标

按日计算后写入观测，实体类型为卖家，层级 T4：

| 指标 | 定义 |
|---|---|
| 上新速度 | 每周新品数 |
| 新品存活率 | 上架 30 天后仍在售的比例 |
| 新品命中率 | 30 天内出现出单信号的比例 |
| 出单区间合计 | 店内商品出单区间之和 |
| 方向迁移 | 近 30 天新品类目分布与过去 90 天的差异 |

样本少于 5 个时不计算，显示为空。

## D7 人工抽检

- 每周一生成 `accuracy_audit`：从被追踪商品中随机抽 20 个（种子与抽样记录保存），生成 `accuracy_audit_item`。
  - 每项列出：商品链接，各来源的采集值（价格、bought 区间、评论数、评分、BSR、可售状态），以及采集时间。
- 人工打开页面后填写实际值。对 bought 字段，判断采集的区间是否与页面一致。提交后计算各来源 × 字段的一致率：
  - 价格误差 ≤ 1% 算一致；
  - 评论数误差 ≤ 2% 算一致；
  - 其余字段要求完全一致。
- **准确率 KPI：** 近 4 次抽检的一致率显示在数据中心。某来源某字段低于 95% 且样本 ≥ 20 时，该来源对该字段失去主值资格。下一次抽检回到 95% 以上即恢复。
- 抽检页属于空间页面；结果按部署级来源统计。

## D8 页面

- **数据中心：**
  - 观测表新增层级与区间列，区间显示为 "100–200"（上界开放时显示 "10K+"）；
  - 新增 AIsa、SerpApi 来源卡片，显示额度与花费；
  - 新增准确率 KPI 卡片。
- **店铺池页面**（工作台导航"店铺追踪"）：
  - 列表：店铺、平台、类型、新品数（7 天 / 30 天）、命中率、最近同步；
  - 添加：粘贴链接后解析；
  - 详情：新品列表（首次发现时间、档位、出单信号、区间）、店铺指标、覆盖率说明。
- **抽检页面：** 本周清单、逐项填写、历史一致率。
- UI 用现有 `packages/ui` 组件和 DataTable，文案走 paraglide（zh / en）。

## 风险

- **Amazon 覆盖率：** 只靠关键词发现 Amazon 店铺新品，覆盖率有限，页面会如实标注。跑通后据此决定是否接入 Keepa。
- **上游变化：** DataForSEO 和 SerpApi 的页面抓取字段可能随 Amazon 改版而变化。人工抽检与"关键字段缺失率"质量检查用于及时发现。
- **费用：** 测试规模约 $27/月，AIsa 额度 $50/月。账本的硬上限按 $45/月配置，留出人工刷新的余量。

## 实测修正（2026-10-23）

首轮真实测试（10 个 eBay 店铺）后的修正，归入本 change，tasks.md 不新增编号。

- **PAYMENT_MODE 透传：** 自托管 `deploy/selfhost/compose.yaml` 的 x-app-env 原先没有 `PAYMENT_MODE`，billing 开启时 jobs 的 `jobs-ten-minute-maintenance-v1` 每次报 `billing.runtime_invalid missing=["PAYMENT_MODE"]`。
  - compose 以 `${PAYMENT_MODE:-}` 透传，`.env.example` 说明取值；本项目支付渠道为空，生产设 `PAYMENT_MODE=test`。
  - Node 配置加载（`packages/config/src/node.ts`）把 `PAYMENT_MODE` 加入 blankAsUnset：Compose 传入的空串按“未设置”处理，交给 `resolvePaymentMode` 报 missing，而不是 invalid。
  - 不改变“线上未显式设置不默认 test”的规则：只有 `SENTRY_ENVIRONMENT=development` 才默认 test。
- **追踪名额的公平分配（`orderEnrollment`，rules.ts）：** 原实现按店铺顺序拼接候选，一轮发现 997 个新品时 100 个名额被头两个店铺占满。现在：
  1. 店铺内按首次发现日、上架日新到旧排序（上架日未知排后）；
  2. 店铺之间轮询，先给每个有候选的店铺保底 `floor(剩余名额 / 有候选的店铺数)`，候选不足保底的店铺按实际数量；
  3. 线索商品（origin lead）排在保底之后；
  4. 剩余名额继续店铺轮询。
  - 保底按本轮剩余名额而不是总上限计算：已追踪商品不按店铺回收，用总上限会让保底超过可用名额。剩余名额少于店铺数时保底为 0，线索商品先加入，店铺按顺序各取一个。
- **eBay `/str/` 链接解析为卖家用户名：** 10 个店铺中 7 个的店铺名与用户名不同（如 `/str/watchgenies` → `dexclusive-fashion`），而 Browse 的 `sellers:{}` 过滤只认用户名。
  - 添加店铺时，`/str/<店铺名>` 由 web 注入的解析器（`@product-res/connectors` 的 `resolveEbayStoreUsername`）抓取店铺页，从 SSR 数据中取唯一的 `"username":"..."`。
  - 只请求 `https://www.ebay.com/str/<店铺名>`，浏览器 UA，超时 8 秒、响应上限 4 MiB；`redirect: manual`，只跟随同站 `/str/` 跳转（最多 2 次），验证码页与站外跳转一律视为失败。
  - 成功时保存为 `/usr/<用户名>`（sellerKey 为用户名），显示名默认保留店铺名；没找到、出现多个不同用户名、被拦截或不可达时返回 `STORE_USERNAME_UNRESOLVED`（422），提示用户改贴 `ebay.com/usr/<用户名>`，不猜测。
  - 已入池的 `/str/` 店铺不自动迁移，由用户移除后改用 `/usr/` 链接重新添加。
- **来源停用提示：** 数据中心停用店铺所需来源（eBay → ebay-browse；Amazon → dataforseo 发现、serpapi 交叉验证）后，店铺页只会显示“没有新品”。
  - 列表页与详情页顶部显示醒目提示，并链接到数据中心对应来源卡片（`#source-<id>`）；
  - “立即跑一轮”在追踪中店铺所需来源全部停用时不入队（不占本小时名额），返回 `sources-disabled` 并显示同样提示。

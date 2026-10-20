# Proposal

## Why

在本系统中，数据源的精确性是最重要的事。已有的数据层只区分"获取方式"，有两个不足：无法表达区间值（Amazon "N+ bought in past month"），主值也不按可信度取。另外，Amazon 付费数据要统一经 AIsa 接入，并以 SerpApi 交叉验证。跟卖对标店铺和热门店铺需要持续追踪，记录它们的新品和出单。

设计已定稿，见 `docs/plan/data-sources-design.md`。核验回执见 `docs/receipts/aisa-dataforseo-2026-10-20.md`。

## What Changes

- **可信度分级与区间值：**
  - 观测增加层级（T0–T4）、区间下界和上界、经由渠道。
  - 主值先比层级，同层级再按来源优先级（之后按校准误差）。
  - 页面按区间展示。
- **人工抽检：**
  - 每周从被追踪商品中随机抽 20 个，生成核对清单。人工填写页面上的实际值后，系统计算各来源、各字段的一致率，作为准确率 KPI。
  - 一致率低于 95% 时，该来源失去主值资格。
- **DataForSEO 经 AIsa：**
  - 现有连接器增加 `aisa` 传输方式（Bearer，`https://api.aisa.one/apis/v1/dataforseo`）。
  - 新增 Amazon 能力：
    - 关键词搜索结果，含 `bought_past_month` 区间；
    - ASIN 详情，含 BSR、首次上架日期、评论数；
    - 卖家报价；
    - Labs 关键词搜索量。
- **SerpApi 连接器：** `amazon_product` 引擎，取 bought 区间、BSR、评论数和星级、价格、页面评论正文（有则取）。预算按月度次数。
- **店铺追踪：**
  - 店铺池：粘贴店铺链接，系统解析出卖家 ID。
  - 店铺新品发现：eBay 走 Browse 官方接口；Amazon 走关键词搜索结果，再按报价判断卖家归属，并标注覆盖率。
  - 被追踪商品分档快照：热点每日、普通 3–7 天、冷门停追，档位自动升降。
  - 店铺级派生指标。
  - "店铺新品出单"线索触发。出单门槛：eBay 已售 ≥ 5，或 Amazon 进入 50+ bought。
- **测试规模：** 10 个店铺、100 个商品；AIsa 月预算上限 $50，SerpApi 250 次/月。

## Capabilities

### New Capabilities

- `data-accuracy`：可信度分级、区间值、主值规则、人工抽检与准确率 KPI。
- `store-tracking`：店铺池、店铺新品与出单、分档追踪、店铺指标、线索触发。
- `connector-dataforseo-amazon`：DataForSEO 经 AIsa 的 Amazon 能力。
- `connector-serpapi`：SerpApi Amazon 商品。

### Modified Capabilities

无主规格变更。本 change 建立在 `add-data-source-hub` 与 `add-source-connectors` 之上，未开工的 Keepa、Jungle Scout、卖家精灵、Helium 10 任务保持不变。

## Impact

- **数据库：** 迁移在 `observation` 上增加列，新增 `tracked_store`、`store_listing`、`accuracy_audit`、`accuracy_audit_item` 表。
- **代码：** `packages/datasources`（类型）、`packages/connectors`、`packages/marketdata`、`apps/jobs`（调度与队列）、`apps/web`（店铺池、抽检、数据中心展示）。
- **凭据：** 服务器 `secrets/optional/AISA_API_KEY`、`SERPAPI_API_KEY` 已就位，经 `OPTIONAL_SECRETS_DIR` 读取。
- **上线：**
  - 去掉 `DATA_PIPELINE_SCHEDULES=paused` 之前，先用测试规模手动触发验收；
  - 自有店铺（T0）与校准模型不在本 change，等合作方提供数据后另起 change。

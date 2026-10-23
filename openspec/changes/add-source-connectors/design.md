# Design

## 背景

框架见 `add-data-source-hub` design。本 change 的风险集中在“外部接口实际给什么”，因此每个连接器的第一项任务都是核验，核验回执存 `docs/receipts/{source}-{date}.md`（脱敏），并据此回填本 design 的“核验结论”。

## 决策

### D1 接入顺序

1. eBay Browse + Taxonomy（免费、已有额度设计，且需最早开始积累快照）；汇率。
2. DataForSEO（已有经验）、Keepa（可立即做 Amazon 历史回放）。
3. SP-API（费用预估，核算依赖）。
4. Jungle Scout、卖家精灵（付费合同到位后）。
5. Helium 10 导入模板；如确认有 API，再起草补充 change。

### D2 eBay

- 应用令牌（client credentials）缓存到过期前 5 分钟；令牌请求也计入账本（单独的 OAuth 额度）。
- 卖家新品：`search` + `filter=sellers:{id}` + `sort=newlyListed`，每店 1–2 页，遇到已见过的 itemId 即停止翻页。
- 快照分档：热点（近 7 天有动销或属于线索）每日；普通 3–7 天轮询；按 `getItems` 每批 20 个。
- 已售量：
  - 若 `getItems` 返回 `estimatedSoldQuantity`：直接用，获取方式 = 官方；
  - 若仅 `getItem` 返回：热点改逐个查询（约 2500 次/天），普通档放宽到 7 天；
  - 若都不返回：用相邻快照可售量减少推算，获取方式 = 推算，补货（可售量增加）当天不计。
- 类目树每周同步一次（Taxonomy）。

### D3 DataForSEO

- Google Trends：5 年周度曲线，按方向的关联关键词每周更新。
- 关键词月搜索量历史：每周更新。
- Amazon 商品/卖家结果与评论：先核验字段与单价，再决定是否作为 Keepa/SP-API 的补充来源。
- 预算单位美元/月，按任务单价预扣；标准队列（非实时）优先以降低单价。

### D4 Keepa

- 令牌桶：队列速率按套餐每分钟令牌数配置，响应中的 `tokensLeft` / `refillIn` 写对账。
- 商品请求按需开启 stats、offers；offers 每页额外消耗令牌，只对线索商品开启。
- 卖家店铺商品列表用于 Amazon 的“卖家新品”；Product Finder 用于方向扩展。
- 历史曲线（价格、BSR、卖家数）以日粒度写入 `observations`，用于历史回放；BSR → 销量的换算不在连接器里做（属于 M2/M5 算法），连接器只存原始 BSR。

### D5 SP-API

- LWA 授权 + 卖家授权；按接口官方限流配置队列速率，429 退避。
- 目录（Catalog Items）：标题、品牌、类目、尺寸重量、图片。
- 竞争价格（Product Pricing）：最低价、Buy Box 价、卖家数。
- 费用预估（Product Fees `getMyFeesEstimateForASIN`）：按“价格 × FBA/FBM”请求，结果写 `fee_estimates`；失败时核算回退到费率表并标记“非官方预估”。
- 品牌分析报表需品牌备案，本期只做核验，不做同步。

### D6 Jungle Scout / 卖家精灵

- 按合同的月度次数配置预算，默认“日均分配 + 结余滚动”。
- Jungle Scout：Sales Estimates（单 ASIN 日销量估算）、Product Database（按条件筛选）、Keywords（搜索量与历史）。
- 卖家精灵：选产品、选市场、关键词挖掘、反查流量词；核验评论增长与评论内容是否可得。
- 两者的销量估算均为“第三方估算”，与 Keepa 推算并列。

### D7 Helium 10

- 本期按文件导入：为 Black Box、Xray、Cerebro、Magnet 的导出文件预置导入模板（列映射、单位、上下文字段），模板以真实导出样例校准。
- 同时向 Helium 10 确认 Enterprise API 的权限、价格和条款；确认后另起 change 增加接口，导入模板保留作为备用。

### D8 汇率

- 每日从公开来源（如 ECB）拉取 USD、EUR、GBP、JPY 对 CNY；团队可手填覆盖某日汇率，覆盖值优先，获取方式 = 手工导入。

### D9 初始来源优先级

| 指标（Amazon） | 优先级 |
|---|---|
| 月销量估算 | Jungle Scout > 卖家精灵 > Helium 10 导入 > Keepa 推算 |
| 价格 / 卖家数 | SP-API > Keepa > DataForSEO |
| BSR | Keepa > SP-API 目录 |
| 关键词站内搜索量 | 卖家精灵 > Jungle Scout > Helium 10 导入 |
| FBA 费用 | SP-API > 费率表 |

eBay 价格、可售量、已售量只有 Browse 一个来源。

## 核验结论（实施时回填）

| 数据源 | 日期 | 结论 |
|---|---|---|
| eBay `estimatedSoldQuantity` | 2026-10-23 | getItem 返回（官方）；getItems 需额外授权（403）→ 快照默认逐个 getItem，见 `docs/receipts/ebay-browse-2026-10-23.md` |
| DataForSEO Amazon 评论 | — | 待核验 |
| 卖家精灵评论内容 | — | 待核验 |
| 汇率（ECB） | 2026-10-18 | 通过，见 `docs/receipts/fx-ecb-2026-10-18.md` |
| Helium 10 API | — | 待确认 |

## 风险与取舍

- 第三方条款可能限制数据存储时长或展示方式：核验时一并阅读条款，必要时按数据源设置原始存档保留期和展示限制。
- 账号到位时间不一：连接器之间无依赖，未到位的保持“未配置”。

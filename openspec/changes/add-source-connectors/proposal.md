# Proposal

## Why

`add-data-source-hub` 提供了与工具无关的数据层框架，但没有真实数据。本期范围是 Amazon + eBay，需求方要求接入 eBay 官方接口、DataForSEO、Jungle Scout、Helium 10、卖家精灵，并扩展更多数据源。这些数据源的可用字段、计费和条款都要用真实凭据核验后才能确定，而核验结论直接决定后续信号、打分和置信度的算法设计（例如 eBay 能否拿到已售量、哪个来源能提供评论正文）。所以连接器单独成一个 change，先接入、先核验、先持续积累数据。

## What Changes

按优先级接入以下数据源，每个都先做“凭据 + 字段核验”并存档回执：

| 数据源 | 平台 | 本期提供的数据类型 |
|---|---|---|
| eBay Browse + Taxonomy | eBay | 卖家新品、商品快照、已售量或可售量（核验）、类目 |
| DataForSEO | 通用 + Amazon | Google Trends、关键词月搜索量历史；Amazon 商品与卖家结果、评论（核验） |
| Keepa | Amazon | 商品快照、价格/BSR/卖家数历史、卖家店铺商品、按条件找商品 |
| Amazon SP-API | Amazon | 目录信息、竞争价格、FBA 费用预估 |
| Jungle Scout API | Amazon | 销量估算、产品数据库、关键词搜索量与历史 |
| 卖家精灵开放平台 | Amazon | 选产品、选市场、关键词、反查流量词、销量与评论增长 |
| Helium 10 | Amazon | 先做导出文件导入模板（Black Box、Xray、Cerebro、Magnet）；确认有 API 后再加接口 |
| 汇率 | 通用 | 每日汇率，可手填覆盖 |

- eBay 首项任务：用 Production 凭据确认 `getItem` / `getItems` 是否返回 `estimatedAvailabilities[].estimatedSoldQuantity`，按结论选择快照策略。
- 每个数据源给出默认预算、队列流控和指标来源优先级的初始值。
- Amazon 销量估算由多个来源并列提供，初始优先级 Jungle Scout > 卖家精灵 > Keepa 推算，可调。

## Capabilities

### New Capabilities

- `connector-ebay`、`connector-dataforseo`、`connector-keepa`、`connector-amazon-spapi`、`connector-jungle-scout`、`connector-sellersprite`、`connector-helium10`、`connector-fx`：各数据源提供的数据、核验项、额度与特殊处理。

### Modified Capabilities

无。全部建立在 `add-data-source-hub` 的 `data-sources`、`source-budgets`、`data-sync`、`market-data-model`、`data-import` 要求之上。

## Impact

- 新增 `packages/connectors/*`；每个连接器附带用真实响应（脱敏后）做的归一化夹具。
- 需要账号与凭据：eBay Production keyset、Amazon 卖家账号与 SP-API 开发者注册、Keepa、Jungle Scout、卖家精灵开放平台、DataForSEO；Helium 10 确认是否有 Enterprise API。账号未到位的连接器在核验前保持“未配置”，不阻塞其他连接器。
- 付费数据源产生费用，预算上限需团队确认后填写。
- 不包含算法、线索、商品簇归并和品类洞察页面；不包含 Terapeak（hold）和 1688 接口（P1）。

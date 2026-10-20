# Tasks

依赖：`add-data-source-hub`、`add-source-connectors` 已合并部分。组 1 先完成并合并，之后组 2、3、4 并行。部署与真实凭据验收（5.x）在合并后由协调者执行。

## 1. 数据层（分级、区间、店铺与抽检表）

- [x] 1.1 迁移：`observation` 增加 tier、value_low、value_high、channel 并按 method 回填；新增 `tracked_store`、`store_listing`、`tracked_product`（档位与原因）、`accuracy_audit`、`accuracy_audit_item`。验证：迁移在空库与已有数据上均通过。
- [x] 1.2 `packages/datasources` 归一化类型支持层级、区间、渠道；Amazon bought 档位表与对数中点函数。验证：单元测试覆盖档位边界。
- [x] 1.3 `packages/marketdata` 写入与读取：按层级取主值、返回全部来源值、区间与层级，跳过失去资格的来源。验证：spec 场景测试。

## 2. 连接器

- [x] 2.1 DataForSEO `aisa` 传输方式（凭据自动选择、Bearer、402/401/429 分类、渠道记录）。验证：传输与错误分类测试。
- [x] 2.2 Amazon 任务 `amazon-search`、`amazon-asin`、`amazon-offers`、`amazon-keyword-volume`，用真实响应夹具归一化（bought 区间、BSR、首次上架日期解析）。验证：夹具测试；缺失字段不写。
- [x] 2.3 SerpApi 连接器 `amazon-product`、月度预算、查询参数脱敏。验证：夹具测试；日志与存档摘要不含 api_key。

## 3. 店铺追踪

- [x] 3.1 店铺链接解析（eBay / Amazon）与店铺池服务端接口（`scoped()`，adminAction 规则不适用于空间页面，用 withWorkspace）。验证：解析测试，含无法识别的链接。
- [x] 3.2 店铺新品发现：eBay Browse 任务范围扩到店铺池；Amazon 关键词搜索 + 报价归属，每日报价调用上限。验证：集成测试（mock 连接器）。
- [x] 3.3 分档追踪调度、出单信号、店铺新品出单线索（去重）、店铺指标。验证：升降档、线索去重、样本不足时为空的测试。
- [x] 3.4 店铺追踪页面（列表、添加、详情、覆盖率说明）。验证：组件测试与 e2e 冒烟。

## 4. 准确性与数据中心

- [ ] 4.1 每周抽检生成、填写与一致率计算、主值资格判定。验证：spec 场景测试。
- [ ] 4.2 抽检页面；数据中心显示层级与区间，增加 AIsa、SerpApi 来源卡片与准确率 KPI。验证：组件测试。

## 5. 验收（协调者）

- [ ] 5.1 部署到生产，在流水线暂停的状态下手动触发：10 个店铺、100 个商品跑一轮。核对花费与预估一致（AIsa 账单与账本差异 ≤ 5%）。
- [ ] 5.2 第一次人工抽检完成，确认准确率 KPI 正常显示。
- [ ] 5.3 去掉 `DATA_PIPELINE_SCHEDULES=paused`，连续运行 7 天，确认 AIsa 花费不超过 $45/月的节奏。

# Tasks

依赖 `add-follow-selection`（线索）与 `add-costing-decisions`（跟卖方式、档案库）。所有完成勾选都须有验证证据。

## 1. 聚合纯函数

- [x] 1.1 `packages/insight`：同比（重叠月份）、近 90 天新品数、价格带、CR3/CR10、竞品矩阵、气泡图数据、差评筛选（design D2）。验证：spec 场景用例。 证据：`pnpm --filter @product-res/insight test` 22 例通过，含“去年缺 3 个月 → 覆盖 9 个月”“无评论 → no-source”“无有效引用的建议被丢弃”；`pnpm typecheck`、`pnpm check`、`pnpm check:deps` 通过。

## 2. 数据表

- [ ] 2.1 `category_study`、`category_study_snapshot`（空间级）与 `marketplace_review`（部署级）、评论指标登记。验证：迁移与隔离测试。 证据：迁移 0018_costing_insight_validation.sql 已在本地库应用；packages/db/test/insight.test.ts 覆盖研究/快照隔离与评论（商品 × 评论 ID）唯一、评分范围；评论不是观测指标，未改 metrics。

## 3. 报告

- [ ] 3.1 研究列表与新建、生成/刷新快照（只读观测值）的 server functions。验证：刷新保留历史的测试。
- [ ] 3.2 报告页面（模块卡片 + 图表 + 快照切换 + 来源查看），对照设计稿。验证：截图对照；无数据模块显示“无数据来源”。
- [ ] 3.3 差评痛点与差异化建议（`packages/ai`，引用校验，未配置 AI 时显示原因）。验证：引用缺失的建议被丢弃的测试；用量记录测试。
- [ ] 3.4 转为线索（同款微改良）与归档到档案库。验证：转线索后候选列表可见。

## 4. 验收

- [ ] 4.1 用夹具数据为一个品类生成报告并转出一条线索的 e2e。
- [ ] 4.2 确定评论数据来源并接入（依赖数据源核验）。

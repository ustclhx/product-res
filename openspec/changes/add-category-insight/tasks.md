# Tasks

依赖 `add-follow-selection`（线索）与 `add-costing-decisions`（跟卖方式、档案库）。所有完成勾选都须有验证证据。

## 1. 聚合纯函数

- [x] 1.1 `packages/insight`：同比（重叠月份）、近 90 天新品数、价格带、CR3/CR10、竞品矩阵、气泡图数据、差评筛选（design D2）。验证：spec 场景用例。 证据：`pnpm --filter @product-res/insight test` 22 例通过，含“去年缺 3 个月 → 覆盖 9 个月”“无评论 → no-source”“无有效引用的建议被丢弃”；`pnpm typecheck`、`pnpm check`、`pnpm check:deps` 通过。

## 2. 数据表

- [ ] 2.1 `category_study`、`category_study_snapshot`（空间级）与 `marketplace_review`（部署级）、评论指标登记。验证：迁移与隔离测试。 证据：迁移 0018_costing_insight_validation.sql 已在本地库应用；packages/db/test/insight.test.ts 覆盖研究/快照隔离与评论（商品 × 评论 ID）唯一、评分范围；评论不是观测指标，未改 metrics。

## 3. 报告

- [x] 3.1 研究列表与新建、生成/刷新快照（只读观测值）的 server functions。验证：刷新保留历史的测试。 证据：apps/web/src/features/category/{category.functions.ts,category.server.ts,snapshot.server.ts}；apps/web/test/category-insight.test.ts（真实 PG）“刷新新增快照且旧快照保留可选”“无匹配商品时各模块无数据来源”通过（同比覆盖 9 个月、退货率 no-source）；只读 observation / marketplace_* 表，不调用连接器。
- [x] 3.2 报告页面（模块卡片 + 图表 + 快照切换 + 来源查看），对照设计稿。验证：截图对照；无数据模块显示“无数据来源”。 证据：/app/$slug/category 与 /app/$slug/category/$studyId；apps/web/e2e/category-insight.spec.ts 通过，截图 docs/receipts/m4-category-2026-10-19/（01 生成报告、02 主题与建议版式（AI 结果为截图夹具）、03 来源查看、04 转线索、05 无数据来源、06 列表）。
- [x] 3.3 差评痛点与差异化建议（`packages/ai`，引用校验，未配置 AI 时显示原因）。验证：引用缺失的建议被丢弃的测试；用量记录测试。 证据：apps/web/src/features/category/ai.test.ts（丢弃无有效引用、主题占比按差评数）；category-insight.test.ts“引用缺失的被丢弃、输入不变时沿用不重复调用”“未配置 AI 不调用”“经 packages/ai 计费链路写入 ai_message 并扣积分”（mock 模型）通过。
- [x] 3.4 转为线索（同款微改良）与归档到档案库。验证：转线索后候选列表可见。 证据：category-insight.test.ts“转线索”通过：按方向可查到线索、单成员锁定簇、lead_event 备注 followMode=improved 与改良点、再次转换复用、无方向时 DIRECTION_REQUIRED；“归档”通过：listArchivedStudies 可查到（档案库页面待另一任务接入）。跟卖候选页面尚为占位，“候选可见”以按方向查询线索验证。

## 4. 验收

- [x] 4.1 用夹具数据为一个品类生成报告并转出一条线索的 e2e。 证据：`apps/web/e2e/category-acceptance.spec.ts` 通过（新建研究 → 报告各模块有数据或“无数据来源” → 矩阵转线索 → 跟卖候选可见且线索默认同款微改良 → 归档后档案库可见）；记录与截图 `docs/receipts/m4-acceptance-2026-10-19.md`。
- [ ] 4.2 确定评论数据来源并接入（依赖数据源核验）。

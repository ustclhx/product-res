# Tasks

依赖 `add-follow-selection` 的线索表与页面。所有完成勾选都须有验证证据。

## 1. 核算纯函数

- [x] 1.1 `packages/costing`：阶梯价、MOQ、计费重量（首重续重 / 体积重 / 按方）、各成本项、净利润、保本价、毛利率、缺失输入报告、最优组合选择、成本确定性（design D2–D3）。验证：spec 场景（阶梯价、MOQ、体积重、保本价 $10.78、缺少重量、来不及）。 证据：`packages/costing`（quote/shipping/costing/deadline/matrix/certainty/params），`test/basics.test.ts`、`test/costing.test.ts`、`test/matrix.test.ts` 共 34 例覆盖阶梯价 ¥12、低于 MOQ、体积重 1.0 kg、保本价 $10.78、缺少重量、来不及、禁运、最晚决定日 5/18、成本确定性与类目回退；`typecheck`、`check`、`check:deps` 通过。

## 2. 数据表与设置

- [x] 2.1 `packages/db/src/schema/costing.ts`：design D1 的表与迁移。验证：`scoped()` 跨空间隔离测试。 证据：迁移 0018_costing_insight_validation.sql 已在本地库应用；packages/db/test/costing.test.ts 覆盖隔离、决定/默认参数/核算组合唯一与放弃原因约束，db 测试 70 项通过。
- [x] 2.2 设置页增加“物流方案 / 成本参数”标签与 server functions。验证：增删改与类目回退测试。 证据：`apps/web/src/features/costing/settings.{server,functions}.ts`、`settings-tabs.tsx`（三种计费方式：首重续重 / 体积重系数 / 按方，禁运属性；成本参数按平台 × 类目，逐项标注“平台默认”），`test/costing-decisions.test.ts` 的物流方案、成本参数用例（增改删、类型与公式校验、同名 / 默认唯一冲突、成员只读、类目回退与 effectiveCostParams）及 `e2e/costing-settings.spec.ts` 通过。
- [x] 2.3 供应商与报价录入（线索详情“核算”标签内）及报价导入模板（复用数据中心导入，可撤销）。验证：撤销导入只删导入报价。 证据：`apps/web/src/features/costing/quotes.server.ts`、`quote-editor.tsx`（商品簇详情“核算”标签：供应商增改删、阶梯 / 币种 / MOQ / 重量 / 尺寸 / 可信度 / 报价日期录入，写报价后线索 new → costing），数据中心“供应商报价表”导入 `quote-import{,.server}.ts`、`quote-import-panel.tsx`、`quote-template.ts`（按簇 ID 或平台商品 ID 关联、可下载模板、来源 import + import_id、data_import 批次按空间隔离）；`test/costing-matrix.test.ts`（真实 PG）覆盖录入与成员只读、导入错误行须跳过、重复导入确认、撤销只删本批导入的报价（手工录入与导入后手工改过的保留）、其他空间不可见不可撤销；`matrix-input.test.ts` 覆盖报价表解析与模板表头。

## 3. 核算与决定

- [x] 3.1 核算矩阵与成本瀑布（线索详情“核算”标签）：组合计算、最优高亮、选定组合 → pending。验证：组件测试与截图。 证据：`apps/web/src/features/costing/matrix.server.ts`、`matrix-input.ts`、`costing-tab.tsx`、`waterfall.tsx`（报价 × 本平台物流方案 × 跟卖方式；售价默认竞品中位价可改，汇率取 fx_rate 主值经 CNY 交叉，成本参数类目回退，节点取方向最近节点；每格落地成本 / 保本价 / 毛利率 / 最晚决定日或低于 MOQ、禁运、来不及、缺少：…；最优高亮；选定后服务端重算写 costing_scenario（完整矩阵格 + 输入来源）、线索 → pending、follow_mode 写回与 lead_event；ECharts 成本瀑布）；lead 表新增 follow_mode / improvement（迁移 0019_lead_follow_mode.sql），品类洞察转线索写这两列。`test/costing-matrix.test.ts` 覆盖组合计算与最优选择、跟卖方式切换与微改良、选定后 pending 进入待决定队列、已决定线索拒绝修改；`e2e/costing-matrix.spec.ts` 与截图 `docs/receipts/m3-costing-2026-10-19/`。
- [x] 3.2 待决定队列（工作台首页）与跟卖/放弃决定；决定快照与锁定。验证：状态流转测试；橙/红标记测试。 证据：`apps/web/src/features/costing/decisions.server.ts`、`home-page.tsx`、路由 `/app/$slug/`（KPI、按最晚决定日升序的队列、节点倒计时、行内跟卖 / 放弃）；`src/features/costing/queue.test.ts`（5 天内橙、过期红、SGT 日期）与 `test/costing-decisions.test.ts`（pending → followed / dropped、快照含分数 / 等级 / 置信度 / 权重版本 / 所选组合 / cluster_signal 输入、lead_event、重复决定 LEAD_DECIDED、`assertCostingEditable` 锁定、无选定组合不能跟卖、“其他”须说明）通过。
- [x] 3.3 M2 维度接入核算结果（利润空间、供应与时效、成本确定性）。验证：有核算时维度不再为空的测试。 证据：`packages/follow/src/pipeline.ts` 的 `loadClusterCosting`（跟卖方式取计算日及之前最新线索的 follow_mode；核算组合取最近一条有可用组合的线索，选定组合优先，否则毛利率最高的可计算组合）接入 `computeCluster`：利润空间用组合毛利率 / 落地成本（`packages/selection` `profit({ costed })`，毛利门槛随之生效）、供应与时效用组合最晚决定日（`supplyTiming({ costed })`，lead.latest_decision_on 随之更新），来源引用 `costing_scenario`（INTERNAL_SOURCES.costing，详情页显示“核算组合”）；置信度新增“成本确定性”项（取矩阵写入的 packages/costing certainty，未核算为空不计入）；风险按 lead.follow_mode 评估，新一天线索沿用 follow_mode / improvement。`packages/follow/test/costing.test.ts`（真实 PG）：未核算时利润为空、成本确定性为空；有选定组合时两个维度不为空且来源为 costing_scenario、最晚决定日 2032-06-01、成本确定性 0.8；毛利率 8% 低于底线 15% 时 margin 门槛不通过；follow_mode=improved 时品牌风险由高降为中、合规分提高且次日沿用；`packages/selection/test/signals.test.ts`、`confidence.test.ts` 新增 costed 利润 / 时效与成本确定性用例。pipeline.test.ts 改为只跑本测试空间（`runSelectionDaily` 新增可选 `workspaceIds`）并加入重叠方向的另一空间，清理按依赖顺序（helpers.cleanup）。follow 24、selection 87 passed。

## 4. 档案库与回看

- [x] 4.1 `/app/$slug/archive`：列表、筛选、快照查看、回看录入与对比。验证：快照不随重算变化的测试。 证据：`apps/web/src/features/costing/archive.server.ts`、`archive-page.tsx`、路由 `archive.tsx`（平台 / 方向 / 决定类型 / 日期筛选，快照详情，30 天回看录入与预测对比，品类报告空状态）；`test/costing-decisions.test.ts` 在决定后改写线索分数、权重版本与组合结果，档案库仍显示决定时的 78 分、v3、毛利率 31%，并覆盖筛选、待回看、回看对比与更正、跨空间隔离。
- [x] 4.2 `selection-review-v1` 回看提醒（站内通知）。验证：到期发通知、已录入不重复。 证据：`apps/jobs/src/review/selection-review.ts`（每日 09:00 Asia/Singapore、missedRun once，Node 运行时注册；lead_event note `review-reminder` 作幂等标记，与通知同事务），`apps/jobs/test/selection-review.test.ts`：到期发给决定人、决定人离开时发给所有者，已回看 / 未到期 / 放弃不发，重复运行与次日运行不重复。

## 5. 验收

- [x] 5.1 一条线索从发现 → 核算 → 待决定 → 跟卖 → 档案库的 e2e。 证据：`apps/web/e2e/costing-acceptance.spec.ts` 通过（夹具线索 → 页面录入报价 → 设置物流方案与成本参数 → 矩阵选定 → 工作台待决定 → 跟卖 → 档案库快照 v1 / 77 分 / 毛利率 52.6%）；记录与截图 `docs/receipts/m3-acceptance-2026-10-19.md`。

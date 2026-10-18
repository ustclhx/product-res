# Tasks

依赖 `add-follow-selection` 的线索表与页面。所有完成勾选都须有验证证据。

## 1. 核算纯函数

- [x] 1.1 `packages/costing`：阶梯价、MOQ、计费重量（首重续重 / 体积重 / 按方）、各成本项、净利润、保本价、毛利率、缺失输入报告、最优组合选择、成本确定性（design D2–D3）。验证：spec 场景（阶梯价、MOQ、体积重、保本价 $10.78、缺少重量、来不及）。 证据：`packages/costing`（quote/shipping/costing/deadline/matrix/certainty/params），`test/basics.test.ts`、`test/costing.test.ts`、`test/matrix.test.ts` 共 34 例覆盖阶梯价 ¥12、低于 MOQ、体积重 1.0 kg、保本价 $10.78、缺少重量、来不及、禁运、最晚决定日 5/18、成本确定性与类目回退；`typecheck`、`check`、`check:deps` 通过。

## 2. 数据表与设置

- [x] 2.1 `packages/db/src/schema/costing.ts`：design D1 的表与迁移。验证：`scoped()` 跨空间隔离测试。 证据：迁移 0018_costing_insight_validation.sql 已在本地库应用；packages/db/test/costing.test.ts 覆盖隔离、决定/默认参数/核算组合唯一与放弃原因约束，db 测试 70 项通过。
- [ ] 2.2 设置页增加“物流方案 / 成本参数”标签与 server functions。验证：增删改与类目回退测试。
- [ ] 2.3 供应商与报价录入（线索详情“核算”标签内）及报价导入模板（复用数据中心导入，可撤销）。验证：撤销导入只删导入报价。

## 3. 核算与决定

- [ ] 3.1 核算矩阵与成本瀑布（线索详情“核算”标签）：组合计算、最优高亮、选定组合 → pending。验证：组件测试与截图。
- [ ] 3.2 待决定队列（工作台首页）与跟卖/放弃决定；决定快照与锁定。验证：状态流转测试；橙/红标记测试。
- [ ] 3.3 M2 维度接入核算结果（利润空间、供应与时效、成本确定性）。验证：有核算时维度不再为空的测试。

## 4. 档案库与回看

- [ ] 4.1 `/app/$slug/archive`：列表、筛选、快照查看、回看录入与对比。验证：快照不随重算变化的测试。
- [ ] 4.2 `selection-review-v1` 回看提醒（站内通知）。验证：到期发通知、已录入不重复。

## 5. 验收

- [ ] 5.1 一条线索从发现 → 核算 → 待决定 → 跟卖 → 档案库的 e2e。

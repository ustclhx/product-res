# Tasks

依赖 `add-data-source-hub` 与 `add-source-connectors` 已合并部分。所有完成勾选都须有验证证据。分组按文件不重叠拆分，可并行。

## 1. 纯函数包（packages/selection、packages/risk）

- [x] 1.1 `packages/selection`：维度映射（scales）、7 维信号、最晚决定日、综合分、硬门槛、等级、置信度（design D4–D6）。验证：每个维度的边界与缺失用例；spec 场景（否决、冷启动、高分低置信、缺失不计 0）。 证据：`packages/selection/src`（scales/signals/deadline/score/confidence）；`test/scales.test.ts` 映射边界，`test/signals.test.ts` 7 个维度的计算、边界与缺失为空（eBay 无已售观测、无落地成本等），`test/deadline.test.ts`「返校季 … → 5/18」，`test/score.test.ts`「一票否决：综合分 82 但合规 20」「冷启动：显示“未验证”…」「缺失维度不按 0 计」「少于 4 个维度不给综合分」，`test/confidence.test.ts`「高分低置信」「只有单一来源的指标标“未交叉验证”」；`check:deps` 通过。
- [x] 1.2 `packages/selection` 的归并：标题规范化、Jaccard、GTIN/平台 ID 合并、锁定成员不被覆盖（design D3）。验证：spec 场景用例。 证据：`packages/selection/src/cluster.ts`；`test/cluster.test.ts`「GTIN 相同归为一簇…0.95」「标题相似 0.7 但类目不同不归并」「平台 ID 相同即同一商品」「拆分后次日自动归并不会把成员合回原簇」「合并两个簇」。
- [x] 1.3 `packages/risk`：品牌库、VeRO、品牌备案、受限类目、认证、禁运、外观专利提示（Google Patents 链接）。验证：spec 场景用例；`check:deps` 通过。 证据：`packages/risk`（`checkRisks`，扣分常数 `LEVEL_PENALTY`），`test/check.test.ts` 覆盖品牌库命中、Unbranded、VeRO、品牌备案否决、外观专利链接、类目/认证/危险品、禁运；`check:deps` 通过。

## 2. 数据表与配置页面

- [x] 2.1 `packages/db/src/schema/selection.ts`：design D2 的全部表与迁移，预置美国节点与默认评分设置（种子迁移）。验证：迁移由 migrator 执行；`scoped()` 跨空间隔离测试。 证据：迁移 `packages/db/migrations/0017_selection.sql` 由 migrator（`db:migrate` 与集成测试 global-setup）执行；12 张表均带 `workspace_id` 并登记到 `no-unscoped-workspace-query.grit`；预置数据改为空间级 `ensureSelectionDefaults`（`src/selection-defaults.ts`，首次打开方向页 / 设置页时写入，不进迁移）；`packages/db/test/selection.test.ts`「select 只返回本空间的行」「用其他空间的 id 读写与不存在的记录一样返回 404」「批量更新与删除不影响其他空间」「插入时带入其他空间的 id 被拒绝」「首次写入美国节点与评分设置版本 1；并发和重复调用不重复写入」；db 测试 63/63 通过。
- [x] 2.2 选品方向与店铺池页面（`/app/$slug/follow/directions`）与 server functions：增删改、停用、店铺推荐接受/拒绝。验证：写入权限（owner/admin、可写空间）测试；e2e 或组件测试。 证据：`apps/web/src/features/follow/directions.{functions,server}.ts`、`directions-page.tsx`，跟卖选品页加入口；`apps/web/test/follow-selection-config.test.ts`「增改停用删除；节点只接受本空间的 id；同名冲突」「已有商品簇的方向只能停用」「member 与只读空间不能写入」「种子添加、推荐接受 / 拒绝、拒绝后重新添加为种子」；`src/features/workbench/access.test.ts`；e2e `apps/web/e2e/follow-directions.spec.ts` 本地通过。
- [x] 2.3 设置页（`/app/$slug/config`）：节点日历、品牌库、风险规则标签页。验证：增删改测试。 证据：`apps/web/src/features/config/`（物流与成本标签只有“后续开放”说明）；`apps/web/test/follow-selection-config.test.ts`「节点增删改；删除节点时从方向中移除关联；非法日期被拒绝」「品牌库增删改，同类型同平台不区分大小写去重」「风险规则增删改，需要类目或商品属性」（规则结构与 packages/risk 的 `RiskRule.match` 一致）；e2e 覆盖标签切换与品牌新增；web 测试 409 通过 / 32 跳过。

## 3. 流水线与持久化

- [x] 3.1 `apps/jobs/src/selection`：`selection-daily-v1`（04:00 SGT，once），读取观测值 → 归并 → 信号 → 风险 → 打分 → 线索，按 簇 × 日期 幂等。验证：真实 PG 集成测试（模拟连接器数据），重复运行不产生重复线索。 证据：`apps/jobs/src/selection/node.ts`（`registerNodeSelection`，在 `node/runtime.ts` 于 `registerNodeDataSources` 之后挂载），组合与持久化在新包 `packages/follow`（`pipeline.ts`、`settings.ts`、`mapping.ts`），市场数据批量读取加在 `packages/marketdata/src/series.ts`（`findProducts`、`readMetricSeries`、`keywordIds`）；`apps/jobs/test/selection-schedule.unit.test.ts`「每天 04:00 新加坡时间运行，错过补跑一次…」；`packages/follow/test/pipeline.test.ts`（真实 PG，直接写 marketplace_product 与 observation）「归并、信号、风险与线索写入；第二次运行不产生重复」「锁定成员不被自动归并合回；新版本设置只用于之后的线索」「停用方向不生成新线索」；`packages/follow/test/mapping.test.ts`「维度名与顺序一致」「硬门槛键一致」「等级一一对应」「db 默认设置换算后与 selection 默认设置相同（毛利底线 1500bp = 0.15）」；follow 8/8、jobs 151 通过 / 2 跳过、jobs 单元 77 通过。
- [x] 3.2 评分设置版本：数据中心“评分维度管理”标签与 server functions。验证：修改生成新版本、历史线索不变。 证据：`apps/web/src/features/data-center/scoring.{tsx,functions.ts,server.ts}`（权重、反向维度、否决阈值、硬门槛、毛利底线、最少维度数、版本历史，“回测命中率”列显示“—（M5 后提供）”；写权限 `assertWorkbenchWriter`），版本追加在 `packages/follow/src/settings.ts`（`appendScoringSetting`）；`apps/web/test/follow-scoring.test.ts`「首次打开显示默认版本 1…」「修改权重生成新版本，旧版本与已有线索不变」「member 与只读空间不能保存；全部权重为 0 被拒绝」；web 测试 412 通过 / 32 跳过。

## 4. 候选页面

- [x] 4.1 候选列表（`/app/$slug/follow`）：平台切换、方向筛选、排序、eBay 无 BSR、空状态。验证：组件或 e2e 测试；对照设计稿截图。 证据：`apps/web/src/features/follow/candidates{.ts,.server.ts,.functions.ts,-page.tsx}`，读市场数据用新增的 `packages/marketdata` `readMetrics`（批量）；`src/features/follow/candidates.test.ts`「eBay 不显示 BSR 列，Amazon 显示」「冷启动显示未验证；硬门槛不通过仍为不推荐」「高分低置信标“值得关注但证据不足”」「命中信号…反向维度取 100 − 分数」；集成测试 `apps/web/test/follow-candidates.test.ts`「没有线索时返回空状态所需的配置情况，不返回示例数据」「按平台筛选、按 综合分 × 置信度 排序，每个簇只取最新一天的线索」；e2e `apps/web/e2e/follow-candidates.spec.ts` 覆盖空状态、Amazon 有 BSR、切换 eBay 表头无 BSR；截图 `docs/receipts/m2-candidates-2026-10-19/01–03`。
- [x] 4.2 商品簇详情（`/app/$slug/follow/$clusterId`）：雷达、置信度、曲线、风险、来源对比、拆分/合并、人工刷新。验证：拆分合并测试；截图对照。 证据：`apps/web/src/features/follow/cluster-page.tsx`、`clusters.server.ts`（拆分 / 合并写 lead_event 与 locked，写操作 assertWorkbenchWriter；人工刷新复用数据中心 `estimateRefresh` / `refreshNow`，新增 `productRefreshOptions` 显示预计花费与额度）；集成测试「详情：缺失维度为空而不是 0；来源对比带各来源值与离散度」「拆分：成员进入新簇并锁定…」「合并：来源簇成员移入并锁定，来源簇标为 merged；同一商品不重复」「不同站点不能合并；member、只读空间与其他空间不能修改」；e2e 覆盖雷达缺失维度“无数据”、月销量悬浮来源（主值、离散度、获取时间）、人工刷新预计花费、拆分；截图 `docs/receipts/m2-candidates-2026-10-19/04–06`；web 测试 423 通过 / 32 跳过。

## 5. 验收

- [ ] 5.1 用模拟连接器数据端到端：配置方向 → 流水线 → 候选列表 → 详情能说明推荐理由与来源。验证：e2e 记录。
- [ ] 5.2 用真实数据源数据跑一次并记录回执（依赖 M1b 凭据）。

# Tasks

依赖 `add-data-source-hub` 与 `add-source-connectors` 已合并部分。所有完成勾选都须有验证证据。分组按文件不重叠拆分，可并行。

## 1. 纯函数包（packages/selection、packages/risk）

- [x] 1.1 `packages/selection`：维度映射（scales）、7 维信号、最晚决定日、综合分、硬门槛、等级、置信度（design D4–D6）。验证：每个维度的边界与缺失用例；spec 场景（否决、冷启动、高分低置信、缺失不计 0）。 证据：`packages/selection/src`（scales/signals/deadline/score/confidence）；`test/scales.test.ts` 映射边界，`test/signals.test.ts` 7 个维度的计算、边界与缺失为空（eBay 无已售观测、无落地成本等），`test/deadline.test.ts`「返校季 … → 5/18」，`test/score.test.ts`「一票否决：综合分 82 但合规 20」「冷启动：显示“未验证”…」「缺失维度不按 0 计」「少于 4 个维度不给综合分」，`test/confidence.test.ts`「高分低置信」「只有单一来源的指标标“未交叉验证”」；`check:deps` 通过。
- [x] 1.2 `packages/selection` 的归并：标题规范化、Jaccard、GTIN/平台 ID 合并、锁定成员不被覆盖（design D3）。验证：spec 场景用例。 证据：`packages/selection/src/cluster.ts`；`test/cluster.test.ts`「GTIN 相同归为一簇…0.95」「标题相似 0.7 但类目不同不归并」「平台 ID 相同即同一商品」「拆分后次日自动归并不会把成员合回原簇」「合并两个簇」。
- [ ] 1.3 `packages/risk`：品牌库、VeRO、品牌备案、受限类目、认证、禁运、外观专利提示（Google Patents 链接）。验证：spec 场景用例；`check:deps` 通过。

## 2. 数据表与配置页面

- [ ] 2.1 `packages/db/src/schema/selection.ts`：design D2 的全部表与迁移，预置美国节点与默认评分设置（种子迁移）。验证：迁移由 migrator 执行；`scoped()` 跨空间隔离测试。
- [ ] 2.2 选品方向与店铺池页面（`/app/$slug/follow/directions`）与 server functions：增删改、停用、店铺推荐接受/拒绝。验证：写入权限（owner/admin、可写空间）测试；e2e 或组件测试。
- [ ] 2.3 设置页（`/app/$slug/config`）：节点日历、品牌库、风险规则标签页。验证：增删改测试。

## 3. 流水线与持久化

- [ ] 3.1 `apps/jobs/src/selection`：`selection-daily-v1`（04:00 SGT，once），读取观测值 → 归并 → 信号 → 风险 → 打分 → 线索，按 簇 × 日期 幂等。验证：真实 PG 集成测试（模拟连接器数据），重复运行不产生重复线索。
- [ ] 3.2 评分设置版本：数据中心“评分维度管理”标签与 server functions。验证：修改生成新版本、历史线索不变。

## 4. 候选页面

- [ ] 4.1 候选列表（`/app/$slug/follow`）：平台切换、方向筛选、排序、eBay 无 BSR、空状态。验证：组件或 e2e 测试；对照设计稿截图。
- [ ] 4.2 商品簇详情（`/app/$slug/follow/$clusterId`）：雷达、置信度、曲线、风险、来源对比、拆分/合并、人工刷新。验证：拆分合并测试；截图对照。

## 5. 验收

- [ ] 5.1 用模拟连接器数据端到端：配置方向 → 流水线 → 候选列表 → 详情能说明推荐理由与来源。验证：e2e 记录。
- [ ] 5.2 用真实数据源数据跑一次并记录回执（依赖 M1b 凭据）。

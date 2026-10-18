# Tasks

依赖 `add-follow-selection`（线索、评分设置）。所有完成勾选都须有验证证据。

## 1. 纯函数

- [x] 1.1 `packages/selection` 增加：命中判定（含数据不足、季节高峰误差）、Wilson 下界、准备度等级、样本加权、L2 逻辑回归与 5 折交叉验证（design D2、D3、D5）。验证：spec 场景用例；回归在可分数据上收敛的测试。 证据：新增 `src/labels.ts`、`src/readiness.ts`、`src/fit.ts`，置信度接入“历史命中率”项；`test/labels.test.ts`（命中 45 件/跌 8%、10/30 天数据不足、季节误差、到期判断）、`test/readiness.test.ts`（Wilson 已知值、19 → 20 样本进入观察期并显示等级且置信度上限为中、无样本历史命中率为空）、`test/fit.test.ts`（可分数据收敛且交叉验证 AUC > 0.9、有效样本 < 50 拒绝拟合）；`pnpm --filter @product-res/selection test` 82 passed，`pnpm typecheck`、`pnpm check`、`pnpm check:deps` 通过。

## 2. 数据表与流水线

- [x] 2.1 `recommendation`、`recommendation_label`、`readiness_stat`、`weight_suggestion` 表与迁移。验证：隔离测试。 证据：迁移 0018_costing_insight_validation.sql 已在本地库应用；packages/db/test/validation.test.ts 覆盖四表隔离、线索 × 冻结日与推荐 × 窗口唯一、窗口取值约束。
- [x] 2.2 冻结影子推荐（接入 `selection-daily-v1` 末尾）与 `selection-label-v1`（05:00 SGT）打标签、每周准备度重算。验证：冻结记录不随重算变化；到期打标签幂等。 证据：`packages/follow/src/pipeline.ts` 在写线索的同一事务末尾冻结 shadow 推荐（onConflictDoNothing，主导维度来自新增的 `dominantDimension`），`src/validation.ts` 提供 `runSelectionLabels`（eBay 累计已售差分、Amazon 日销量或月销量估算 ÷ 30，来源写入 sources）、`recomputeReadiness` 与同方向随机新品基线（只在内存计算，不写推荐表）；`apps/jobs/src/selection/node.ts` 注册 `selection-label-v1`（05:00）与 `selection-readiness-v1`（周一 05:30）。`test/pipeline.test.ts` 改权重同日重算后冻结记录不变；`test/validation.test.ts` T+14 未命中 / T+30 命中（45 件、跌 8%）、数据不足、重复运行不新增、基线样本不入表；`apps/jobs/test/selection-schedule.unit.test.ts` 三个计划。
- [x] 2.3 准备度驱动 M2 等级显示与置信度历史命中率项。验证：19 → 20 样本时等级出现的测试。 证据：流水线按 站点 × 方向 × 信号类型 读取最新 readiness_stat 决定等级显示，并把有效样本与 Wilson 下界传入置信度历史命中率项；`test/validation.test.ts` 有效样本 19 时线索仍显示“未验证”、历史命中率为空，20 时准备度为观察期、显示等级、置信度不为高且历史命中率 = 下界。

## 3. 回放与拟合

- [x] 3.1 Keepa 历史回放任务（遵守额度，样本标注 replay）。验证：额度不足顺延测试；用 Keepa 历史夹具回放并打标签。 证据：`packages/follow/src/replay.ts` 的 `startReplay` / `runReplayStep`（按 ASIN 预估 token，经 runSyncTask 预扣，额度不足返回 deferred，无凭据失败并记 KEEPA_API_KEY_MISSING），`apps/jobs/src/selection/replay.ts` 队列消费者按额度重置时刻延迟重投；Keepa 连接器新增 monthlySoldHistory → sales_estimate_monthly。`test/replay.test.ts`（真实 PG 账本）本分钟额度占满时顺延且未发请求，下一分钟取历史、冻结 1 条 replay 推荐并打 14/30/60 三个命中标签，重复投递不再请求；`apps/jobs/test/selection-replay.unit.test.ts` 顺延 / 确认 / 死信。
- [x] 3.2 权重拟合建议与采用/忽略。验证：采用生成新版本、忽略不变。 证据：`packages/follow/src/weights.ts` 的 `proposeWeights` / `acceptSuggestion`（复用 appendScoringSetting）/ `dismissSuggestion`；`test/validation.test.ts` 有效样本 30 返回原因、70 条可分样本给出需求权重最高的建议，采用生成版本 2 且建议记 acceptedVersion，忽略后版本仍为 2、重复处理 409。`pnpm typecheck`、`pnpm check`、`pnpm check:deps`、`pnpm check:singletons` 通过；follow 17、selection 84、connectors 16、marketdata 16、jobs test:node 81 passed。

## 4. 页面

- [x] 4.1 `/app/$slug/validation`：准备度矩阵、命中率曲线、样本构成、待打标签数、权重建议、回放入口；数据中心评分维度管理显示回测命中率。验证：冷启动空状态；截图对照。 证据：`apps/web/src/features/validation/`（validation.functions.ts / validation.server.ts 只读调用 getValidationOverview，写操作经 assertWorkbenchWriter；Keepa 回放经新增的可选 `WebRuntime.selectionReplayQueue`，Node 入口用 `createNodeQueueProducer(db, SELECTION_REPLAY_QUEUE)` 装配，未装配时页面停用“发起回放”并说明），数据中心评分维度“回测命中率”列显示 bySignalType 命中率与 Wilson 下界、无样本显示“无样本”；`apps/web/test/validation-page.test.ts`（真实 PG：冷启动、样本 30 返回“少于拟合下限 50”且不写库、采用生成版本 2、忽略版本不变、重复处理 409、member/只读 403、准备度矩阵与按月命中率、回放 REPLAY_INVALID_DATE / INVALID_OFFSET / TOO_RECENT / NOT_AMAZON / NO_PRODUCTS / QUEUE_UNAVAILABLE、预估 2 商品 2 token 后排队）5 passed；`src/features/validation/validation-page.test.tsx` 冷启动空状态（说明样本数与天数、只渲染图表空容器）3 passed；`e2e/validation.spec.ts` 通过，截图 `docs/receipts/m5-validation-2026-10-19/`（01 冷启动、02 有样本、03 曲线悬停、04 数据中心回测命中率）；`pnpm typecheck`、`pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm dedupe --check` 通过，web unit 294、node 16 passed。

## 5. 验收

- [x] 5.1 用夹具数据跑通 冻结 → 到期打标签 → 准备度流转 的集成测试。 证据：`packages/follow/test/shadow-acceptance.test.ts`（真实 PG，样本全部由流水线冻结，用推进的 asOf / today 参数）：20 天每日冻结 shadow 推荐且重跑不变 → D+14 只有 14 天窗口到期（未命中）→ D+48 前 19 条 T+30 命中、重复运行幂等 → 准备度 19 样本冷启动、线索“未验证” → 推进一天第 20 条到期，准备度进入观察期，线索显示等级、置信度不为高、历史命中率 = Wilson 下界；3 passed；回执 `docs/receipts/m5-acceptance-2026-10-19.md`。
- [ ] 5.2 用真实 Keepa 凭据回放一个历史节点并记录回执（依赖凭据）。

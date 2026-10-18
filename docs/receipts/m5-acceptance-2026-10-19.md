# 验收回执：M5 影子验证流转（add-shadow-validation 5.1）

- 日期：2026-10-19（本机 Orca worktree，真实 PG 隔离库 `product_res_wt_agent_a67447abfc689ddf9`）
- 用例：`packages/follow/test/shadow-acceptance.test.ts`（夹具数据直接写入 `marketplace_product` 与 `observation`）
- 时间：不等待真实时间，用推进的 `asOf`（流水线计算日）与 `today`（打标签 / 准备度计算日）参数

## 命令

```bash
PRODUCT_RES_PG_CONTAINER=saas-template-pg bash scripts/orca/setup.sh
pnpm --filter @product-res/db db:migrate
pnpm --filter @product-res/follow exec vitest run test/shadow-acceptance.test.ts
pnpm --filter @product-res/follow test   # 全部 6 个文件 24 项
```

结果：`3 passed`；follow 全部 `24 passed`。库里同时存在 e2e 遗留空间（启用方向、商品）时同样通过。

## 步骤与结果

| # | 步骤（日期参数） | 结果 |
|---|---|---|
| 1 | 每日流水线 `runSelectionForWorkspace`，asOf = D … D+19（D = 2033-03-01） | 冻结 20 条 shadow 推荐，信号类型一致；同日重跑冻结值（ID、分数、权重版本）不变；线索冷启动显示“未验证” |
| 2 | `labelDueRecommendations` today = D+14 | 只有 D 的 14 天窗口到期：1 条标签，未命中（增量 28 件 < 30） |
| 3 | today = D+48（最后冻结日 + 29） | 前 19 条的 T+30 到期，均命中（增量 60 件，价格稳定）；重复运行新增 0 条 |
| 4 | `recomputeReadiness` today = D+48；流水线 asOf = D+48 | 有效样本 19、命中 19，准备度冷启动；线索仍显示“未验证” |
| 5 | 推进一天 today = D+49：打标签 → 准备度 | 第 20 条到期；有效样本 20、shadow 20、命中 20，准备度“观察期”，Wilson 下界 > 0.8 |
| 6 | 流水线 asOf = D+49 | 线索准备度“观察期”，显示等级（不再是“未验证”），置信度不为高（观察期上限为中），历史命中率 = Wilson 下界 |

## 未覆盖

- 真实 Keepa 历史回放（5.2，依赖凭据）。
- 基线命中率：本用例方向内只有 1 个商品，基线样本不足 5 个时为空（与 blockers D4a 一致），所以停在观察期。

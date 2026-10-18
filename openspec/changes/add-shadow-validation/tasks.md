# Tasks

依赖 `add-follow-selection`（线索、评分设置）。所有完成勾选都须有验证证据。

## 1. 纯函数

- [x] 1.1 `packages/selection` 增加：命中判定（含数据不足、季节高峰误差）、Wilson 下界、准备度等级、样本加权、L2 逻辑回归与 5 折交叉验证（design D2、D3、D5）。验证：spec 场景用例；回归在可分数据上收敛的测试。 证据：新增 `src/labels.ts`、`src/readiness.ts`、`src/fit.ts`，置信度接入“历史命中率”项；`test/labels.test.ts`（命中 45 件/跌 8%、10/30 天数据不足、季节误差、到期判断）、`test/readiness.test.ts`（Wilson 已知值、19 → 20 样本进入观察期并显示等级且置信度上限为中、无样本历史命中率为空）、`test/fit.test.ts`（可分数据收敛且交叉验证 AUC > 0.9、有效样本 < 50 拒绝拟合）；`pnpm --filter @product-res/selection test` 82 passed，`pnpm typecheck`、`pnpm check`、`pnpm check:deps` 通过。

## 2. 数据表与流水线

- [x] 2.1 `recommendation`、`recommendation_label`、`readiness_stat`、`weight_suggestion` 表与迁移。验证：隔离测试。 证据：迁移 0018_costing_insight_validation.sql 已在本地库应用；packages/db/test/validation.test.ts 覆盖四表隔离、线索 × 冻结日与推荐 × 窗口唯一、窗口取值约束。
- [ ] 2.2 冻结影子推荐（接入 `selection-daily-v1` 末尾）与 `selection-label-v1`（05:00 SGT）打标签、每周准备度重算。验证：冻结记录不随重算变化；到期打标签幂等。
- [ ] 2.3 准备度驱动 M2 等级显示与置信度历史命中率项。验证：19 → 20 样本时等级出现的测试。

## 3. 回放与拟合

- [ ] 3.1 Keepa 历史回放任务（遵守额度，样本标注 replay）。验证：额度不足顺延测试；用 Keepa 历史夹具回放并打标签。
- [ ] 3.2 权重拟合建议与采用/忽略。验证：采用生成新版本、忽略不变。

## 4. 页面

- [ ] 4.1 `/app/$slug/validation`：准备度矩阵、命中率曲线、样本构成、待打标签数、权重建议、回放入口；数据中心评分维度管理显示回测命中率。验证：冷启动空状态；截图对照。

## 5. 验收

- [ ] 5.1 用夹具数据跑通 冻结 → 到期打标签 → 准备度流转 的集成测试。
- [ ] 5.2 用真实 Keepa 凭据回放一个历史节点并记录回执（依赖凭据）。

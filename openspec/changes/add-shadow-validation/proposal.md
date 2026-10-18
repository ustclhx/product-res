# Proposal

## Why

推荐是否靠谱只能用结果验证。eBay 没有可用的历史销量，只能从上线第一天起冻结“影子推荐”并在 T+14 / T+30 / T+60 自动打标签积累样本；Amazon 可以用 Keepa 的价格、BSR、卖家数历史回放过去节点前的信号，上线即可做历史回测。积累的样本用于计算命中率、算法准备度（冷启动 → 观察期 → 可用 → 可信）、置信度中的“历史命中率”，以及给出权重拟合建议。

## What Changes

- 影子推荐：每日流水线把每条线索的分数、输入引用和权重版本冻结为推荐记录，不受之后重算影响。
- 自动打标签：T+14 / T+30 / T+60 到期时按命中标准（T+30 簇销量增量 ≥ X 件且竞品中位价跌幅 ≤ Y%，季节类另看高峰周误差 ≤ 2 周）打标签；X、Y、窗口可配置；Amazon 销量用估算主值并记录来源。
- Keepa 历史回放：对选定节点，用节点前的 Keepa 历史重建当时的信号与分数，按之后的 BSR/销量估算打标签；回放样本单独标注，权重低于影子推荐。
- 准备度：按 平台 × 方向 × 信号类型 统计样本数与命中率（Wilson 下界）对比基线，计算等级并驱动 M2 的等级显示。
- 置信度加入“历史命中率”。
- 权重拟合建议：样本足够后用逻辑回归（L2 正则）拟合维度权重，给出建议与对比，由团队确认后生成新的评分设置版本。
- 算法验证页面：命中率曲线、准备度等级、样本构成（影子 / 回放 / 导入）、权重建议；数据中心评分维度管理旁显示回测命中率。

## Capabilities

### New Capabilities

- `shadow-recommendations`：推荐冻结、到期打标签、命中标准配置。
- `algorithm-readiness`：样本统计、Wilson 下界、基线、准备度等级、历史命中率置信度。
- `algorithm-validation`：Keepa 历史回放、权重拟合建议、算法验证页面。

### Modified Capabilities

- `selection-scoring`：等级显示由准备度驱动；置信度加入历史命中率。

## Impact

- `packages/selection` 增加标签判定、Wilson、准备度、逻辑回归（纯函数）。
- 新增空间级表 `recommendation`、`recommendation_label`、`readiness_stat`、`weight_suggestion`。
- `apps/jobs`：每日打标签步骤（05:00 SGT）、每周重算准备度、按需回放任务（遵守 Keepa 额度）。
- `apps/web`：`/app/$slug/validation` 页面。
- Keepa 回放依赖 Keepa 凭据与额度；Terapeak 导入样本保持 hold。

// 长文阅读器预览的中性示例正文（季度经营报告），与设计稿 Reader.dc.html 的示例一致；数值为占位
const ZH = `## 1. 摘要

本季度整体收入保持增长，但新客增长放缓。引导流程改版后留存改善明显；模型调用成本占比上升，是下季度需要优先处理的问题。

- 新客增长低于预期，主要受渠道 B 投放收缩影响。
- 次月留存提升，改版后的引导流程贡献最大。
- 长文本请求占比提高，推高了单次调用成本。

## 2. 关键指标

### 2.1 新客增长

下表对比两个季度的核心指标。数值为模板示例，衍生项目接入真实数据源后替换。

| 指标 | Q2 | Q3 | 变化 |
| --- | ---: | ---: | ---: |
| 新增注册 | [数值] | [数值] | −6% |
| 付费转化率 | [数值] | [数值] | +0.4 pt |
| 次月留存 | [数值] | [数值] | +5 pt |

> 渠道 B 的投放在 8 月暂停了三周，新客缺口基本集中在这段时间。

### 2.2 留存

1. 首次登录后的引导从 5 步减为 3 步。
2. 新增「每日领取」积分，提高了第二周的回访。

## 3. 成本结构

模型调用成本占比上升，主要来自长文本请求。下面是本季度按模型统计的调用占比（导出自 \`usage_by_model\`）：

\`\`\`json
{
  "通用模型": 0.58,
  "长文本模型": 0.31,
  "图像模型": 0.11
}
\`\`\`

建议对超过阈值的长文本先做摘要，再进入问答；高峰时段的备用模型切换需要单独设置预算。详见[用量页](/dev/ui#data-table)与[外部参考](https://product.ezarouter.cc/cost-guide)。原始导出[^src]：https://product.ezarouter.cc/exports/2026-q3/usage_by_model_including_fallback_models_and_long_context_requests.csv

## 4. 下季度计划

- 恢复渠道 B 投放，并为其单独设置转化目标。
- 上线长文本摘要，目标是把单次调用成本降低三成。

[^src]: 导出时间为季度结束后第一个工作日，数值为示例。
`

const EN = `## 1. Summary

Revenue kept growing this quarter, but new-user growth slowed. Retention improved noticeably after the onboarding redesign; the rising share of model costs is the top issue for next quarter.

- New-user growth missed the target, mainly because channel B spend was cut.
- Second-month retention rose, driven mostly by the new onboarding flow.
- Long-text requests grew as a share of traffic, raising the cost per call.

## 2. Key metrics

### 2.1 New users

The table compares core metrics across two quarters. Values are template placeholders; derived projects replace them with real data.

| Metric | Q2 | Q3 | Change |
| --- | ---: | ---: | ---: |
| Sign-ups | [value] | [value] | −6% |
| Paid conversion | [value] | [value] | +0.4 pt |
| Month-2 retention | [value] | [value] | +5 pt |

> Channel B spend paused for three weeks in August; most of the new-user gap falls in that window.

### 2.2 Retention

1. Onboarding after first sign-in went from 5 steps to 3.
2. A new daily credit claim raised week-two return visits.

## 3. Cost structure

Model costs grew as a share of spend, mostly from long-text requests. Share of calls by model this quarter (exported from \`usage_by_model\`):

\`\`\`json
{
  "general": 0.58,
  "long-context": 0.31,
  "image": 0.11
}
\`\`\`

Summarize long inputs above the threshold before Q&A, and give peak-hour fallback models their own budget. See the [usage page](/dev/ui#data-table) and an [external reference](https://product.ezarouter.cc/cost-guide). Raw export[^src]: https://product.ezarouter.cc/exports/2026-q3/usage_by_model_including_fallback_models_and_long_context_requests.csv

## 4. Next quarter

- Resume channel B spend with its own conversion target.
- Ship long-text summaries, aiming to cut cost per call by 30%.

[^src]: Exported on the first business day after quarter end; values are samples.
`

export function sampleReport(locale: string): string {
  return locale.startsWith('zh') ? ZH : EN
}

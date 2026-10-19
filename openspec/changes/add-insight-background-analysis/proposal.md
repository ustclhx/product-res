# Proposal

## Why

品类洞察（M4，`add-category-insight`）在生成 / 刷新快照的 Server Function 里同步等待 AI 差评痛点分析：
`startWorkspaceChat` 的文本流读完、结算完成后才返回。生产经 Cloudflare Tunnel 接入，边缘读超时约 100 秒，
模型生成较慢时浏览器收到 524，而服务端仍在运行并计费，用户看不到结果，重试还会再调用一次。

## What Changes

- 生成 / 刷新只同步计算非 AI 模块（只读观测值，耗时短），快照立即写入，差评痛点主题与差异化建议记为“分析中”，请求马上返回。
- AI 分析在请求之外执行：同一模型选择（空间权益允许的第一个启用文本模型）、同一计费链路（`startWorkspaceChat` 预扣 → 结算）、
  同一“输入不变沿用上次结果”规则；完成后把主题、建议与引用评论写回同一份快照，失败写入带机器可读 code 的错误状态。
- 同一研究同一输入指纹的分析在途时，重复点击或重试刷新返回那份快照，不新增快照、不再次调用、不重复计费。
- “分析中”超过期限（模型流截止 10 分钟 + 2 分钟写回余量）仍未完成时按失败（`ANALYSIS_EXPIRED`）显示，可重新刷新。
- 报告页在“分析中”时显示状态并每 4 秒重新加载，完成或过期后停止。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `category-insight`：AI 差异化建议改为后台分析，新增“分析中”状态、在途去重与过期规则（该能力由 `add-category-insight` 引入，尚未归档，因此以 ADDED 需求表达）。

## Impact

- `apps/web/src/features/category/`：`snapshot.server.ts`（AI 步骤改为返回待执行分析）、`category.server.ts`（写入快照、在途去重、提交后启动后台分析、读取时处理过期）、
  新增 `analysis.server.ts`（后台执行、结果映射、写回、过期判断）、`ai-runtime.server.ts` / `category.functions.ts`（装配 BackgroundTasks）、`report-page.tsx`（分析中与轮询）、`types.ts`。
- 不新增数据表与迁移：状态保存在 `category_study_snapshot.modules` JSON 中；并发去重用事务级咨询锁。
- 不新增队列或部署配置。

# Tasks

## 1. 后台分析

- [x] 1.1 快照 AI 步骤改为返回待执行分析，快照以“分析中”写入；新增 `analysis.server.ts`（后台执行、结果映射与机器码、写回、过期判断）；入口用 BackgroundTasks 执行（design D1、D2）。验证：集成测试“生成立即返回、后台完成后写回”“失败写成机器可读的 code”。 证据：`apps/web/test/category-insight.test.ts`「后台分析」4 例与原有 7 例在本地 PG 通过。
- [x] 1.2 在途去重：按研究加事务级咨询锁，同指纹在途分析直接返回原快照；沿用规则改为最近一份 AI 成功的快照（design D3）。验证：集成测试“分析在途时重复刷新返回同一份快照，不重复调用”。 证据：并发两次刷新返回同一快照 ID、AI 调用 1 次、快照数 1；“输入不变沿用不重复调用”仍通过。
- [x] 1.3 过期：读取时把超过 12 分钟的“分析中”显示为 ANALYSIS_EXPIRED，刷新时不算在途（design D4）。验证：集成测试“超时显示 ANALYSIS_EXPIRED，可重新刷新”，单元测试 `analysis.test.ts`。 证据：两者均通过（含迟到结果写回原快照）。

## 2. 页面

- [x] 2.1 报告页“分析中”状态与轮询（design D5）。验证：e2e `category-insight.spec.ts`“后台 AI 分析中显示‘分析中’，完成后页面自动更新”。 证据：e2e 通过（不刷新页面，写回后 20 秒内显示建议），截图 `docs/receipts/insight-background-2026-10-19/07-analysis-running.png`；`category-acceptance.spec.ts` 与原有报告 e2e 仍通过。

## 3. 验收（协调者）

- [ ] 3.1 部署后在生产经 Tunnel 用真实模型生成一份有差评的报告：请求不再 524，完成后页面自动显示结果，AI 对话列表只有一条记录。

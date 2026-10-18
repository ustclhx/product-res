# Staging 验收证据：2026-10-12 至 2026-10-13

最终 run 为 `acceptance-2026-10-13j`，staging 完整版本为
`e6936068fb375ba6ed59533124e7da89060ec377`：**13 项通过、0 失败、1 项人工跳过**。
验收循环已结束；自动项通过不代表 OpenSpec 阶段验收全部完成。

这里保存两个 UTC 日期目录的全部 151 份原始 JSON（10 + 141），按文件名保留每个 run。
[凭据复扫与 SHA-256 清单](credential-review.json)记录提交前的检查、原文件与提交版本校验值。
7 份 JSON 仅按 Biome 调整数组排版，全部 151 份解析后数据与原始证据一致，主 checkout 的原文件未变。
JSON 中的 `evidenceCommitted: false`、阻塞、推断及待授权状态是当时快照，其值完整保留；
不会用后续结论改写历史失败证据。后续根因修复来自协调者交接及已合并 PR，原证据未保留的异常不据此补写。

## 各 run 结论

通过 / 失败 / 跳过是当次 Playwright 结果；失败后未运行的后续项也计入跳过。

| Run（链接至执行状态） | 通过 / 失败 / 跳过 | 结论 |
|---|---|---|
| [acceptance-2026-10-12](2026-10-12/acceptance-2026-10-12-execution-status.json) | 2 / 1 / 11 | Workers 图片失败；后续修复参数 `num_steps` → `steps`（#136）。 |
| [acceptance-2026-10-13](2026-10-13/acceptance-2026-10-13-execution-status.json) | 3 / 1 / 10 | 先因 fal 模型停用卡在配置检查（1 / 1 / 12），启用后 Workers 图片通过、fal 提交不确定而全退。 |
| [acceptance-2026-10-13b](2026-10-13/acceptance-2026-10-13b-execution-status.json) | 3 / 1 / 10 | fal 提交不确定；后续协调者定位 fetch 接收者错误（#142）。 |
| [acceptance-2026-10-13c](2026-10-13/acceptance-2026-10-13c-execution-status.json) | 3 / 1 / 10 | fal 提交仍不确定；后续协调者定位 workerd 不支持 `redirect:error`（#143）。 |
| [acceptance-2026-10-13d](2026-10-13/acceptance-2026-10-13d-execution-status.json) | 0 / 1 / 13 | 首次 `/login` 导航失败；未生成任务或发起付费调用。原异常未保留。 |
| [acceptance-2026-10-13e](2026-10-13/acceptance-2026-10-13e-execution-status.json) | 4 / 1 / 9 | Workers/fal 图片通过；视频取消误记 `MEDIA_CANCEL_PENDING`（#147）。 |
| [acceptance-2026-10-13f](2026-10-13/acceptance-2026-10-13f-execution-status.json) | 2 / 1 / 11 | Workers 推理失败、预扣全退；后续协调者判断为 8007 NSFW 间歇误判（#148、#149）。原绑定异常未保留。 |
| [acceptance-2026-10-13g](2026-10-13/acceptance-2026-10-13g-execution-status.json) | 1 / 1 / 12 | 媒体配置只读查询失败；后续查询成功，无生成任务。冷启动原因属协调者判断（#150）。 |
| [acceptance-2026-10-13h](2026-10-13/acceptance-2026-10-13h-execution-status.json) | 6 / 1 / 7 | 媒体与 token 正常对话通过；停止场景在点击 Stop 前的首个输出断言失败（#151）。 |
| [acceptance-2026-10-13i](2026-10-13/acceptance-2026-10-13i-execution-status.json) | 11 / 1 / 2 | 媒体与六项 Chat 通过；Admin 解封后审计只读查询 connect 失败（#155）。解封已生效。 |
| [acceptance-2026-10-13j](2026-10-13/acceptance-2026-10-13j-execution-status.json) | 13 / 0 / 1 | 全部自动项通过；固定跳过 Workers 故障注入，Sentry 仅证明测试入口行为。 |

2026-10-14 受控故障套件（`fault.config.ts`，独立入口）：

| Run | 场景 | 结论 |
|---|---|---|
| [fault-2026-10-14a](2026-10-14/fault-2026-10-14a-execution-status.json) | 11 | 10 通过；chat-mid-stream-per_call 未触发注入（deepseek-flash 思考耗尽上限，#165、#166）。fal 5 次、DeepSeek 2 次真实调用，共 8 积分，对账零差额。[Sentry 去重核验](2026-10-14/fault-2026-10-14a-sentry-dedupe.json)发现非最终尝试失败仅有引擎包装帧（#164）。 |
| [fault-2026-10-14b](2026-10-14/fault-2026-10-14b-execution-status.json) | 2 | chat-mid-stream-per_call 与 workers-error 通过；workers-error 的 Sentry 事件映射到我方 TypeScript、无引擎帧（[核验](2026-10-14/fault-2026-10-14b-sentry-verification.json)）。 |

2026-10-14 回归与补充核验：

| Run / 核验 | 结论 |
|---|---|
| [acceptance-2026-10-14a](2026-10-14/acceptance-2026-10-14a-execution-status.json) | 2 / 1 / 11：Workers 上游 8007 被记为 MEDIA_GENERATION_FAILED，未进入换任务重试（CF step 丢失 NonRetryableError code，#178 修复）。 |
| [acceptance-2026-10-14b](2026-10-14/acceptance-2026-10-14b-execution-status.json) | 13 / 0 / 1（SHA 70496c6）：全部常规项通过；本轮无 8007。消息 parts 无 reasoning；checkpoint 记录 reasoningTokens，但未声明能力的 DeepSeek 模型仍按上游默认开启思考（后续修复）。 |
| [acceptance-2026-10-14c](2026-10-14/acceptance-2026-10-14c-execution-status.json) | 2 / 0 / 0（SHA a3973cf，仅 chat 正常回复）：#183 后未声明能力的 DeepSeek 模型按模板默认关闭思考，reasoningTokens 由 55/52 降为 0，parts 无 reasoning（[对比](2026-10-14/acceptance-2026-10-14c-reasoning-comparison.json)）。 |
| [admin 次日指标](2026-10-14/admin-metrics-next-day.json) | 看板截至 2026-10-14 00:00 UTC，10-13 汇总与原始数据 25/25 项一致。 |

另保留 [13 的早期表单阻塞记录](2026-10-12/acceptance-2026-10-13-execution-status.json)：
当时 Save Changes 未接管输入，未运行套件；#137 后保存 Workers schema，随后核对并恢复误停用的专用 fal 模型。
fal 13 / 13b / 13c 的控制台只读核对均未在对应时间窗观察到受理请求；
核对限于已登录账号的模型范围，月度 Usage 不能独立证明分钟级计费，staging 密钥所属账号未另行比较。

`Failure diagnostic`：13e–13h 为 `unclassified`；13i 为
`Read-only evidence query failed (connect)`；13j 无此行、无失败生成任务。
13d 及更早 run 尚未具备 #145 的诊断输出，不能补造原始异常。

## 13j 通过范围与积分对账

[最终执行状态](2026-10-13/acceptance-2026-10-13j-execution-status.json)列出逐项结果与 30 份证据文件；
[最终只读核对](2026-10-13/acceptance-2026-10-13j-final-readonly-verification.json)保存数据库快照。

- 五个验收模型均启用，完整配置与夹具一致；文本及媒体配置两项通过。
- Workers 图片成功、fal 图片成功且可访问；各消费一次，分别扣 1 / 2 积分。
- fal 视频提交后立即取消，释放预扣 3 积分、消费 0；本场景不证明视频成功产出。
- 按 token / 按次各执行正常、主动停止、生成中关页，共六项 Chat 通过。
- Admin 专用用户搜索、封禁/解封、模拟登录/退出、补发 25 积分、公告修改/恢复通过，均有审计 ID；最终已解封、已退出模拟，公告恢复。
- Sentry 测试入口返回预期 HTTP 500 与 request ID；2026-10-14 在指定项目[核验](2026-10-13/acceptance-2026-10-13j-sentry-verification.json) web 与 jobs 事件的 release、dist 及 TypeScript 可读源码堆栈。

| Chat 场景 | token 积分 / 状态 | 按次积分 / 状态 |
|---|---|---|
| 正常 | 1 / completed | 2 / completed |
| 停止（无输出） | 1 / aborted | 0 / aborted，预扣全释 |
| 关页 | 3 / completed，尾部 4489ms | 2 / completed，尾部 3178ms |

普通空间准备补足 12 积分，本 run 生成与对话共消费 12 积分；最终账本与可用批次余额均为 18。
管理员专用空间补发 25 积分只生效一次，最终账本与可用批次余额均为 25。
两空间的 held、debt、对账差额均为 0。
对账使用同一快照：`ledger = active remaining + held - debt`；失败与取消释放预扣，不强求额外 refund 分录。

## OpenSpec 核对与剩余人工验收

observability 1.2 于 2026-10-14 补齐 Sentry 实际事件核验后勾选；其余任务保留未勾选，并在 tasks.md 写入证据与未覆盖范围。

| Change / 任务 | 已有真实证据 | 仍待完成（完整任务保持未勾选） |
|---|---|---|
| [media 7.2](../../../../openspec/changes/archive/2026-10-15-add-ai-media-generation/tasks.md)（7.1 于 2026-10-14、7.2 于 2026-10-15 勾选，change 已归档） | Workers/fal 图片成功、取消全退；fal 五类受控故障（fault-2026-10-14a）；fal 视频成功产出（[media-video-2026-10-15a](2026-10-15/media-video-2026-10-15a-execution-status.json)） | 无 |
| [chat 5.1](../../../../openspec/changes/archive/2026-10-15-add-ai-text-chat/tasks.md)（2026-10-15 勾选，change 已归档） | 两种计费各正常/停止/关页，流水与不变式通过；服务商报错由 fault-2026-10-14a/b 覆盖；[chat-51-2026-10-15a](2026-10-15/chat-51-2026-10-15a-execution-status.json) 经 AI Gateway 比对，四条可关联消息输入/输出 token 差异均为 0% | 无；两个停止场景在首个输出前中止、Gateway 无日志，按 runbook 记为无法比对 |
| [admin 6.1](../../../../openspec/changes/archive/2026-10-15-add-admin-console/tasks.md) | 专用用户动作、积分幂等、设置恢复及审计 | 指定测试支付资源的失败回调重放与退款审核（未执行）；次日指标已于 2026-10-14 核验通过 |

故障注入按 [验收 runbook](../../staging-acceptance.md)执行；历史意外失败不代替受控注入。
退款与支付回调重放仍需针对具体测试资源的授权。此次只整理证据，没有补跑付费调用、注入故障或执行支付动作。

## 已合并修复

- #136：Workers FLUX 夹具参数改为 `steps`；#137：后台模型表单接管与保存。
- #142：fal fetch 接收者错误；#143：workerd 不支持的 redirect 模式，及 JWKS / R2 转存 / 运营告警调用。
- #145：脱敏 Failure diagnostic；#147：Workflow 终态取消竞态。
- #148：Workers 安全错误摘要及 transient 重试；#149：8007 时先对账再换新任务、有界重试。
- #150：只读证据查询连接重试与脱敏类别；#151：首个输出前停止及对应计费、停止/关页操作时机。
- #153：DeepSeek direct 流式输出；#155：复用 Node Postgres 只读连接及有界连接重试。

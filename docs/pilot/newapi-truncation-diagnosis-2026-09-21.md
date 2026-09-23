# DeepSeek 输出截断定位

日期：2026-09-21。本文保留当次诊断记录。后续用户已授权输出上限提高十倍，线上现为 18000；见 [最新测试预算及用量](token-budget-2026-09-21.md)。下文恢复至 1800 描述的是诊断结束时的历史状态。

## 结论

本次根因是应用部署配置的输出预算偏低：ECS 的 `max_output_tokens=1800` 被代码直接发为 `max_tokens=1800`。原调用输出恰好 1800 tokens，并被应用识别为上游长度终止。相同输入、模型、提示词和结构校验下，仅临时提高输出上限到 4000，调用成功，实际输出 1898 tokens。

这是应用输出预算与内容需求不匹配。现有证据不支持 DeepSeek 服务故障、NewAPI 渠道改写参数或本地字符串裁切。截断保护逻辑本身正确，不能通过放宽 JSON 校验或强行补括号修复。

## 实验记录

| 项目 | 原调用 | 对照调用 |
|---|---|---|
| Job | `55a9a786-72ce-4395-b123-1dd35bfbe075` | `0c8b98ea-9bd9-468b-85df-ef1aa2f8565d` |
| 模型 | deepseek-v4-flash | 同左 |
| thinking | disabled | 同左 |
| 输入 tokens | 4062 | 4062 |
| 输出上限 | 1800 | 4000 |
| 实际输出 tokens | 1800 | 1898 |
| 结果 | NEWAPI.OUTPUT_TRUNCATED | SUCCEEDED，通过 JSON、schema 和引用 ID 校验 |
| 输入哈希 | `2071724b34683f7000ea5db2ba55c5c2a710354bbadaf8709aba2f06b045af92` | 同左 |

原调用数据来自 NewAPI 只读日志 id 9432，时间 2026-09-21 11:25:41 UTC；渠道 id 1，名称“官方”，model_mapping、param_override 均为空。对照通过正常业务 API 提交，计入既有请求额度，没有绕过限额。对照草稿为 PENDING_REVIEW，未代替人工批准。

仅新增一次真实诊断请求。对照结束后将配置逐字节恢复为原文件；当前生产上限仍是 1800，故本轮完成定位而未宣称永久修复。失败原始响应正文没有留存，无法比对两个响应是否具有相同前缀；归因依据为原日志用量、唯一错误触发分支、同输入哈希及上限单变量对照。

## 代码定位

- `app/pilot/services.py:247`：读取部署 `max_output_tokens`；仓库示例为 2500，但 ECS 当前显式设置 1800，因此默认值不生效。
- `app/providers/newapi.py:468`：直接设置请求 `max_tokens`；没有在此处裁切文本。
- `app/providers/newapi.py:525`：只有首个 choice 的 `finish_reason=length` 才产生本次错误；发生在 JSON/schema 校验之前。
- `app/providers/newapi.py:191` 与 `:442`：清单条数、字符串长度及提示词没有输出篇幅限制；只是要求完整结构，内容增长后可能超过固定预算。
- `app/providers/newapi.py:482`：先解析完成内容，再读取 usage；截断抛错会跳过 usage 保存，导致失败任务缺少 token 数等诊断元数据。本次需回查 NewAPI 日志，这是可观测性缺口，不是截断的直接原因。

DeepSeek 官方文档说明，长度结束可能由输出预算或上下文限制触发；JSON 模式也需要足够输出预算。本例仅增加输出额度即成功，且输入未变，证据支持输出预算解释。[API 结束原因](https://api-docs.deepseek.com/api/create-chat-completion/)、[JSON 输出要求](https://api-docs.deepseek.com/guides/json_mode/)。

## 本地验证

- `./.venv/bin/pytest -q tests/test_newapi.py`：20 passed。
- `PYTHONPATH=. ./.venv/bin/python /private/tmp/newapi_truncation_diagnostic.py`：四个真实 adapter + 假 transport 场景通过。length → OUTPUT_TRUNCATED；相同残缺内容换 stop → INVALID_RESPONSE；合法 JSON 不符合 schema → OUTPUT_INVALID；完整合法清单 → SUCCESS。后两类不会误报为本次截断。
- 额外 deadline/socket 测试因沙箱禁止本地 bind 在断言前失败，不用于本次结论。

## 建议修复

1. 将试点输出预算统一为经过此案例验证的 4000，同时保留总输入/输出预算及请求额度；不要认为 4000 能覆盖任意规模输入。
2. 给各节点设清晰的摘要、列表条数和单条长度约束，避免清单重复复述全部证据；保留关键缺口和原证据引用。
3. 在失败记录中保存白名单诊断元数据：模型、请求输出上限、finish_reason、usage、request_id 和耗时，不保存凭据或完整敏感提示。
4. 以本案例作为回归：大于 1800 的完整结果应可保存为待审阅草稿；真实 length 仍须失败，不能截断后冒充完整结果。自动重试若后续加入，须有次数及预算边界。

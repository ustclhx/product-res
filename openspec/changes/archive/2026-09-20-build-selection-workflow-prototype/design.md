## Context

动机见 [proposal.md](proposal.md)。初始化已有 React/TS/Vite、Query、Router、FastAPI、严格 UTC 契约以及从 d2market 迁移的纯执行状态/错误规则；检查通过，尚无业务持久化、业务 API 或真实 provider。

范围依据为仓库根 `PRODUCT.md`。本设计跨 API、数据模型和业务页面，故必须提供设计文档。现有用户意见确认了产品方向，但没有真实团队工作流或效率基线；示例模板只是待验证假设。

## Goals / Non-Goals

**Goals:**

- 一个本地服务即可重复演示两种候选入口、补证、人审、验证和结果反馈，刷新及服务重启保留操作。
- 业务规则由后端确定性服务执行，前端呈现下一步；数据与模拟 AI 通过稳定接口供给。
- 版本、证据、幂等和冲突处理从第一版具备，便于后续接入真实数据而不推翻对象模型。

**Non-Goals:**

- 不安装 d2market 全量 Runtime、PostgreSQL/pgvector、任务队列、Scheduler、浏览器采集或连接器。
- 不把原型参与人切换当作身份认证，不开放公网，不实现多租户安全隔离。
- 不要求随机大模型输出，不把样例结果或操作间隔变成业务价值证明。

## Decisions

### 1. 模块化单体与 SQLite 持久化

使用现有 FastAPI，同步短事务经 repository 接口访问标准库 SQLite，默认 `.local/product-res/demo.sqlite3`。避免原型新增数据库服务；不采用仅浏览器 localStorage，因为跨页、重启和命令幂等需要统一事实来源。首次启动仅创建空库和 schema，显式初始化/重置命令写入确定性样例。

设置外键、事务和唯一约束；写命令在一个事务中完成版本检查、业务数据、审计和幂等结果写入。schema_version 和顺序 SQL 迁移放在 `app/persistence/migrations/`。数据库文件路径来自服务端配置，客户端不能指定任意路径。数据库/缓存不进入版本控制。

目录及职责：

| 路径 | 职责 |
| --- | --- |
| `app/selection/` | 项目、标准、候选、评估和决策的契约/规则/服务 |
| `app/evidence/` | 证据版本、来源、质量与初筛规则 |
| `app/validation/` | 补证/验证任务与验证结论 |
| `app/outcomes/` | 结果导入、可比口径、复盘及规则建议 |
| `app/providers/` | 数据发现、AI 节点接口和示例实现 |
| `app/persistence/` | SQLite repository、迁移、幂等记录 |
| `app/api/routes/` | 请求/响应与应用服务调用，不内嵌业务规则 |
| `fixtures/demo/` | 固定时间、版本、正反案例、CSV 示例 |
| `web/src/features/{projects,candidates,evidence,evaluations,reviews,tasks,outcomes}/` | 按业务组织的页面、表单和查询 |
| `tests/{unit,contract,integration}/`、`web/e2e/` | 规则、契约、持久化、浏览器验收 |

### 2. 固定业务流程，技术执行状态与商品状态分开

主对象是 SelectionProject 与 Candidate。项目显示按阶段统计的候选，不把整个项目强制压成单一串行状态；同一项目中不同候选可处于不同阶段。

Candidate 业务状态如下，`screening_status` 单独为 `UNCHECKED / PASS / NEEDS_EVIDENCE / EXCLUDED / OVERRIDDEN`：

| 当前状态 | 事件及前置条件 | 下一状态 |
| --- | --- | --- |
| PREPARING / RETURNED | 分析人提交；标准已确认，必填证据有效，初筛非阻塞，当前评估有效 | IN_REVIEW |
| IN_REVIEW | 决策负责人批准当前提交并说明理由 | VALIDATING |
| IN_REVIEW | 退回并明确补证问题 | RETURNED |
| IN_REVIEW | 观察 / 否决并说明理由 | WATCHING / REJECTED |
| IN_REVIEW | 必填证据/当前标准变化或失效，提交被系统标记失效 | RETURNED |
| WATCHING / REJECTED | 决策负责人带原因重新打开 | PREPARING |
| VALIDATING | 决策负责人确认结束验证（继续经营或停止） | OUTCOME_PENDING |
| OUTCOME_PENDING | 结果或未开展经营记录齐备，负责人确认复盘 | REVIEWED |

“继续验证”保持 VALIDATING，可以新增任务。全部任务完成只产生待决策待办。硬排除保留业务状态，阻止提交；人工恢复产生 OVERRIDDEN，并不绕过其他必填证据或直接批准。

系统使提交失效时保存独立的 SubmissionInvalidated 事件和需补项目，不冒充人的退回决定；重新评估后走同一提交入口。仅到期未发生写操作时，在查询显示待刷新并在下一次写命令中原子完成失效处理。

已批准/已复盘候选不重写批准版本；若准备新一轮验证，首版以新项目候选关联前次候选，避免复杂重新审批状态。原获批候选的经营结果跟进与当前证据更新并行：发现新反证可提示负责人，但不悄悄改历史决定。

已迁移 `runtime/state.py` 只用于一次模拟节点执行的 PENDING/RUNNING/FAILED 等状态；无需构造完整 DAG 引擎。业务步骤用明确命令实现，节点 AI 无权调用人审命令。

### 3. 最小实体与不可变快照

| 实体 | 关键字段/约束 |
| --- | --- |
| Project | id、channel、market、direction、goal、analyst_id、decision_owner_id、current_criteria_revision_id、version |
| CriteriaRevision | template_id/version、rules、required_evidence、confirmed_by/at、parent_revision；确认后不可覆盖 |
| Candidate | project_id、external_identity、title、business_status、screening_status、version；跨项目身份分开 |
| CandidateSource | entry_kind、provider/source_ref、external_id/url、collected_at、is_demo；重复来源可追溯 |
| EvidenceRevision | candidate_id、field/claim、value/unit/currency/window、source_locator、observed_at、recorded_at、valid_until、epistemic_kind、verification、supersedes_id、is_demo |
| ScreeningResult | rule_version、evidence_revision_ids、PASS/NEEDS_EVIDENCE/EXCLUDED、逐规则理由、override_event_id |
| EvaluationRevision | 五维结构、证据引用、unknowns/counterevidence/assumptions、预测口径、标准/AI/input_hash、created_by/at |
| Submission / DecisionEvent | candidate_id、evaluation_revision_id、expected_version、actor、action、reason、created_at；事件追加 |
| Task | candidate_id、approval_ref（补证任务可无）、type、question、owner、due_at、completion_criteria、state、result/evidence_refs |
| OutcomeObligation / OutcomeRevision | approval_ref、due/window、candidate/SKU映射、metrics、basis、status、is_demo、source/import_ref；批准时创建义务 |
| FeedbackProposal | outcome_revision_ids、before/after、scope、reason、status、confirmed_by/at、new_criteria_revision_id |
| AuditEvent / EffortEntry | actor、action、object、time、version；工时独立录入 minutes/category/is_demo，不按事件间隔推定 |
| CommandReceipt | workspace + actor + command + idempotency_key 唯一、payload_hash、response |

UTC 时间沿用现有契约，显示为本地时区。金额用 Decimal 计算、JSON 字符串及显式币种保存，不用二进制浮点判断硬阈值。null 表示未知，0 仅表示明确观测或假设值；字段分类另存。

`is_demo` 与事实/估算/假设、核验状态是不同轴：样例中“已核验事实”只是演示的事实，仍显示“示例”。来源为人工录入也需记录人、时间和原文件行号/备注定位。

### 4. 规则与三个渠道模板

规则采用受限的 `field + operator + threshold + unit + eligibility`，只支持数值/枚举白名单运算，不执行配置代码。先检查适用性、核验、单位、时效和冲突，再计算通过/失败；任何质量缺口产生 NEEDS_EVIDENCE。多规则聚合：有有效硬失败则 EXCLUDED，同时保留其他缺口；无失败但有必填缺口则 NEEDS_EVIDENCE，否则 PASS。例外恢复按失败规则逐项保存，新增失败规则或输入/标准变化使例外需要重新确认。

| 模板 | 示例证据 | 成本口径重点 | 首版来源 |
| --- | --- | --- | --- |
| Amazon | 站点、ASIN、需求估算、评论、竞争、报价 | 采购、平台、FBA/自发货、广告、退货 | 示例市场/评论/报价文件 + 人工/CSV |
| eBay | 站点、item/产品标识、成交/刊登示例、运费、报价 | 平台费、跨境物流、广告、退款 | 同一 provider 接口的 eBay 样例 |
| 独立站 | 场景、广告/店铺线索、流量假设、转化、报价 | 支付、履约、获客、退款 | 示例广告/流量线索 + 人工/CSV |

不调用真实平台；不把 ASIN、销量估算或 Amazon 成本字段设为跨渠道强制项。示例硬规则可用 MOQ 上限和已核验采购成本，预估销量/获客成本只用于敏感性及缺口提示。阈值标明演示值，用户确认后对该项目生效。

### 5. 数据入口和 AI provider 保持可替换

`MarketDataProvider.discover(request)` 输出候选、来源定位、时间和覆盖状态。`NodeAssistant.run(node_kind, input_snapshot)` 输出摘要、结构化维度、引用、unknowns、建议、provider/model/prompt/schema 版本及 `is_simulated=true`。仅实现 fixture provider；注入固定时钟以免样例因当前日期变化突然过期。

节点类型限定为补证清单、评估整理和偏差复盘。先验证输入和引用，再保存输出；失败显示可重试或人工整理，不默认推进候选。模拟执行有执行记录，复用已迁移错误分类；不引入队列、SSE 或后台轮询系统。

CSV 两步为 preview -> confirm，预览返回内容摘要、行号、映射、有效/无效/重复分类。确认对同一内容摘要校验；限制 UTF-8 CSV、2MB、1000 行，超限明确提示。导入仅解析数据，不访问链接，不执行公式；无 XLSX 支持。重复键优先项目+渠道+市场+平台 ID，其次规范化来源 URL；相似名称仅提示，保留来源追加记录。结果 CSV 必须用户确认候选及批准轮次映射。

### 6. API 命令、角色与并发约束

保留 `/api/v1/health`。其余按资源查询和显式命令划分：

| 端点族 | 核心操作 |
| --- | --- |
| `/demo` | 参与人列表、当前样例版本、初始化、确认重置 |
| `/projects`、`/{id}/criteria-revisions` | 草稿、确认标准、渠道模板 |
| `/projects/{id}/discovery`、`/candidate-imports` | 示例发现、预览/确认导入 |
| `/candidates/{id}/evidence`、`/screenings`、`/screening-overrides` | 补证、初筛、带原因恢复 |
| `/candidates/{id}/evaluations`、`/submissions`、`/decisions`、`/reopen` | 整理、提交、人审、重开 |
| `/tasks`、`/tasks/{id}/transitions`、`/candidates/{id}/validation-conclusions` | 任务与验证结论 |
| `/outcome-imports`、`/candidates/{id}/outcomes`、`/reviews` | 结果回填及复盘 |
| `/feedback-proposals`、`/{id}/confirm`、`/{id}/reject` | 新规则建议与确认/拒绝 |
| `/workbench`、`/activity`、`/effort-entries` | 待办、历史、试用工时 |

原型 actor_id 来自服务端预置参与人表，演示角色切换不能隐式改变项目的负责人。服务端检查命令所需角色和项目分工；这是演示控制，不是身份安全。禁止默默以管理员权限执行。

每项写命令要求 Idempotency-Key 和 expected_version（创建根对象不需要旧版本）。同键同 payload 返回原结果；同键异 payload 为 409 IDEMPOTENCY_CONFLICT；旧版本为 409 VERSION_CONFLICT；材料未准备好为 422 EVIDENCE_REQUIRED，角色不符 403 ROLE_NOT_ALLOWED。统一 `{error_code,message,retryable,details}`，前端提示缺口或刷新；自动重试不得生成新的业务键。

提交/批准事务内重新验证必填证据有效期和输入摘要，防止页面缓存绕过前置条件。Evidence、Criteria、Evaluation 和 Outcome 的已用版本只追加，不覆盖。重置操作需确认当前样例版本；唯一作用域是当前 demo 工作区数据，禁止传客户端文件路径。

### 7. 复盘口径和下一轮规则

批准时冻结预期指标、窗口、币种和假设；未提供的预测保留未知。结果记录必须分清销售总额与净收入，退款只扣一次。示例单位贡献利润为 `(销售总额 - 退款 - 采购 - 平台 - 履约 - 广告 - 其他已声明变动成本) / 已声明销量基数`；所有组成项、单位和窗口齐备且基数大于零才计算。若导入净收入需声明已扣退款并避免再次扣除；不包含固定开支，故不得称净利润。

比较必须共享窗口、币种和口径；首版不自动汇率转换，不把不同累计窗口同比。未上市可结案，但记录停止原因/验证成本而非填充零销售。拒绝候选仍留在候选池历史，避免只保留成功案例；不假装存在反事实经营结果。

复盘建议形成独立 FeedbackProposal，确认后复制成下一轮 CriteriaRevision。新项目可选择应用，当前项目及历史不自动变更。新规则是管理者确认的经验假设，不声称因果证明或模型学习效果。

### 8. 业务交互与验收顺序

工作台优先待补证/待决策/逾期/待结果；项目页为候选列表和阶段过滤；候选页采用阶段进度、核心结论、证据侧栏和固定下一步动作；任务页按负责人和到期日处理；复盘从候选和项目进入，不新增聊天主入口。

沿用视觉 token 和中文字体，业务页面不呈现 provider、JSON、DAG、Prompt 等实现术语；详细诊断可折叠。错误表述为“缺采购报价，无法初筛”等业务原因。前端类型以 OpenAPI 契约生成或进行自动漂移检查，不能独立维护第二套枚举。

分四个可演示增量：①项目+双入口+补证初筛；②评估+退回重提+批准；③验证任务+结果回填；④复盘+下一轮标准+全链路验收。各增量保持所有三渠道模板可跑，避免到末尾才发现 Amazon 字段污染独立站流程。

## Risks / Trade-offs

- [模板不是客户验证结果] → UI 标为示例，保留试用记录；原型完成后访谈再调整。
- [SQLite 与角色切换不适合公开多团队服务] → 默认回环地址，真实试点部署前独立设计认证、租户和备份；不在本变更伪装完成。
- [模拟 AI 掩盖真实输出波动] → 保留无效引用、失败、无覆盖 fixtures，后续真实 provider 必须另做评估。
- [简单导入无法覆盖复杂 ERP 字段] → 限定 CSV 模板和显式映射，保存被跳过行；不声称现成连接器。
- [标准或证据变化使旧审批失效] → 提交和批准时双重校验，保留快照和冲突提示。
- [任务完成被误读为选品成功] → 分离任务状态、验证结论和经营结果覆盖。
- [数据回流被误读为自动学习] → 规则建议须人确认，示例指标不进入实际成效统计。

## Migration Plan

1. 当前仅初始化骨架，无历史业务数据库；新增 schema 迁移和 fixture 版本，不读取 d2market 的库或运行数据。
2. 在独立临时数据库执行初始化、双入口回放、重启恢复和重置测试，再运行浏览器关键链路。
3. 本地升级前备份 demo 数据文件并记录 schema 版本；不兼容版本停止启动而非隐式删除数据。
4. 回滚需恢复相匹配的代码与备份数据库；用户也可明确确认重置当前示例工作区。源代码和 research 不属于重置对象。

## Open Questions

- 原型之后与共创团队核对具体字段叫法、默认模板阈值、来源授权和可回填指标；首版采用本文明确的演示值和手工模板，不依赖这些答案才能开发。
- 实际人工工时基线、持续回填意愿及可接受数据费用需实测。本变更只收集观察记录，不设置未经验证的效果指标。

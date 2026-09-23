# 第一版验收映射

每项 Requirement 对应下表。Python 为业务与故障自动验收；浏览器验收另见 `web/e2e/` 和 `docs/implementation/browser-findings.md`。执行结果记录在下方；浏览器准备数据的 API 调用不算作界面覆盖。

| Capability / Requirement | 自动验收证据（tests/） | 界面验收位置 |
| --- | --- | --- |
| selection-projects / Channel-specific project setup | test_project_intake: channel_templates / draft_without_owners | 项目创建、三渠道模板 |
| Confirmed and immutable criteria versions | test_project_intake: new_criteria_invalidates / confirmed_feedback_criteria | 项目标准与版本比较 |
| Demonstrated role responsibilities | test_project_intake: criteria_role；test_evidence_review: approval_retry | 全局角色与确认/批准按钮 |
| candidate-intake / Two candidate entry paths | integration/test_workflow_acceptance: three_channels_two_entry_paths；test_project_intake: discovery_requires_selection | 发现与 CSV 入口 |
| Import preview and validation | test_project_intake: csv_preview_confirm / csv_size_limit | 列映射、错误行、显式选择 |
| Scoped duplicate detection | test_project_intake: csv_preview_confirm_explicit_skip_and_scoped_duplicate | 来源与复用候选 |
| evidence-screening / Traceable evidence and data quality | test_evidence_review: revision_heads_conflicts_and_override_invalidation | 当前/历史证据 |
| Deterministic screening on eligible inputs | test_evidence_review: evidence_screening_and_reasoned_override_api | 逐项硬规则结果 |
| Human restoration without rewriting results | 同上；integration: screening_quality_unknown_override | 带理由的恢复 |
| Supplemental evidence ownership | test_lifecycle: evidence_task_cannot_be_completed_by_checking_box | 补证待办与结果 |
| candidate-evaluation / Multidimensional evaluation snapshot | integration: screening_quality_unknown_override；test_evidence_review | 五维、未知、反证、预测口径 |
| Bounded simulated AI assistance | test_evidence_review: assistant_rejects_foreign_citation；test_foundation: durable_failure | 模拟标记、草稿人工检查 |
| Submission readiness and frozen versions | test_evidence_review: stale_submission；integration: stale_approval | 提交、输入变化失效 |
| review-decisions / Four explicit human decisions | test_evidence_review: approval_retry；integration: return_supplement | 批准/退回/观察/否决 |
| Decision history and reopening | test_evidence_review: approval_retry_creates_one_decision_and_obligation_then_reopen_flow | 决策时间线和重开 |
| Safe retries and conflict handling | test_foundation: command_receipt / concurrent_stale / durable_failure；web commandKeys.test | 冲突提示、刷新与重试 |
| validation-tasks / Actionable validation plan | test_lifecycle: validation_task_requires_approval | 询价/样品/小测表单 |
| Task progress and result checks | 同上；integration: return_supplement_resubmit_approve_validation_and_stop | 受阻、取消、未达目标 |
| Explicit validation conclusion and outcome handoff | 同上 | 负责人继续/跟进/停止 |
| outcome-feedback / Linked outcome intake | test_lifecycle: csv_preview / csv_confirm；integration: outcome_comparison | 手工、CSV、批准定位 |
| Comparable forecast and actual review | test_lifecycle: finance_missing_is_not_zero_and_net_does_not_double_refunds | 差异、未知、不可比原因 |
| Human-approved learning record | test_lifecycle: feedback_creates_future_criteria；test_project_intake: confirmed_feedback_criteria | 建议、确认/拒绝、下轮项目 |
| Outcome coverage without fabricated success | test_lifecycle: finalize_waits_for_observation_window_end；test_demo | 未上市、缺失、已回填分计 |
| prototype-experience / Business-first navigation and states | test_demo；web/e2e | 工作台队列、窄屏与键盘 |
| Persistent and clearly marked demonstration | test_foundation: store_restarts；test_demo；integration: demo_init_reset | 显式初始化、重置与样例标记 |
| Deterministic end-to-end acceptance | integration/test_workflow_acceptance；web/e2e | 三渠道×双入口和主要分支 |
| Honest value-validation preparation | test_demo | 工时、意见与待验证提示；walkthrough.md |

## 验收记录

- `make check`：通过：Ruff、mypy（34 个文件）、45 项 Python 测试、前端 lint/TypeScript 构建、2 项请求键测试和契约漂移检查。
- `openspec validate build-selection-workflow-prototype --strict`：通过。
- Supervisor 使用内置浏览器验证显式初始化、工作台四队列、待审阅直达决策、带理由批准和任务入口；1200×850 与 390×844 布局检查后收敛标题、表格滚动和留白。键盘 Enter 打开项目表单、Tab 到项目名称、空表单提交聚焦首个必填项均经实际浏览器确认。
- Impeccable detector 一轮扫描仅报告任务/结果引用区的粗彩边；已改为普通细边，未作无关设计扩展。
- `npm run test:e2e`：2 项浏览器测试通过（29.9 秒）。包含三渠道×双入口六组合、三种任务创建/受阻/回填、退回补证重评再批准、人工恢复、观察重开，以及反馈确认后创建下一轮项目。重复初始证据/评估通过 API 准备；完整 UI/API 边界见 browser-findings.md。
- 27 项 Requirement 已逐项映射；本地原型范围内没有未解决的验收项。真实数据接入、生产权限与团队价值验证不在本次完成声明中。

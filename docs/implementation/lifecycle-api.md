# Lifecycle API contract

All paths below are mounted under `/api/v1`. Every write accepts `actor_id` and
optional `expected_version` in its JSON body and requires `Idempotency-Key`.
Times are explicit-offset ISO-8601 values and responses use UTC.

## Validation tasks

- `GET /tasks?candidate_id=&owner_id=&state=&overdue=` returns `{items}`. Each item includes
  the canonical task fields plus derived `overdue`.
- `POST /candidates/{candidate_id}/tasks` creates an `EVIDENCE`, `QUOTE`,
  `SAMPLE`, or `TEST` task. Body: `type`, `question`, `owner_id`, `due_at`,
  `completion_criteria`, optional `expected_metrics`, and optional `field`.
  `QUOTE`/`SAMPLE`/`TEST` require an approved candidate and freeze its
  `approval_id`; `EVIDENCE` is independent of approval and requires `field`.
- `POST /tasks/{task_id}/transitions` accepts `state`, optional `result`,
  `evidence_ids`, `target_met`, and `reason`. Completion requires a result and
  candidate-scoped evidence. Completing an `EVIDENCE` task additionally
  requires current, verified evidence for the task field. Blocking,
  cancellation, and a missed target require a reason.
- `POST /candidates/{candidate_id}/validation-conclusions` accepts `action`
  (`CONTINUE`, `FOLLOW_UP`, `STOP`) and `reason`. Only the project's decision
  owner may conclude. `CONTINUE` keeps `VALIDATING`; the other actions move to
  `OUTCOME_PENDING` while retaining the approval and outcome obligation.

## Outcome intake and review

- `POST /candidates/{candidate_id}/outcomes` records one immutable outcome.
  `RECORDED` requires window, currency, units, revenue basis, and metric fields;
  `NOT_LAUNCHED` requires a reason and rejects fabricated units/metrics.
- `POST /outcome-imports/preview` accepts `{csv_text}` (plus command fields) and
  returns `content_hash`, parsed row classifications, explicit mappings, and
  duplicate/invalid reasons. UTF-8 content is limited to 2 MiB and 1,000 data
  rows. Candidate/SKU plus approval must resolve uniquely.
- `POST /outcome-imports/confirm` accepts the same `csv_text`, its
  `content_hash`, `selected_rows`, and optional row `mappings`. It reparses and
  revalidates the content before writing, and skips/reports deterministic
  duplicates.
- `GET /outcomes/{outcome_id}/comparison` returns the immutable approval and
  evaluation references, per-field comparisons, basis comparability, and a
  separate contribution-completeness result. Available fields remain comparable
  when another cost is missing; contribution profit per unit requires every
  Decimal component, positive unit basis, window, currency, and revenue basis.
  NET revenue never deducts refunds a second time.
- `POST /outcomes/{outcome_id}/reviews` records deviation reasons and a
  deterministic simulated assistant explanation linked to that outcome and its
  original approval/evaluation.
- `POST /outcomes/{outcome_id}/feedback-proposals` creates a `PROPOSED`
  feedback item with `before_rules`, `after_rules`, and `reason`.
- `POST /feedback-proposals/{feedback_id}/confirm` and `/reject` are restricted
  to the original project's decision owner. Confirmation creates an immutable
  criteria revision for future project selection and records `new_criteria_id`;
  it does not change the original project's `current_criteria_id`. Rejection
  requires a reason.
- `POST /candidates/{candidate_id}/finalize-review` moves `OUTCOME_PENDING` to
  `REVIEWED` only when the outcome is explicitly `NOT_LAUNCHED`, or a recorded
  outcome's observation window has ended, its review is complete, and every
  feedback proposal is decided. Results may be entered while a window is open.

Domain errors use the shared `{error_code,message,retryable,details}` envelope.

同一来源和窗口重复提交时，金额、单位、口径、样例标记等必须与原结果一致；内容冲突返回 OUTCOME_SOURCE_CONFLICT（409），不会静默丢弃修订数据。修订需明确新的来源版本。

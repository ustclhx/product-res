# Candidate workflow UI

The candidate page consumes the aggregate `GET /api/v1/candidates/{id}` response described in `integration-contract.md`. It is intentionally split into three visible stages so business users work on one decision surface at a time.

## Route and integration

- Page component: `web/src/features/candidates/CandidatePage.tsx`
- Expected route: `/candidates/:id`
- Supplemental-task link: `/tasks?candidate_id={id}`
- Outcome link: `/candidates/{id}/outcomes`
- Every write sends the aggregate candidate's current `version` as `expected_version`. A conflict is shown as a refresh-required error; the UI never retries a stale decision with a new version automatically.
- Writes use the shared `command()` client and the actor selected through `useWorkspace()`. The page reloads the aggregate after each successful command.

## Stage 1: evidence and screening

The evidence stage distinguishes current and superseded revisions, while keeping direct anchors for evaluation citations. It shows field, value, unit, currency, window, source locator, observation/expiry times, epistemic kind, verification status, supersession, and the independent demo marker. Null remains unknown. Conflicts, expiry, estimates, assumptions, and unverified values are visible business warnings.

The screening table uses `screening.rule_results`, links each result back to evidence, and displays the criteria/input snapshot. Users can rerun screening, record a reasoned owner override, or create an `EVIDENCE` task with field, owner, due date, question, and completion criteria. The copy explicitly states that task completion does not clear a gap without new valid evidence and another screening run.

## Stage 2: evaluation

The evaluation stage renders demand, competition, differentiation, supply/cost, and risk in business language. Evidence references jump to evidence anchors. Unknowns and counterevidence remain first-class lists. Forecast currency, UTC window start/end, gross/net revenue basis, units, and nullable metrics are edited separately so missing values cannot be interpreted as zero.

`EVALUATION_ORGANIZER` produces a deterministic, visibly simulated assistant run. Its output may be copied into the manual draft, but a person must check and save it. Saving creates a new immutable evaluation and includes `parent_revision_id` when revising an existing snapshot.

## Stage 3: submission and decision

The analyst submits the current evaluation. The decision owner selects APPROVE, RETURN, WATCH, or REJECT and must give a reason; RETURN also requires one or more questions. Returned questions are shown before other controls with links back to evidence. WATCHING and REJECTED candidates can be reopened with a reason.

The decision timeline renders submissions, invalidations, decisions, and reopen events without overwriting history. Approval copy is explicit that the system creates an outcome obligation only and performs no external commercial action.

## Styling and accessibility

The page uses shared shell classes (`panel`, `page-heading`, `toolbar`, `form-grid`, `field`, `primary`, `secondary`, `badge`, `data-table`, `notice`, `error`, `empty`, `split-view`, `stack`, `muted`, `timeline`). Stage controls are an accessible tablist, forms use native labels and fieldsets, and errors use `role="alert"`. Detailed forms sit behind native `details` controls to keep the active stage concise.

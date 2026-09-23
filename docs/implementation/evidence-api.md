# Evidence, evaluation, and review API

All routes below are mounted below `/api/v1`. Write routes require an
`Idempotency-Key` header and include `actor_id` plus the current candidate
`expected_version`. Responses use snake_case. Domain failures use the shared
`{error_code,message,retryable,details}` envelope.

## Evidence and screening

`POST /candidates/{candidate_id}/evidence`

Adds an immutable evidence revision. The body is:

```json
{
  "actor_id": "contributor",
  "expected_version": 1,
  "field": "moq",
  "value": "500",
  "unit": "units",
  "currency": null,
  "window": null,
  "source_locator": "quote.csv:2",
  "observed_at": "2026-09-20T07:00:00Z",
  "valid_until": "2026-10-20T07:00:00Z",
  "epistemic_kind": "FACT",
  "verification": "VERIFIED",
  "supersedes_id": null,
  "is_demo": true
}
```

`supersedes_id`, when present, must name evidence for the same candidate and
field. Independent observations remain current; differing current observations
are a conflict and are never silently resolved by recency. `value: null`
remains missing and is never converted to zero.

`POST /candidates/{candidate_id}/screenings`

Body: `actor_id`, `expected_version`. The route evaluates the project's current
confirmed criteria. It returns `{screening, candidate}`. `screening` contains
`criteria_id`, deterministic `input_hash`, current `evidence_ids`, per-rule
results, `missing_fields`, and aggregate `status`. Per-rule statuses are
`PASS`, `FAIL`, or `NEEDS_EVIDENCE`; aggregate status is `PASS`,
`NEEDS_EVIDENCE`, `EXCLUDED`, or `OVERRIDDEN`.

`POST /candidates/{candidate_id}/screening-overrides`

Body: `actor_id`, `expected_version`, non-blank `reason`, and optional
`rule_keys`. Only the project's decision owner may override. Omitted
`rule_keys` means every currently failed rule. An override is tied to the
screening `input_hash`, `criteria_id`, and individual `rule_key`; it restores
only those failures. Missing, expired, estimated, assumed, unverified, or
conflicting inputs remain `NEEDS_EVIDENCE`.

Supplemental evidence task creation and lifecycle are owned by the validation
task API. Its EVIDENCE task payload needs a `field` matching a screening
`missing_fields` entry. Completing that task does not alter screening; a new
valid evidence revision and screening run are still required.

## Evaluations and simulated assistant nodes

`POST /candidates/{candidate_id}/assistant-runs`

Runs one deterministic simulated node. Body fields are `actor_id`,
`expected_version`, `node_kind` (`EVIDENCE_CHECKLIST`, `EVALUATION_ORGANIZER`,
or `OUTCOME_REVIEW`), and optional `fixture` (`default`, `invalid_reference`,
or `invalid_structure`). The response is `{node_run, output}`. Outputs include
provider/model/prompt/schema versions and `is_simulated: true`; no node can
approve, reopen, submit, or perform external work. Invalid or foreign evidence
citations persist a failed technical node attempt and return an error without
creating an evaluation or changing candidate business state.

`POST /candidates/{candidate_id}/evaluations`

Creates an immutable five-dimension snapshot. The body includes `actor_id`,
`expected_version`, `dimensions` with exactly `demand`, `competition`,
`differentiation`, `supply_cost`, and `risk`; `evidence_ids`, `unknowns`,
`counterevidence`, `assumptions`, `forecast`, and `assistant_versions`.
`forecast` preserves nullable basis fields (`currency`, `window_start`,
`window_end`, `revenue_basis` as `GROSS` or `NET`, and `units`) separately from
nullable numeric `metrics`. Numeric values are decimal strings and must be
finite and non-negative; timestamps require offsets and an end after the start.
Missing basis remains unknown and is not treated as comparable. A manual revision may include
`parent_revision_id`; the parent must belong to the same candidate. The
response is `{evaluation, candidate, readiness}`.

## Submission and review

`POST /candidates/{candidate_id}/submissions`

Body: `actor_id`, `expected_version`, optional `evaluation_id` (defaults to the
candidate's current evaluation). Only the project analyst may submit. The
transaction reruns screening/readiness, freezes `criteria_id`, `evaluation_id`,
and `input_hash`, and changes the candidate to `IN_REVIEW`. After a human
`RETURN`, the evaluation reviewed by that decision cannot be submitted again;
the analyst must save a new immutable EvaluationRevision. The rejection returns
the original `questions` so the revision can address them. A new evidence item
is not mandatory when the question can be resolved by analysis or clarification.

`POST /candidates/{candidate_id}/decisions`

Body: `actor_id`, `expected_version`, `action` (`APPROVE`, `RETURN`, `WATCH`, or
`REJECT`), non-blank `reason`, and `questions`. Only the project decision owner
may decide. `RETURN` requires at least one non-blank question. Before any
decision the current submission hash is rechecked. If it is stale, an immutable
`submission_invalidation` event is recorded, the candidate is persisted as
`RETURNED`, and the command returns `SUBMISSION_STALE` with committed details.
An approval creates exactly one `obligation`, linked by `approval_id` to the
decision, and changes the candidate to `VALIDATING`.

`POST /candidates/{candidate_id}/reopen`

Body: `actor_id`, `expected_version`, non-blank `reason`. The decision owner may
reopen only a `WATCHING` or `REJECTED` candidate. Reopening appends a decision
event with action `REOPEN`, clears current submission/evaluation pointers used
for the new round, and returns the candidate to `PREPARING`; history is kept.

`GET /candidates/{candidate_id}/decision-timeline`

Returns `{items: [...]}` containing immutable submissions, invalidations,
decisions, and reopen events ordered by their persisted `timeline_sequence`.
The supervisor's
candidate aggregate endpoint exposes the same underlying collections.

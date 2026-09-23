# Project and candidate-intake API

All paths below are mounted below `/api/v1`. JSON names use `snake_case`. Every write command requires an `Idempotency-Key` header and includes `actor_id` plus `expected_version`; project-scoped commands use the current project version. A retry of the same action must reuse the same key.

## Projects

`GET /project-templates` returns `{ "items": ProjectTemplate[] }`. Templates contain `id`, `version`, `name`, `channel`, `description`, `fields`, `rules`, `required_evidence`, and `is_demo`. Rule thresholds are demo values. The DTC template contains no ASIN or FBA fields.

`GET /projects` returns `{ "items": Project[] }`.

`GET /projects/{project_id}` returns:

```json
{"project": {}, "criteria_versions": [], "candidates": []}
```

`POST /projects` accepts:

```json
{
  "actor_id": "analyst",
  "expected_version": null,
  "name": "北美户外露营选品",
  "channel": "AMAZON",
  "market": "US",
  "direction": "户外露营",
  "goal": "筛选可进入小批量验证的商品",
  "constraints": ["首批采购预算 5000 USD"],
  "analyst_id": "analyst",
  "decision_owner_id": "owner",
  "default_due_days": 7,
  "source_feedback_id": null
}
```

The response is `{ "project": Project, "criteria": Criteria|null }`. Owners may be omitted for a draft. A confirmed feedback proposal may be passed as `source_feedback_id`; the new project decision owner must perform the command. Its future-use criteria are cloned into the new project with the source revision as parent. The original project and criteria remain unchanged.

`POST /projects/{project_id}/updates` accepts one or more of `analyst_id`, `decision_owner_id`, or `default_due_days`, in addition to command fields. The current decision owner controls updates once assigned; a draft without a decision owner is controlled by its analyst. Response: `{ "project": Project }`.

`POST /projects/{project_id}/criteria-revisions` accepts:

```json
{
  "actor_id": "owner",
  "expected_version": 1,
  "template_id": "amazon-camping-v1",
  "template_version": "1.0.0",
  "rules": [{"field":"moq","operator":"lte","threshold":"200","unit":"unit","currency":null}],
  "required_evidence": ["moq", "procurement_cost"],
  "parent_revision_id": null
}
```

Only the project decision owner can confirm. `parent_revision_id` must equal the current criteria ID, including `null` for the first revision. Response:

```json
{"project": {}, "criteria": {}, "invalidated_submission_ids": []}
```

Confirmation creates an immutable revision. Each candidate currently in `IN_REVIEW` moves to `RETURNED`; the service appends a `submission_invalidation` system event and preserves the old submission/evaluation.

## Discovery and candidate intake

`POST /projects/{project_id}/discovery` accepts command fields plus `query`. It requires the analyst and confirmed criteria. The deterministic fixture provider recognizes `户外露营`, `露营`, `camping`, and `outdoor camping`. Response:

```json
{
  "coverage": "COVERED",
  "query": "户外露营",
  "channel": "AMAZON",
  "market": "US",
  "provider": "fixture",
  "provider_version": "camping-2026-09-20-v1",
  "is_demo": true,
  "items": []
}
```

Uncovered queries return `coverage: "NO_SAMPLE_COVERAGE"` and an empty `items` array. No network request occurs.

`POST /projects/{project_id}/discovery/candidates` accepts command fields plus the selected discovery item:

```json
{
  "actor_id": "analyst",
  "expected_version": 2,
  "selection": {
    "title": "TrailNest 轻量双人露营帐篷",
    "external_id": "B0CAMP1001",
    "source_url": "https://example.invalid/amazon/B0CAMP1001",
    "source_ref": "amazon-demo-1"
  }
}
```

The server verifies the selection against the fixture before adding it. `POST /projects/{project_id}/candidates` uses the same command fields and accepts `title`, optional `external_id`, `source_url`, and `sku` for manual intake. Both endpoints return `{ "candidate": Candidate, "source": Source, "reused": boolean }`.

Duplicate identity is scoped to a project (and therefore its channel and market), matching external ID first and normalized source URL second. A match reuses the candidate and appends a source. Titles never trigger automatic merging.

### CSV preview and confirmation

`POST /candidate-imports/preview` is a read-style POST and does not need an idempotency header. It accepts `project_id`, `.csv` `filename`, UTF-8 `content`, and optional `mapping`:

```json
{
  "project_id": "...",
  "filename": "candidates.csv",
  "content": "title,external_id,source_url,sku\n...",
  "mapping": {
    "title": "title",
    "external_id": "external_id",
    "source_url": "source_url",
    "sku": "sku"
  }
}
```

The response has `summary_hash`, resolved `mapping`, row entries (`row_number`, `status`, `values`, `errors`, duplicate/similar-title hints), `counts`, and limits. Status is `VALID`, `INVALID`, or `DUPLICATE`. Limits are 2 MiB and 1000 data rows.

`POST /candidate-imports/confirm` repeats `project_id`, `filename`, `content`, and resolved `mapping`, and adds command fields, `summary_hash`, `selected_rows`, and `skipped_rows`. Every previewed data row must appear exactly once in either list; invalid rows cannot be selected. The service recomputes the preview and rejects changed content, mapping, or duplicate state. Response:

```json
{
  "items": [],
  "sources": [],
  "created_count": 0,
  "reused_count": 0,
  "skipped_rows": []
}
```

# Demo, workbench, activity, and effort API

All paths below are relative to `/api/v1`. The application clock is fixed by
`app.state.clock`; responses serialize it as an offset-aware ISO 8601 value.
Every write requires `Idempotency-Key`. Retrying the same key and body returns
the stored response; reusing the key with another body returns
`409 IDEMPOTENCY_CONFLICT`.

## Demo workspace

`GET /demo` returns:

```json
{
  "actors": [{"id": "analyst", "name": "林晓 · 选品分析", "role": "analyst"}],
  "initialized": false,
  "has_business_data": false,
  "sample_version": "selection-workflow-demo-v1",
  "clock": "2026-09-20T08:00:00+00:00",
  "version": null
}
```

`POST /demo/init` explicitly initializes an empty database. It never runs on
startup and rejects a database containing business rows. Request:

```json
{"actor_id": "owner", "expected_version": null}
```

`POST /demo/reset` replaces only the current database's demo workspace data.
The caller must echo both the advertised sample version and current singleton
workspace version:

```json
{
  "actor_id": "owner",
  "expected_version": 1,
  "sample_version": "selection-workflow-demo-v1"
}
```

A stale version returns `409 VERSION_CONFLICT`; a different sample version
returns `409 SAMPLE_VERSION_CONFLICT`. Reset preserves the singleton workspace
row and increments its version, preventing a stale page from resetting newer
demo observations. Initialization and reset seed Amazon, eBay, and independent
store projects at different workflow stages. Every seeded entity carries
`is_demo: true`.

## Workbench

`GET /demo` also returns `has_business_data`, so a workspace created manually can use the workbench without loading sample projects.

`GET /workbench` returns four independently derived queues. Every queue item
has `candidate_id`, `title`, `reason`, and `next_action`:

```json
{
  "pending_evidence": [],
  "pending_review": [],
  "overdue": [],
  "pending_outcomes": [],
  "coverage": {
    "missing": {"count": 0, "candidate_ids": []},
    "not_launched": {"count": 0, "candidate_ids": []},
    "recorded": {"count": 0, "candidate_ids": []}
  },
  "clock": "2026-09-20T08:00:00+00:00"
}
```

Evidence items come from returned candidates, evidence screening gaps, or open
evidence tasks. Review items are submitted candidates awaiting a human
decision. Overdue items are active tasks whose deadline is before the fixed
clock. Outcome items are approved candidates in `OUTCOME_PENDING` without an
outcome. Coverage counts approved candidates as missing, explicitly not
launched, or recorded; it never treats a missing outcome as zero sales.

## Activity

`GET /activity` returns `{ "items": [...] }` in reverse chronological order.
Each item contains the stored audit fields `id`, `actor_id`, `action`,
`entity_id`, `created_at`, and `details`. Optional query parameter `entity_id`
limits the history to one entity.

## Effort entries

`GET /effort-entries` returns persisted entries and an honest validation status:

```json
{
  "items": [],
  "validation": {
    "status": "PENDING_BASELINE",
    "has_baseline": false,
    "efficiency_percentage": null,
    "message": "尚无人工流程基线，不能计算效率收益"
  }
}
```

`POST /effort-entries` request:

```json
{
  "actor_id": "analyst",
  "expected_version": 1,
  "category": "VERIFICATION",
  "minutes": 20,
  "notes": "核对供应商报价原始行",
  "is_demo": true
}
```

`category` is one of `VERIFICATION`（核验）, `EVIDENCE`（补证）,
`CORRECTION`（纠错）, or `OTHER`（其他）. `minutes` is an explicitly entered
integer from 1 to 1440; event spacing is never converted to effort. Creating an
entry increments the demo singleton version and returns `{ "item": ..., "version": n }`.
Demo entries remain labeled and are never presented as real efficiency evidence.

A manually created workspace without demo initialization can record effort with `expected_version: null`; no sample data is loaded and `initialized` remains false. In an initialized demo workspace, the singleton version remains required.

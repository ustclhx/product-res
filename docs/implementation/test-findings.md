# Integration test findings

`tests/integration/test_workflow_acceptance.py` is the executable evidence for
the backend portion of tasks 10.1 and 10.3. It drives `TestClient` through the
documented `/api/v1` HTTP contract and checks persisted state after each
mutation.

| Capability evidence | Test coverage |
| --- | --- |
| Selection projects and criteria | `project_with_criteria`; all three channels; DTC has no ASIN/FBA field; confirmed criteria are used by later commands. |
| Candidate intake | `test_three_channels_two_entry_paths_and_scoped_csv_dedup`; discovery and manual/CSV entry for Amazon, eBay, and DTC; covered and uncovered directions; preview/confirm mixed CSV rows; scoped identity deduplication. |
| Evidence and screening | `test_screening_quality_unknown_override_and_invalid_assistant_are_persisted`; missing and estimated inputs remain `NEEDS_EVIDENCE`, verified hard failure is `EXCLUDED`, owner override preserves the exception, and invalid simulated AI citations fail without changing candidate state. |
| Evaluation and review | `make_ready_candidate`; immutable five-dimension snapshots; analyst submission; stale approval returns `SUBMISSION_STALE` and persists an invalidation; return, supplement, resubmit, approve, and role enforcement. |
| Validation lifecycle | `test_return_supplement_resubmit_approve_validation_and_stop`; task completion requires a result and evidence, missed targets need a reason, and `STOP` leaves an explicit outcome-pending state. |
| Outcome and feedback | `test_outcome_comparison_feedback_csv_and_restart_reset_isolation`; missing advertising cost keeps contribution profit unknown, duplicate outcome handling, review/feedback confirmation, CSV duplicate reporting, and preservation of the original criteria revision. |
| Persistence and failure isolation | `test_outcome_comparison_feedback_csv_and_restart_reset_isolation` reopens the same SQLite file, verifies projects survive restart, and verifies a new database is empty. `test_demo_init_reset_requires_sample_version_and_isolates_workspace` covers explicit seed/reset confirmation, sample-version fencing, removal of a custom row from only the selected workspace, and a second database remaining empty. Command helpers always send an idempotency key and current `expected_version`. |

The suite is intentionally offline: fixtures use the fixed demo clock and
`example.invalid` source URLs. It does not provide proof of browser layout,
real provider behavior, customer workflow efficiency, or external API safety;
those remain manual or future validation items. Run the scoped suite with:

```sh
uv run pytest tests/integration/test_workflow_acceptance.py -q
```

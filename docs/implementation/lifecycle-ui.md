# Lifecycle UI implementation

## Tasks

`web/src/features/tasks/TasksPage.tsx` consumes `GET /tasks` with owner, state,
overdue, and candidate filters. It creates typed validation tasks through
`POST /candidates/{candidate_id}/tasks`, displays the candidate and frozen
approval reference, and sends transitions through
`POST /tasks/{task_id}/transitions`. Completing a task keeps the target result
explicit; blocked, cancelled, and missed targets retain a reason. The page also
submits the decision-owner validation conclusion to
`POST /candidates/{candidate_id}/validation-conclusions`.

## Outcomes

`web/src/features/outcomes/OutcomePage.tsx` loads the candidate aggregate and
approval snapshot from `GET /candidates/{candidate_id}`. It supports manual
outcome intake and CSV preview/confirmation, preserving blank metrics as
unknown. Recorded outcomes load `/outcomes/{outcome_id}/comparison`; review
reasons go to `/outcomes/{outcome_id}/reviews`, and proposed standard changes
go to `/outcomes/{outcome_id}/feedback-proposals`. Finalization calls
`/candidates/{candidate_id}/finalize-review` and leaves the backend as the
authority for review completeness and role checks.

Both pages use `api`, `command`, `preview`, and `useWorkspace`; route mounting
and shared shell/CSS remain owned by the supervisor.

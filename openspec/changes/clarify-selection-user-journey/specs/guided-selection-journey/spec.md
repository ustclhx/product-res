## Purpose

为已有跨境经验的团队建立清晰的选品工作入口，使成员能从新建项目进入候选收集、资料核验、人工决策及后续验证，并在工作台、项目和候选之间看到一致的下一步与负责人。

## ADDED Requirements

### Requirement: Guided project creation
The system SHALL offer a two-step project creation flow from home and project list, with business direction followed by responsibility and evidence requirements. Creation SHALL navigate to the created project and show its next permitted action without silently confirming criteria or starting a paid query.

#### Scenario: First project
- **WHEN** a workspace without projects is opened
- **THEN** the primary action creates a project and successful creation opens its criteria confirmation or candidate intake step

#### Scenario: Draft and feedback inheritance
- **WHEN** the user saves a draft or creates from confirmed feedback
- **THEN** entered data and inherited requirements are preserved, the correct next action is shown, and unavailable approval actions name the responsible person

### Requirement: Project prioritizes candidate work
The system SHALL show candidate status, missing information or next action, and owner before optional project settings. Standards, responsibilities and history SHALL remain accessible through secondary views, and parallel candidate stages SHALL remain independent.

#### Scenario: Add and continue candidates
- **WHEN** criteria are confirmed
- **THEN** an obvious add-candidate action exposes market search, existing link/manual entry and CSV intake while each existing candidate links to its next applicable work

### Requirement: Canonical actionable work
The system SHALL derive shared work items from the authoritative project, candidate, evidence and task state, identify responsibility and missing assignments, distinguish missing from unverified material, and retain one identity per item across all surfaces. Overdue SHALL be a property and filter, not a duplicate item.

#### Scenario: Existing evidence assignment
- **WHEN** an active task already covers a missing field
- **THEN** the shared list shows the task instead of a second derived missing-field item, and entering material alone does not complete the task

#### Scenario: Stage and workspace boundaries
- **WHEN** a member opens home or all work items
- **THEN** only current-workspace items are returned, only applicable current-stage requirements create gaps, and closed research does not demand commercial completion

#### Scenario: No assignee
- **WHEN** an actionable requirement has no assigned executor
- **THEN** it is marked awaiting assignment and the project coordinator has an action to assign it

### Requirement: Home and all work items
The system SHALL show personal actionable work before waiting-on-others and active projects, and provide a shared full work list filtered by project, owner, status and overdue. Observation and acceptance tools SHALL remain accessible from a secondary entry.

#### Scenario: Sparse workspace
- **WHEN** projects exist but no work requires the current member
- **THEN** home explains that state and offers project continuation without multiple empty queue panels

### Requirement: Contextual candidate actions
The system SHALL show the current candidate step, next action and responsible person; deep links SHALL open the appropriate sourcing form, evidence review, decision or task. Research pause/stop SHALL be available as a decision branch while validation and outcomes remain subject to existing approval rules.

#### Scenario: Quote handoff
- **WHEN** a user opens a quote-related work item
- **THEN** the candidate quote form is opened with the relevant context and allows both sourced and offline supplier entry

#### Scenario: Refresh and navigation
- **WHEN** the user changes stage, refreshes, follows an old research link, or uses browser history
- **THEN** the correct view is retained and old evidence, approval and result records remain accessible

### Requirement: Operable and verifiable journey
The system SHALL preserve role restrictions, error/retry, loading, keyboard focus and narrow-screen access throughout the journey and expose real completion only from real business evidence.

#### Scenario: End-to-end acceptance
- **WHEN** a team creates a project, adds a candidate, assigns material collection, records and verifies evidence, and submits a decision
- **THEN** each step leads to the next permitted action and the same work status appears on home, project and candidate surfaces

## Purpose
使跨境选品试点团队能在无需虚构采购批准或经营结果的情况下完成研究反馈，并通过清晰的采购资料、数据刷新与可恢复入口独立开展验收，保持事实、假设与真实经营验收之间的边界。

## ADDED Requirements

### Requirement: Research disposition and feedback
The system SHALL allow authorized decision owners to record STOP or HOLD research conclusions with reasons, learning, source origin and same-candidate evidence, frozen criteria, and a separately traceable feedback chain. Feedback SHALL support empty starting rules, required-evidence changes, or explicit learning, with human confirmation before reuse in a new project.

#### Scenario: Empty research rules
- **WHEN** a research candidate with empty rules receives a documented conclusion and a material requirement or learning proposal
- **THEN** its owner can confirm and reuse the feedback in a new project without generating procurement approval, financial results or commercial completion

#### Scenario: Authorization and snapshot protection
- **WHEN** a caller uses another workspace or another candidate's evidence, or a non-owner attempts confirmation
- **THEN** the request is rejected and original criteria and approval snapshots remain unchanged

### Requirement: Separate provenance and closure reporting
The system SHALL recognize traceable candidate-owned manual and supplier sources, preserve comparator relationships, and report research and commercial closure separately.

#### Scenario: Manual OEM research source
- **WHEN** an OEM candidate has a traceable supplier source and research feedback adopted in a next project
- **THEN** the source and research cycle are shown without claiming verified competitor prices, commercial approval or commercial completion

### Requirement: Detailed sourcing materials
The system SHALL retain explicit tier pricing, sample/stock/custom MOQ, shared original-material links and left/right front-seat checks. Public reference prices SHALL remain unverified and a new verified physical PASS SHALL require both sides, a sample and matching target configuration.

#### Scenario: Supplier and fitment intake
- **WHEN** a member records a quote and a physical test
- **THEN** core price/MOQ units, optional tiers and shared materials are accessible, invalid tier ranges and incomplete verified passes are rejected, and no automatic procurement approval occurs

### Requirement: Explicit market reuse refresh and recovery
The system SHALL display configured request balance, query scope and time, distinguish reuse from a new external query, support repeat observations, and expose safe recovery guidance and actions. Unknown external outcomes SHALL NOT retry automatically.

#### Scenario: Reuse versus refresh
- **WHEN** an analyst views an existing successful batch then explicitly requests fresh observations
- **THEN** viewing consumes no request, refreshing uses the existing server-side budget and durable queue, and the UI identifies which observation is displayed

#### Scenario: Failure or unknown external outcome
- **WHEN** a query fails or its remote result is unknown
- **THEN** history remains visible with actionable recovery and any potentially billable new query requires an explicit user action

### Requirement: Acceptance-ready delivery
The system SHALL include repeatable local tunnel health/recovery, a role-based acceptance guide and isolated integration evidence, while leaving real supplier, sample and team acceptance pending until actually performed.

#### Scenario: Team readiness
- **WHEN** the engineering release is handed over
- **THEN** the team can follow access and role-based cases with expected results, and offline tests are not counted as real commercial acceptance

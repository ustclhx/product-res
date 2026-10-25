# Design

> 规划，待正式产品阶段实施。以下表名、约束均取自当前 `packages/db/src/schema/*.ts`，实施前需按届时 schema 复核。

## Context

- 空间即 `organization`；个人空间 `is_personal = true` 且 `id = user.id`（`ensurePersonalWorkspace` 依赖此等式做幂等补建、`findPersonalWorkspace` 按 `id = userId` 查找，删号流程也按 owner 锁 `owner:<userId>` 处理）。因此“升级”不能把个人空间改成团队空间，也不能换掉它的 id。
- 业务表都带 `workspace_id → organization.id (on delete restrict)`，feature 代码只经 `scoped(db, workspaceId)` 访问。业务表主键全部是全局唯一的 UUIDv7，但很多唯一索引**不含** `workspace_id`（如 `lead_cluster_day_idx (cluster_id, lead_on)`、`costing_scenario_key_idx (lead_id, quote_id, profile_id, mode)`），它们靠父行 id 的全局唯一性隔离空间。
- 跨表引用“只在同一空间内成立，由写入方保证”（`selection.ts` 注释），并且有多处不受外键约束的引用：`direction.node_ids`（uuid[] → `seasonal_node`）、`tracked_store.direction_ids`（uuid[] → `direction`）、`tracked_product.origin_ref`（→ `tracked_store` / `lead`）、`cluster.merged_into_id`、`lead.setting_version` / `recommendation.setting_version`（→ 同空间 `scoring_setting.version`）、`decision.snapshot`、`recommendation.inputs` 等 jsonb 快照。
- 部署级“市场数据仓库”不带 `workspace_id`，所有空间共享，流转时无需迁移（D5）。
- 后台任务使用模板的 Node 队列 / Workflow / 调度契约（`packages/platform/src/{queue,workflow,scheduler}.ts`，引擎表在 `job_engine` schema），不直接依赖 DBOS。

## Goals / Non-Goals

**Goals**

- 个人空间一键升级为新团队空间，选品数据整体移动，个人空间身份不变。
- 个人 ⇄ 团队、团队 ⇄ 团队之间按条目复制或移动，带上依赖闭包，冲突可预期、可预览。
- 流转可续跑、幂等、失败可补偿回滚，过程有审计。

**Non-Goals**

- 不迁移积分、权益、订阅、支付与退款；不合并两个空间的计费关系。
- 不复制文件对象（R2 / 本地存储）与 AI 会话、媒体任务。
- 不做实时双向同步或“共享引用”（两个空间看同一行）；复制后两份数据各自演进。
- 不支持跨用户的个人空间之间流转；不支持把团队空间“降级”回个人空间（可用移动到个人空间达到类似效果）。

## Decisions

### D1 三种操作

| 操作 | 源 | 目标 | 数据范围 | 实现 |
|---|---|---|---|---|
| 升级 `upgrade` | 发起人的个人空间 | 本次新建的团队空间 | D3 中全部“移动”行 | 原地 `update … set workspace_id = 目标` |
| 移动 `move` | 任意可写空间 | 任意可写空间 | 选中条目的依赖闭包（D2） | 原地改 `workspace_id`；与目标冲突的配置行按 D4 合并后删除源行 |
| 复制 `copy` | 任意可读空间（需权限，D6） | 任意可写空间 | 选中条目的依赖闭包 | 插入新行（新 UUIDv7），经 ID 映射表重写外键、数组与 jsonb 引用 |

- **升级**：在同一事务中按现有团队空间创建逻辑（遵守 `multiTenant`、`maxWorkspacesPerUser`）建 `organization(is_personal=false)` + `member(role='owner')` + `workspace_transfer(kind='upgrade', status='pending')`，再经 `TransactionalEnqueue` 启动 Workflow。目标空间在流转完成前处于流转锁中（D8），工作台不执行 `ensureSelectionDefaults`，保证目标在移动开始时没有任何业务行；开始时再校验一次“目标所有可流转表行数为 0”，否则失败。完成后把发起人当前会话的 `active_organization_id` 指向新空间。个人空间保留：成员行、名称、slug、积分、订阅、审计、AI 会话、文件全部不动，业务表为空，之后照常可用。
- **移动选择 原地更新**：主键全局唯一，原地改 `workspace_id` 不会撞主键；不含 `workspace_id` 的唯一索引以父行 id 为前缀，父子一起移动后仍唯一；数组与 jsonb 里的 id 不变，无需重写。只有含 `workspace_id` 的唯一索引（D4）可能与目标已有行冲突；冲突行按 D4 合并到目标行时，引用它的移动行（外键、数组）改指目标 id，这一步与复制共用 ID 映射表。
- **复制必须换 id**：源行保留，主键与 `lead_cluster_day_idx` 等全局唯一索引都要求新 id。

### D2 可选条目与依赖闭包

用户在 UI 中能选的“根”条目及其闭包（闭包内的行与根一起流转，保证“跨表引用只在同一空间内成立”）：

| 根条目 | 闭包（随根流转） | 被引用、按 D4 合并的配置 |
|---|---|---|
| 方向 `direction` | `direction_seller`；`cluster`（含 `merged_into_id` 指向的簇）→ `cluster_member`、`cluster_signal`、`risk_finding`、`lead` → `lead_event`；`supplier_quote`（按 cluster）；`costing_scenario`（按 lead）；`decision` → `follow_outcome`；`recommendation` → `recommendation_label`；`readiness_stat`（按 direction） | `seasonal_node`（`node_ids`）、`supplier`（报价引用）、`logistics_profile`（方案引用）、`scoring_setting`（D4.5） |
| 店铺 `tracked_store` | 无子表 | `direction_ids` 中的方向：只重写已在本次流转中的，其余从数组移除 |
| 追踪商品 `tracked_product` | 无子表 | `origin_ref`：指向本次流转中的店铺 / 线索则重映射，否则置空 |
| 品类研究 `category_study` | `category_study_snapshot` | 无 |
| 核算方案 `costing_scenario` | 所属 `lead`、`cluster` 不在闭包外单独流转：选核算方案等价于选其线索所在方向的一个子集——以 `lead` 为根带上其簇、簇的全部线索、报价、方案、决定 | `supplier`、`logistics_profile`、`cost_param`（整份复制，D4） |
| 档案（决定）`decision` | 同“核算方案”，另带 `follow_outcome` 与 `lead_event` 中的回看提醒 | 同上 |
| 空间配置包 | `seasonal_node`、`brand_entry`、`risk_rule`、`scoring_setting`（当前版本）、`logistics_profile`、`cost_param`、`supplier` | — |

- 以 `lead` / `decision` 为根时，最小闭包是“该线索所在的整个簇”（簇的 `lead`、`cluster_member`、`cluster_signal`、`risk_finding`、`supplier_quote`、`recommendation` 都挂在簇上）以及该簇所属的方向。此时方向不随簇移动：方向行按 D4.1 在目标中复制或合并，簇及其子孙移动（或复制）后 `cluster.direction_id`、`lead.direction_id`、`recommendation.direction_id` 改指目标方向 id；源方向及同方向的其他簇留在源空间。
- 闭包在流转开始的快照事务中一次算出，写入 `workspace_transfer_id_map`（`action = planned`），之后批次只处理清单内的行；流转过程中新产生的行（理论上被 D8 的只读锁阻止）不纳入。

### D3 逐表流转语义

“移动”指升级与 move 操作时随闭包移动；“复制”指 copy 操作时随闭包复制；“不流转”指任何操作都不触及（源空间保留原样）。

| 表 | 文件 | 升级 / 移动 | 复制 | 说明 |
|---|---|---|---|---|
| `direction` | selection | 移动 | 复制 | 唯一 `(workspace_id, name)`，D4.1 |
| `direction_seller` | selection | 移动 | 复制 | 唯一 `(direction_id, marketplace, seller_platform_id)` 随父 id，无冲突 |
| `seasonal_node` | selection | 移动 | 复制（被引用时） | 唯一 `(workspace_id, name)`，D4.1；`preset` 行在目标已有同名时合并 |
| `brand_entry` | selection | 移动 | 复制（配置包） | 无唯一；按 `(name, kind, coalesce(marketplace,''))` 去重 |
| `risk_rule` | selection | 移动 | 复制（配置包） | 无唯一；按 `(kind, match, level)` 去重 |
| `scoring_setting` | selection | 移动（仅升级） | 不流转 | 唯一 `(workspace_id, version)`、只追加，D4.5 |
| `cluster` | selection | 移动 | 复制 | `merged_into_id` 需同批重写 |
| `cluster_member` | selection | 移动 | 复制 | 唯一 `(cluster_id, product_id)` 随父；`product_id` 指部署级商品，不变 |
| `cluster_signal` | selection | 移动 | 复制 | 主键 `(cluster_id, observed_on, dimension)` 随父 |
| `lead` | selection | 移动 | 复制 | 唯一 `(cluster_id, lead_on)` 随父；`setting_version` 见 D4.5 |
| `lead_event` | selection | 移动 | 复制 | 业务事件流（含 `review-reminder` 幂等标记），`actor_user_id` 原样保留 |
| `risk_finding` | selection | 移动 | 复制 | 唯一 `(cluster_id, kind, ref)` 随父；`ref` 可能是 `risk_rule.id`，需重映射（`ref` 非空且参与唯一键，映射不到时原样保留而不是置空；被引用的规则随闭包落地） |
| `tracked_store` | tracking | 移动 | 复制 | 唯一 `(workspace_id, marketplace, seller_key)`，D4.2 |
| `tracked_product` | tracking | 移动 | 复制 | 唯一 `(workspace_id, product_id)`，D4.2 |
| `supplier` | costing | 移动 | 复制（被引用时） | 无唯一；按 `(name, coalesce(url,''), platform)` 去重合并 |
| `supplier_quote` | costing | 移动 | 复制 | `cluster_id` restrict、`supplier_id` cascade；`import_id` 指部署级 `data_import`，不变 |
| `logistics_profile` | costing | 移动 | 复制（被引用时） | 唯一 `(workspace_id, name)`，D4.3 |
| `cost_param` | costing | 移动 | 复制（配置包） | 唯一 `(workspace_id, platform, coalesce(category_id,''))`，D4.4 |
| `costing_scenario` | costing | 移动 | 复制 | 唯一 `(lead_id, quote_id, profile_id, mode)` 随父；`quote_id`、`profile_id` 重映射 |
| `decision` | costing | 移动 | 复制 | 唯一 `lead_id` 随父；`scenario_id` 重映射；`snapshot` 原样保留（历史事实） |
| `follow_outcome` | costing | 移动 | 复制 | 唯一 `(decision_id, review_days)` 随父 |
| `category_study` | insight | 移动 | 复制 | 唯一 `(workspace_id, name)`，D4.1 |
| `category_study_snapshot` | insight | 移动 | 复制 | `modules` 引用部署级观测，不变 |
| `recommendation` | validation | 移动 | 不流转 | 影子验证样本，D4.6 |
| `recommendation_label` | validation | 移动 | 不流转 | 随样本 |
| `readiness_stat` | validation | 移动（仅升级） | 不流转 | 派生统计；唯一 `(workspace_id, marketplace, direction_id, signal_type, computed_on)` 含空间列，但只在升级时移动（目标为空）；move 后在两边重算 |
| `weight_suggestion` | validation | 移动（仅升级） | 不流转 | 基于整空间样本拟合，部分流转后失效 |
| `accuracy_audit` | accuracy | 移动（仅升级） | 不流转 | 唯一 `(workspace_id, week_of)`，D4.7 |
| `accuracy_audit_item` | accuracy | 移动（仅升级） | 不流转 | 随抽检 |
| `member` | tenancy | 不流转 | 不流转 | 目标成员关系独立管理；升级时只新建发起人的 owner 行 |
| `invitation` | tenancy | 不流转 | 不流转 | |
| `workspace_invite_link` | tenancy | 不流转 | 不流转 | |
| `ai_conversation` | ai | 不流转 | 不流转 | 个人对话，且 `ai_message.hold_id` 指向源空间积分预扣 |
| `ai_message` | ai | 不流转 | 不流转 | 同上 |
| `ai_task` | ai | 不流转 | 不流转 | `hold_id` 指向源空间积分；产物在 `file` |
| `file` | files | 不流转 | 不流转 | `r2_key = ws/<workspaceId>/<fileId>`，复制需搬对象，本期不做 |
| `credit_grant` | credits | 不流转 | 不流转 | 积分不随数据走，D9 |
| `credit_hold` | credits | 不流转 | 不流转 | |
| `credit_debt` | credits | 不流转 | 不流转 | 主键即空间 |
| `credit_ledger` | credits | 不流转 | 不流转 | 账本只追加 |
| `billing_customer` | billing | 不流转 | 不流转 | 唯一 `(workspace_id, provider)` |
| `subscription` | billing | 不流转 | 不流转 | |
| `purchase` | billing | 不流转 | 不流转 | |
| `payment` | billing | 不流转 | 不流转 | |
| `payment_refund` | billing | 不流转 | 不流转 | |
| `refund_request` | billing | 不流转 | 不流转 | |
| `billing_compensation` | billing-compensation | 不流转 | 不流转 | |
| `audit_log` | platform | 不流转（另写新行） | 不流转（另写新行） | D10 |
| `notification` | platform | 不流转 | 不流转 | |
| `credit_hold_allocation` | credits | 不流转 | 不流转 | 无空间列，随 `credit_hold` |
| `apikey` | auth | 不流转 | 不流转 | 空间记在 `metadata`；升级后个人空间 Key 仍指向（已空的）个人空间，UI 提示在团队空间重新创建 |
| `session` | auth | 升级后改 `active_organization_id` | 不变 | 只改发起人会话 |

合计：带空间列的表 49 张——参与流转 29 张（其中 `scoring_setting`、`readiness_stat`、`weight_suggestion`、`accuracy_audit`、`accuracy_audit_item` 只在升级时移动，`recommendation`、`recommendation_label` 随闭包移动但不复制）、不流转 20 张；另有 3 张间接关联表（`credit_hold_allocation`、`apikey`、`session`），共分类 52 张。

### D4 冲突与 ID 处理

复制时每行新 id 由 `newId()` 生成，`(transfer_id, table_name, source_id) → target_id` 写入 `workspace_transfer_id_map`；子表按“父先子后”的批次顺序插入，外键、`uuid[]` 数组（`node_ids`、`direction_ids`）、`origin_ref`、`merged_into_id`、`risk_finding.ref`（规则 id 时）都按映射重写；映射不到的数组元素删除、可空引用置空，并在流转报告里列出。jsonb 快照（`decision.snapshot`、`recommendation.inputs`、`cluster_signal.inputs`、`lead.confidence_detail`）是历史事实，只引用部署级观测或描述性内容，原样保留，不重写。

移动时只有含 `workspace_id` 的唯一索引可能冲突，其余均随父 id 天然唯一。冲突规则（预览时展示给用户，默认值如下）：

1. **按名称唯一的根条目**（`direction`、`category_study`）：目标已有同名时默认**重命名**为“名称（来自 <源空间名>）”，再冲突追加序号；方向另可选“合并到目标同名方向”：簇挂到目标方向，`direction_seller` 按 `(marketplace, seller_platform_id)` 去重（目标已 `rejected` 的保持 rejected），关键词 / 类目 / 站点数组取并集。`seasonal_node` 默认**合并**（同名即视为同一节点，目标的日期为准），源 `node_ids` 映射到目标节点 id。
2. **店铺与追踪商品**（`tracked_store (ws, marketplace, seller_key)`、`tracked_product (ws, product_id)`）：目标已有则**合并跳过**，保留目标行；`tracked_store.direction_ids` 并入映射后的方向，`tracked_product.tier` 取更热的档位（hot > normal > cold）并把 `tier_reason` 记为 `transfer`。移动时源行删除。
3. **物流方案**（`logistics_profile (ws, name)`）：同名且计费字段（`platform`、`type`、`transit_days`、`head_freight`、`last_mile`、`banned_attributes`）完全一致则合并到目标行；否则重命名。被 `costing_scenario.profile_id`（restrict）引用，必须在方案之前落地。
4. **成本参数**（`cost_param (ws, platform, coalesce(category_id,''))`）：目标已有则**保留目标**，跳过源行并在报告中标出；核算方案的 `result` 是计算时快照，不受影响。
5. **评分设置**（`scoring_setting (ws, version)`，只追加、最新版本生效）：升级时整表移动（目标为空，无冲突）。选择性复制 / 移动**不流转**评分设置：给目标追加版本会改变目标当前生效的权重。线索与推荐的 `setting_version` 保留原值，流转记录中写入源空间该版本的完整设置快照，界面对这些线索标注“评分版本来自 <源空间> vN”；目标空间下次流水线重算时按自己的版本生成新线索。
6. **影子验证样本**（`recommendation` 唯一 `(lead_id, frozen_on)` 与 `(cluster_id, frozen_on, sample_kind)`，均随父）：升级与移动时随簇 / 方向移动（FK `direction_id`、`cluster_id` 为 restrict，留在源会形成跨空间引用）。复制**不带**样本：样本是“冻结时刻的公平回看”，复制会让同一真实推荐在两个空间各计一次，团队之后若再合并数据就重复计数；目标空间的准备度从自己的样本重新累计。
7. **准确性抽检**（`accuracy_audit (ws, week_of)`）：一致率按部署级来源汇总写入 `source_qualification`，复制会重复计入样本数、影响来源主值资格，因此任何选择性操作都**不流转**；升级时整体移动（目标为空，周次不冲突，汇总数不变）。
8. **自然键去重的无唯一约束表**（`brand_entry`、`risk_rule`、`supplier`）：按上表列出的自然键在目标中查找，命中即合并（映射到目标 id），不命中则插入。

### D5 不需要迁移的部署级数据

以下表不带 `workspace_id`，所有空间共享，流转只引用其 id、不复制：`data_source`、`source_budget`、`budget_ledger`、`sync_run`、`raw_payload`、`marketplace_product`、`marketplace_seller`、`marketplace_keyword`、`observation`、`source_qualification`、`metric_priority`、`import_template`、`data_import`、`marketplace_category`、`data_quality_issue`、`store_listing`、`marketplace_review`。平台级：`user`、`account`、`verification`、`two_factor`、`setting`、`plan`、`plan_price`、`webhook_event`、`ai_model`、`metrics_daily`、`waitlist`、`newsletter_subscriber` 与 `job_engine.*`。

### D6 权限

工作台写权限沿用 `assertWorkbenchWriter`（空间可写且角色为 owner / admin）。

| 操作 | 源空间要求 | 目标空间要求 |
|---|---|---|
| 升级 | 发起人是该个人空间的 owner（即 `id = user.id`） | 新建，发起人为 owner |
| 复制：个人 → 团队 | 发起人自己的个人空间 | owner / admin，且目标可写 |
| 复制：团队 → 个人 | owner / admin | 发起人自己的个人空间 |
| 复制：团队 → 团队 | owner / admin | owner / admin，且目标可写 |
| 移动：任意 → 任意 | 个人空间为本人；团队空间为 **owner**（移出会删除团队数据） | owner / admin，且目标可写 |

- member 不能发起任何流转；平台管理员不经此入口代为流转（避免越权搬运用户数据）。
- 软删空间、`multiTenant=false` 时的只读团队空间（`workspaceReadOnly`）、源与目标相同、已有进行中的流转的空间均拒绝。
- 不能流入他人的个人空间。
- 权限在发起时与 Workflow 每个批次开始时各校验一次（以数据库当前成员关系为准）；批次执行时权限已失效则流转转为失败并补偿（D8）。

### D7 数据模型与服务位置

新 schema 文件 `packages/db/src/schema/transfer.ts`：

- `workspace_transfer`：`id`、`kind (upgrade|copy|move)`、`source_workspace_id`、`target_workspace_id`、`requested_by`、`idempotency_key`、`selection jsonb`（根条目与冲突选项）、`plan jsonb`（闭包统计、冲突预览、评分版本快照）、`status (pending|running|completed|failed|compensating|compensated|cancelled)`、`counts jsonb`、`error_code`、`created_at`、`started_at`、`finished_at`。唯一 `(requested_by, idempotency_key)`；部分唯一索引保证每个空间同时最多一个进行中的流转（分别对 source、target 建 `where status in ('pending','running','compensating')`）。
- `workspace_transfer_batch`：`id`、`transfer_id`、`seq`、`batch_key`（如 `config`、`direction:<id>`、`store-pool`）、`status (pending|done|compensated)`、`counts`、`created_at`、`updated_at`；唯一 `(transfer_id, batch_key)`。
- `workspace_transfer_id_map`：`transfer_id`、`table_name`、`source_id`、`target_id`、`action (planned|moved|copied|merged|skipped|renamed)`、`batch_key`（补偿按批次逆序撤销时定位）、`source_row jsonb`（移动合并时保存被删除的源行，D8）、`updated_at`；主键 `(transfer_id, table_name, source_id)`。复合主键表（`cluster_signal`）以拼接键记录，因此 id 列为 `text`。
- `workspace_transfer` 另有检查约束 `source_workspace_id <> target_workspace_id`，以及按源 / 目标空间列出记录的索引。

这些表同时关联两个空间，刻意不用 `workspace_id` 列名，不经 `scoped()`；只由流转服务访问，服务在入口显式校验两边成员关系（与 `ebay-account-deletion` 这类跨空间操作同样说明理由）。

服务位置：流转需要同时读写选品、追踪、核算、洞察、验证、抽检表，倾向放在 `packages/follow/src/transfer/`（已依赖上述 schema）；团队空间创建与成员校验调用 `packages/auth`。apps/web 只做 Server Function 入口与 UI。

### D8 执行、幂等与回滚

- **入口**：Server Function 在一个事务里写 `workspace_transfer(pending)` 并经 `TransactionalEnqueue` / `Workflow.create({ id: transfer.id })` 启动，回滚则不投递。客户端提供幂等键（打开对话框时生成），重复提交返回同一流转。
- **Workflow 步骤**（`step.do`，可重试）：
  1. `plan`：快照事务内计算闭包、冲突、行数，写 `plan` 与 `id_map(planned)`、批次列表。超过阈值（如 5 万行）只允许升级与移动，复制要求缩小范围。
  2. `batch:<key>`：按“配置 → 方向（每方向一批）→ 店铺池 → 追踪商品 → 品类研究 → 验证 / 抽检（仅升级）”顺序（`recommendation` / `recommendation_label` 对 `cluster`、`direction` 是 restrict 外键，归入方向批次与簇同事务移动；验证批次只含 `readiness_stat`、`weight_suggestion`、`accuracy_audit*`），每批一个数据库事务：取 `ws:<source>`、`ws:<target>` 两把 advisory lock（按 id 排序获取避免死锁），校验权限，执行插入或原地更新，写 `id_map` 结果与 `batch.status = done`。批次开始先检查 `done` 即跳过，保证重试与续跑幂等。单批行数过大时按主键分页再切子批，子批键写入 `batch_key`。
  3. `finalize`：标记 `completed`，写审计，升级时切换会话活跃空间并重算两边的 `readiness_stat`（仅 move 时需要）。
- **流转锁**：流转处于 pending / running / compensating 时，两个空间对工作台写入只读（在 `withWorkspace` 解析出 `workspaceReadOnly` 时并入此条件，错误码 `WORKSPACE_TRANSFERRING`）；`selection-daily-v1`、`selection-label-v1`、`selection-readiness-v1`、`selection-review-v1`、店铺追踪采集、每周抽检等按空间循环的任务跳过这些空间，`ensureSelectionDefaults` 不在流转中的空间写预置数据。
- **补偿回滚**：失败（不可重试错误、权限失效、超时）或用户在完成前取消时进入 `compensating`，按批次逆序撤销：复制批次删除 `id_map` 中 `copied` 的目标行（子先父后）；移动批次把 `moved` 的行改回源空间，`merged` 的源行从映射记录恢复（移动合并时源行先写入 `id_map` 的 `source_row jsonb` 再删除）。完成后 `compensated`。`completed` 的流转不提供回滚，用户可发起反向移动。
- 升级失败补偿完成后，新建的团队空间按现有软删流程删除（只有发起人一个成员）。

### D9 积分与权益不随数据走

- 积分余额、预扣、欠费、账本都留在源空间；升级后个人空间仍持有原有积分。新团队空间在 `credits.requireGrantForAccess=true` 时需要管理员另行发放积分才能使用工作台（`add-team-invite-links` 的待开通页会列出其他空间，用户不会被困住）。升级前的确认对话框必须明示这一点；是否提供“管理员一并开通”的后台快捷操作留到实施时决定。
- 权益按目标空间的套餐判断；流入数据可能超出目标套餐限额（如方向数、追踪商品数——若届时 entitlements 有此类限额），`plan` 步骤按目标权益校验，超出则拒绝并提示。

### D10 审计

- 已有 `audit_log` 行不改 `workspace_id`，留在源空间（个人空间升级后仍可在其审计中看到历史）。
- 新写：`workspace.transfer.requested`、`workspace.transfer.completed`、`workspace.transfer.failed`、`workspace.transfer.compensated` 在源与目标各一行，`meta` 带 `transferId`、`kind`、对方空间 id、按表计数；升级另写 `workspace.upgraded`（源）与 `workspace.created_from_personal`（目标）。
- 业务事件流 `lead_event` 随线索流转；不额外为每行写审计。

### D11 UI 入口

- 个人空间 `/app/$slug/settings`：“升级为团队空间”卡片 → 预览对话框（各类数据条数、不随迁移的内容：积分、订阅、AI 对话、文件、API Key、审计；新空间需开通的提示）→ 确认后跳转到流转进度页。
- 方向（`follow`）、店铺（`stores`）、追踪商品、品类研究（`category`）、档案（`archive`）列表：多选后“复制到空间… / 移动到空间…”，选择目标空间（只列出有写权限的空间）与冲突策略，预览后提交。
- `/app/$slug/settings` 下“数据流转记录”：进度、按表计数、跳过与重命名清单、失败原因、取消（未完成时）、重试续跑。
- 流转中的空间顶部横幅提示只读。
- `/admin/workspaces` 详情显示流转记录（只读）。

## Risks / Trade-offs

- **积分与权益不跟随**：用户升级后发现团队空间无积分 / 待开通，体验断裂；以确认对话框说明 + 管理员开通流程缓解。
- **影子验证样本归属**：升级时样本随方向移动，个人空间准备度归零；选择性复制不带样本，目标空间准备度从冷启动开始，团队可能误以为模型“退化”。move 部分方向后两边的 `readiness_stat`、`weight_suggestion` 都基于残缺样本，需重算，未采用的 `weight_suggestion` 在源空间作废（`status = dismissed`，`resolved_by` 记发起人）。
- **准确性抽检归属**：抽检记录只在升级时移动；选择性操作后，源空间仍保留历史抽检而对应追踪商品已移走，目标空间从下周开始自行抽检。部署级 `source_qualification` 的样本统计不应因流转变化——实施时需确认 `packages/marketdata/src/accuracy.ts` 的汇总是否按空间去重。
- **评分版本错位**：选择性流转的线索 `setting_version` 指向源空间版本号，可能与目标同号不同权重；用标注与快照兜底，计算新线索时不受影响。
- **外部额度**：店铺追踪采集按空间循环（`packages/follow/src/stores/collect.ts` 逐 `workspaceId` 处理），复制店铺池 / 追踪商品会让同一卖家、商品被两个空间各采集一次，增加 eBay Browse 调用（每日上限 5000、安全线 4500）。`plan` 步骤需估算新增调用并提示；更好的方案是采集层按 `(platform, seller_key)` / `product_id` 跨空间去重，作为实施前置评估项。
- **eBay 账号删除**：部署级删除按卖家标识跨空间匿名化 `direction_seller`、`tracked_store`、`lead_event` 等；复制在批次事务内读取当时数据，删除处理晚于复制时会同时覆盖目标行，早于复制时复制的是已匿名化数据，不会“复活”被删数据。需确认删除处理与批次事务的锁顺序。
- **API Key 与外部集成**：个人空间的 API Key 在升级后仍有效但指向空空间，外部脚本会静默读到空数据；确认页与完成页提示。
- **文件与 AI 产物**：不流转，方案 / 研究中如引用文件链接会在目标空间失效（当前业务表未直接引用 `file`，实施时复核）。
- **长事务与锁**：每批一个事务、两把空间锁，期间两个空间只读；大空间升级可能持续数分钟，需进度页与超时补偿。
- **个人空间身份**：方案从不修改个人空间的 `organization` 行；实施时需加测试断言升级前后 `organization.id = user.id`、`is_personal = true`、owner 成员行不变，且 `ensurePersonalWorkspace` 不会补建第二个空间。

## Migration Plan

1. 实施时新增 `transfer.ts` schema 与一个迁移（只建新表与索引，不改现有表），按 docs/09-parallel-plan.md 的迁移规则提交。
2. 功能由模板配置开关（如 `tenancy.dataTransfer`）控制，默认关闭；`multiTenant=false` 时强制关闭。
3. 先上线升级，再上线选择性复制 / 移动。
4. 回退：关闭开关即隐藏入口；已完成的流转数据保持，进行中的流转先完成或补偿后再关闭。

## Open Questions

- 选择性移动单个簇时，方向在目标中是“复制一份”还是“必须合并到已有方向”，需结合 UI 稿确定（D2 当前倾向：按 D4.1 规则复制或合并）。
- 是否允许平台管理员在后台代用户执行升级（客服场景）。
- 方向、追踪商品等届时是否有套餐数量限额，决定 D9 的校验内容。
- 采集层跨空间去重是否作为本 change 的前置任务。

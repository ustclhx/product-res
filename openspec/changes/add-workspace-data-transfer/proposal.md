# Proposal

> **规划，待正式产品阶段实施。** 本 change 只记录方案与验收口径，内测阶段不实施、不出迁移；
> 进入正式产品阶段后由协调者按 tasks 拆分派发。

## Why

`add-team-invite-links` 开启 `tenancy.multiTenant` 后，用户可以创建团队空间并邀请成员，但个人空间里已经积累的选品数据（方向、店铺池、追踪商品、品类研究、核算方案、档案等）留在原地，团队空间只能从零配置。正式产品阶段需要一条受控的数据流转通道：把个人空间整体“升级”为团队空间，以及在个人空间与团队空间之间按条目复制或移动。

个人空间的 id 等于用户 id（`packages/auth/src/personal-workspace.ts` 的 `ensurePersonalWorkspace` 以此保证幂等补建），任何方案都不能改写个人空间的身份或把它就地变成团队空间。

## What Changes

- **升级为团队空间**：新建一个团队空间（当前用户为 owner），把个人空间中全部可流转的业务数据**移动**过去；个人空间保留（变为空），`organization.id`、`is_personal`、成员行都不变。
- **共享与复制 / 移动**：在个人空间 ⇄ 团队空间（以及团队 ⇄ 团队）之间，对选中的方向、店铺、追踪商品、品类研究、核算方案、档案（决定与回看）发起复制或移动；按“依赖闭包”带上被引用的行，按自然键去重或合并，复制时重映射 ID。
- **逐表流转语义**：对全部 49 张带 `workspace_id` / `organization_id` 的表（另 3 张间接关联）定义“移动 / 复制 / 不流转”，并给出外键与唯一约束冲突的处理规则（见 design D3、D4）。积分、账单、AI 会话、文件、审计、通知、成员关系不流转。
- **流转任务**：新增流转记录、批次与 ID 映射表；经模板 Node 持久 Workflow 后台执行，按批次事务提交、幂等键去重、可续跑、可补偿回滚；流转期间源与目标空间对工作台写入只读，并跳过相关定时流水线。
- **审计**：原有 `audit_log` 留在原空间；流转的发起、完成、失败、回滚分别在源与目标空间写审计。
- **UI**：个人空间设置页“升级为团队空间”；各列表多选后的“复制到 / 移动到空间…”；空间设置中的“数据流转记录”页（进度、失败原因、重试、回滚）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `workspace-tenancy`：新增个人空间升级、跨空间复制 / 移动、流转权限、不流转数据、流转任务幂等与回滚、流转期间只读的要求。

## Impact

- `packages/db`：schema 新文件 `transfer.ts`（`workspace_transfer`、`workspace_transfer_batch`、`workspace_transfer_id_map`）与一个迁移；不修改现有业务表结构。
- 新的流转服务（位置见 design D7，倾向 `packages/follow` 内的 `transfer/` 模块，因其需要同时访问选品、追踪、核算、洞察、验证与抽检表）；`packages/auth` 复用团队空间创建与成员校验。
- `apps/jobs`：注册流转 Workflow；选品日常、打标签、准备度、回看提醒、店铺追踪采集、每周抽检等任务跳过处于流转中的空间。
- `apps/web`：空间设置页、方向 / 店铺 / 追踪 / 品类研究 / 档案列表的批量操作、流转记录页、zh / en 文案；`/admin/workspaces` 显示流转记录。
- 积分、权益、订阅不随数据迁移；新团队空间是否开通由 `credits.requireGrantForAccess` 规则独立决定。
- 无新依赖。

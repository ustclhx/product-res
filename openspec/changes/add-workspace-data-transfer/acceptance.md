# 验收覆盖表（tasks 7.1、7.2 与 spec Scenario）

> 2026-10-26 W5a 核对。每项指向至少一个通过的测试（`文件 › 用例`）。标 **新增** 的是本次补的用例或断言。
> 7.3 e2e 由另一 worker 负责，不在本表范围内。

缩写：

- `engine` = `packages/follow/test/transfer-engine.test.ts`
- `copy` = `packages/follow/test/transfer-copy.test.ts`
- `audit` = `packages/follow/test/transfer-audit.test.ts`
- `lock` = `packages/follow/test/transfer-lock.test.ts`
- `preview` = `packages/follow/test/transfer-preview.test.ts`
- `wf` = `apps/jobs/test/transfer-workflow.test.ts`
- `node` = `apps/jobs/test/node-transfer.integration.test.ts`
- `web` = `apps/web/test/workspace-transfer.test.ts`
- `sel` = `apps/web/test/follow-selection-config.test.ts`

## tasks 7.1 集成测试

| 场景 | 覆盖用例 |
|---|---|
| 升级全量移动，按表计数一致 | engine › 升级 › 整体移动到新团队空间，按表计数一致，个人空间身份不变；wf › 升级成功：plan → 逐批 → finalize…；node › 升级成功 |
| 升级后个人空间身份不变（id = user.id、is_personal、owner 成员行不变） | engine › 升级 › 整体移动到新团队空间…（断言 organization 行、owner 成员行、`ensurePersonalWorkspace` 返回原 id、仅一个个人空间） |
| 复制冲突：同名方向重命名 | copy › 方向默认重命名并复制整棵闭包…；preview › 冲突预览：同名方向默认重命名、可改为合并… |
| 复制冲突：同名方向合并 | copy › 方向合并：簇挂到目标方向、对标店铺去重、数组并集；补偿后目标逐行恢复 |
| 复制冲突：店铺与追踪商品合并 | copy › 店铺、追踪商品、物流方案与成本参数：合并跳过 / 升档 / 相位保留 / merge-if-equal / 保留目标 |
| 复制冲突：物流方案合并 | 同上 |
| 复制冲突：成本参数保留目标 | 同上；engine › 以档案为根：带上整簇与整份成本参数…成本参数保留目标 |
| 复制不带影子验证样本与抽检 | copy › 方向默认重命名并复制整棵闭包…不带样本与抽检、源空间不变 |
| 批次失败后续跑幂等 | engine › 升级 › 批次失败后续跑幂等，补偿后两边恢复并软删新空间；copy › 批次失败后续跑幂等；补偿后目标不残留；wf › 重试续跑…；wf › 基础设施错误重试耗尽… |
| 补偿回滚后两边数据恢复 | engine › 升级 › 批次失败后续跑幂等，补偿后…；engine › 选择性移动 › 冲突按决定重命名 / 合并 / 保留目标，补偿后两边逐行恢复；wf › 批次中途不可重试失败：逆序补偿…；node › 批次不可重试失败 |

## tasks 7.2 权限测试

| 场景 | 覆盖用例 |
|---|---|
| member 拒绝 | engine › 权限 › member 拒绝；admin 不能移出团队数据；他人个人空间拒绝；copy › 权限：…member 被拒…；web › 复制：…member 403…；preview › 权限：member 拒绝… |
| 团队移出需 owner（admin 移动 403、复制允许） | engine › 权限 › member 拒绝；admin 不能移出团队数据…；copy › 权限：团队 admin 可复制团队数据到个人空间…；web › 复制：…admin 可复制团队数据但不能移出 |
| 只读空间拒绝 | engine › 权限 › member 拒绝…（`multiTenant=false` → `WORKSPACE_READ_ONLY`）；engine › 状态与顺序 › 执行中空间被软删或团队转为只读… |
| 软删空间拒绝 | **新增** engine › 权限 › member 拒绝…（发起时软删的源 / 目标 → `WORKSPACE_NOT_FOUND`）；engine › 状态与顺序 › 执行中空间被软删或团队转为只读…（执行中 → `TRANSFER_PERMISSION_REVOKED`） |
| 他人个人空间拒绝 | engine › 权限 › …他人个人空间拒绝（移动到他人个人空间）；copy › 权限：…不能复制到他人个人空间 |
| 批次执行时权限失效转补偿 | engine › 权限 › 批次执行时权限失效：批次拒绝，补偿后数据恢复（引擎层）；**新增** wf › 批次执行时权限失效：源空间 owner 被降为 admin，下一批次转入补偿，两边恢复（经 Workflow 端到端，含两边失败 / 回滚审计） |

## spec Scenario

| Requirement › Scenario | 覆盖用例 |
|---|---|
| 个人空间升级 › 升级个人空间（数据移到新团队空间、个人空间为空、用户被切换） | engine › 升级 › 整体移动…（会话 `active_organization_id` 指向新空间）；wf › 升级成功…（会话切换并失效 KV 缓存）；web › 升级：同一幂等键两次只建一个流转与一个团队空间… |
| 个人空间升级 › 升级后个人空间身份（重新登录 / 补建不产生第二个个人空间） | engine › 升级 › 整体移动…（升级后调用 `ensurePersonalWorkspace` 返回 user.id，按成员查个人空间仅 1 个） |
| 跨空间复制与移动 › 复制同名方向 | copy › 方向默认重命名并复制整棵闭包…（新方向及簇、线索、核算方案；原同名方向与源空间不变） |
| 跨空间复制与移动 › 移动店铺到已追踪该店铺的空间 | engine › 选择性移动 › 冲突按决定重命名 / 合并 / 保留目标…（目标保留原店铺并入方向，源店铺删除） |
| 跨空间复制与移动 › 复制不带影子验证样本与抽检记录 | copy › 方向默认重命名并复制整棵闭包…；lock › 重建清除失效组合并按现有样本重算… |
| 数据流转权限 › member 发起复制 | copy › 权限：…member 被拒；web › 复制：…member 403… |
| 数据流转权限 › admin 移出团队数据 | engine › 权限 › …admin 不能移出团队数据…；web › 复制：…admin 可复制团队数据但不能移出 |
| 不随数据流转的内容 › 升级后的积分 | **新增** engine › 升级 › 积分、AI 对话、通知与已有审计留在个人空间，新团队空间没有积分（所有不流转的空间表逐行比对；团队空间只有 owner 成员与 `workspace.*` 审计） |
| 幂等、续跑与回滚 › 重复提交 | engine › 升级 › 整体移动…（同键两次同一流转、只建一个团队空间）；web › 升级：同一幂等键两次只建一个流转与一个团队空间…；web › 并发续跑只起一个实例 |
| 幂等、续跑与回滚 › 中途失败 | wf › 批次中途不可重试失败：逆序补偿，两边恢复，新空间软删，审计记失败与回滚；audit › 失败转补偿：两边各记失败与回滚… |
| 流转期间空间只读 › 流转中编辑方向 | sel › 真实流转记录锁住两边的方向写入，结束后恢复（**新增** 目标空间 admin 断言）；`apps/web/src/features/workbench/access.test.ts`、`errors.test.ts`（`WORKSPACE_TRANSFERRING` 文案）；lock › 日常、标签、准备度、抽检跳过两边… |

## 核对中发现的实现问题

无与 spec 不符的实现问题。

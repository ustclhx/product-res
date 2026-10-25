# Tasks

> 2026-10-26 起实施，按波次派发：W1 基础层 → W2 升级引擎与流转锁 → W3 Workflow、审计与升级 UI → W4 选择性复制 / 移动与验收。

## 1. 前置评估

- [x] 1.1 按届时 schema 复核 design D3 的逐表分类与唯一约束清单，新增的空间级表必须补充分类（加一条检查：带 `workspace_id` 的表都出现在流转注册表中，否则测试失败）。
- [x] 1.2 评估店铺追踪采集按 `(platform, seller_key)` / `product_id` 跨空间去重，决定是否作为前置改动；确认 `source_qualification` 汇总不因抽检归属变化而重复计数。

## 2. 数据模型

- [x] 2.1 `packages/db/src/schema/transfer.ts`：`workspace_transfer`、`workspace_transfer_batch`、`workspace_transfer_id_map` 及唯一 / 部分唯一索引，一个迁移；模板配置开关（默认关闭，`multiTenant=false` 时强制关闭）。

## 3. 流转服务

- [x] 3.1 流转表注册表：每张参与流转的表声明闭包父子关系、自然键、冲突策略、需重写的外键 / 数组 / 引用列。
- [x] 3.2 `plan`：闭包计算、冲突预览、行数与目标权益校验、评分版本快照、外部额度增量估算（只估算店铺并入类目 / 关键词不同的方向带来的新增 Browse 调用，见 design「决定」）；以核算方案 / 档案为根时带上整份 `cost_param`。
- [x] 3.3 移动批次：原地更新 `workspace_id`、冲突行合并与引用改写、源行快照写入 ID 映射。
- [x] 3.4 复制批次：新 id 生成与 ID 映射、父先子后插入、外键 / 数组 / `origin_ref` / `merged_into_id` / `risk_finding.ref` 重写。
- [x] 3.5 权限校验（D6）、双空间 advisory lock、幂等键、批次 done 跳过、补偿回滚（逆序撤销复制与移动）；eBay 账号删除互斥（全局锁、清理 `id_map.source_row`，见 design「决定」）。
- [x] 3.6 升级：新建团队空间 + owner 成员 + 流转记录同事务，完成后切换会话活跃空间；失败补偿后软删新空间；测试断言个人空间 `id = user.id`、`is_personal`、owner 成员行不变。

## 4. 后台任务

- [x] 4.1 `apps/jobs` 注册流转 Workflow（`step.do` 按批次，可续跑）与超时补偿。
- [x] 4.2 流转锁：`withWorkspace` 只读条件 `WORKSPACE_TRANSFERRING`；选品日常、打标签、准备度、回看提醒、店铺采集、每周抽检与 `ensureSelectionDefaults` 跳过流转中的空间；move 完成后重算两边 `readiness_stat` 并作废源空间未处理的 `weight_suggestion`。

## 5. 审计

- [x] 5.1 源 / 目标空间写 `workspace.transfer.*` 与升级审计，`meta` 带流转 id 与按表计数；已有审计行不改归属。

## 6. UI

- [x] 6.1 个人空间设置“升级为团队空间”：预览（数据条数、不随迁移的积分 / 订阅 / AI 对话 / 文件 / API Key / 审计、新空间需开通提示）与确认。
- [x] 6.2 方向、店铺、追踪商品、品类研究、档案列表的多选“复制到 / 移动到空间…”，目标空间选择与冲突策略预览。
- [x] 6.3 “数据流转记录”页（进度、计数、跳过 / 重命名清单、失败原因、取消、重试）、流转中只读横幅、`/admin/workspaces` 只读展示；zh / en 文案。

## 7. 测试与验收

- [x] 7.1 集成测试：升级全量移动与计数一致、个人空间身份不变；复制冲突（同名方向重命名 / 合并、店铺与追踪商品合并、物流方案合并、成本参数保留目标）；复制不带影子验证样本与抽检；批次失败后续跑幂等；补偿回滚后两边数据恢复。
- [x] 7.2 权限测试：member 拒绝、团队移出需 owner、只读 / 软删空间拒绝、他人个人空间拒绝、批次执行时权限失效转补偿。
- [ ] 7.3 e2e：升级流程与选择性复制流程，进度页与只读横幅。

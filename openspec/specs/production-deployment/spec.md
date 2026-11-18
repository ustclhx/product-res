# production-deployment Specification

## Purpose
定义 Cloudflare 形态生产环境如何从已验证的提交受控发布、确认版本与可用性，以及生产数据库如何备份、恢复与隔离凭据，使生产上线不依赖开发者本机且可回滚、可恢复。

## Requirements

### Requirement: 生产发布由 tag 触发并只发布已验证的提交
生产发布 SHALL 只由推送到 main 历史上提交的版本 tag 触发（回滚与紧急修复可对版本 tag 手动触发），并 MUST 经 GitHub `production` environment 审批后才获得生产凭据。被发布的提交 MUST 已成功完成 staging 发布，且 MUST 已在 main 上通过 CI；只有以下两种情况可以不要求 CI 通过：仓库发布阶段为测试阶段，或发布阶段为上线后、手动触发并选择紧急修复且填写原因。不满足条件时流水线 MUST 在执行任何迁移前失败。每次不要求 CI 的发布 MUST 在流水线摘要中记录绕过类型、原因与触发人。

#### Scenario: 已验证提交发布
- **WHEN** 对一个已通过 CI 且 staging 发布成功的 main 提交推送版本 tag，并由审批人批准
- **THEN** 流水线开始生产迁移与部署

#### Scenario: 未在 staging 验证的提交
- **WHEN** 版本 tag 指向的提交没有成功的 staging 发布记录，或不在 main 历史上
- **THEN** 流水线失败，生产数据库与 Worker 均不变

#### Scenario: 未获审批
- **WHEN** 版本 tag 已推送但 production environment 审批未通过
- **THEN** 流水线不获取生产凭据，也不执行迁移或部署

#### Scenario: 上线后 CI 失败的提交
- **WHEN** 发布阶段为上线后，版本 tag 指向的提交 CI 失败，且不是手动触发的紧急修复
- **THEN** 流水线在迁移前失败

#### Scenario: 上线后紧急修复
- **WHEN** 发布阶段为上线后，维护者对 CI 未完成的提交手动触发生产发布，选择紧急修复并填写原因
- **THEN** 流水线不要求 CI，仍要求 staging 发布成功与审批，并在摘要中记录绕过原因与触发人

#### Scenario: 测试阶段发布
- **WHEN** 发布阶段为测试阶段，版本 tag 指向的提交 CI 未通过但 staging 发布成功
- **THEN** 流水线继续，并在摘要中记录本次未要求 CI

### Requirement: 生产发布顺序、串行与版本确认
生产发布 MUST 串行执行，按「构建 jobs 与 web → 数据库迁移 → 部署 jobs → 部署 web」顺序进行，任一步失败 MUST 停止后续步骤；构建失败时 MUST NOT 执行迁移。web 部署后 SHALL 轮询 `GET /api/health`，直到返回 200、`db.status` 为 `up` 且 `version` 等于本次提交的完整 SHA；限定时间内未满足 MUST 使流水线失败。日志 MUST NOT 包含连接串或密钥。

#### Scenario: 正常发布
- **WHEN** 已审批的生产发布开始
- **THEN** jobs 与 web 构建成功后，生产数据库应用全部迁移，随后 jobs、web 依次部署，健康检查返回本次完整 SHA

#### Scenario: 构建失败
- **WHEN** 生产发布的 web 构建失败
- **THEN** 不执行迁移，生产数据库与 Worker 均不变，流水线失败

#### Scenario: 迁移失败
- **WHEN** 生产迁移失败
- **THEN** jobs 与 web 均不部署，生产继续运行上一版本，流水线失败

#### Scenario: 并发发布
- **WHEN** 一次生产发布进行中又推送了新的版本 tag
- **THEN** 新发布等待前一次完整结束后才开始，进行中的发布不被取消

### Requirement: 生产冒烟只读
版本确认后，流水线 SHALL 对生产域名运行只读冒烟测试，至少覆盖首页、定价页与健康接口；冒烟 MUST NOT 注册用户、发起支付或写入生产业务数据。冒烟失败 MUST 使流水线失败并提示按 runbook 回滚。

#### Scenario: 冒烟通过
- **WHEN** 新版本健康检查通过
- **THEN** 首页与定价页返回 200 且渲染主要内容，生产数据库中没有冒烟产生的用户或订单

### Requirement: 生产与 staging 凭据和资源隔离
生产 MUST 使用独立的 Neon 项目、Hyperdrive、KV、Queues、Workflows、R2 与限流命名空间，MUST NOT 复用 staging 的数据库、资源 ID 或 secrets。生产迁移凭据 MUST 只存在于 `production` environment，PR 与 staging 流水线 MUST NOT 获得。

#### Scenario: PR 流水线
- **WHEN** 一个 PR 或 main → staging 发布运行
- **THEN** 其作业环境中不存在生产数据库凭据，也无法部署生产 Worker

### Requirement: 生产数据库备份与恢复演练
生产数据库 SHALL 同时具备 Neon 时间点恢复与每日逻辑备份。逻辑备份 MUST 以只读角色生成、上传前加密，并存放在开启对象锁定或等效不可篡改保护的独立存储中，保留期限有文档说明。备份任务失败 MUST 产生可见告警。上线前及之后每季度 SHALL 各完成一次恢复演练：分别从时间点恢复与逻辑备份恢复到临时目标，运行校验并记录 RTO / RPO，且 MUST NOT 覆盖生产主分支。

#### Scenario: 每日逻辑备份
- **WHEN** 每日备份任务运行
- **THEN** 存储中新增一份加密备份，明文与数据库凭据不出现在日志或制品中

#### Scenario: 备份失败
- **WHEN** 备份任务无法连接数据库或上传失败
- **THEN** 任务失败并通知维护者，已有备份不被删除或覆盖

#### Scenario: 恢复演练
- **WHEN** 维护者执行恢复演练
- **THEN** 临时目标的迁移记录、关键表行数与积分对账不变式校验通过，生产主分支不受影响，结果记录 RTO / RPO

### Requirement: 迁移不长时间阻塞线上流量
生产与 staging 迁移 SHALL 设置锁等待超时与语句超时，拿不到锁时迁移失败而不是排队阻塞线上查询。CI SHALL 检查新增迁移，含有在已有表上非并发建索引、直接添加无默认值的非空列、会重写整表的类型变更等写法时 MUST 失败，除非该迁移带有说明原因的显式豁免标注。

#### Scenario: 迁移遇到长事务
- **WHEN** 生产迁移需要的表锁被一个长事务占用超过锁等待超时
- **THEN** 迁移失败，线上查询不被阻塞，后续部署步骤不执行

#### Scenario: 提交危险迁移
- **WHEN** PR 新增一条在已有表上 `CREATE INDEX`（非 `CONCURRENTLY`）的迁移且没有豁免标注
- **THEN** CI 失败并指出该语句

### Requirement: 回滚前检查 schema 兼容
对旧版本 tag 手动触发的生产回滚 SHALL 在部署前确认目标版本声明兼容当前生产数据库的 schema 版本；目标版本未声明兼容时 MUST 在部署前失败，并提示改用向前修复。

#### Scenario: 回滚到不兼容的版本
- **WHEN** 生产已应用新增非空列的迁移，维护者尝试回滚到不认识该列的旧 tag
- **THEN** 流水线在部署前失败，生产继续运行当前版本

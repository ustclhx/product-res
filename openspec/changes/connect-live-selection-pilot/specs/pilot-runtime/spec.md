## Purpose

为一个合作团队和内部团队提供可控的真实试点运行环境，使身份、数据空间、外部任务和部署状态可核验，并保留离线演示而不将样例混入真实业务或影响同机现有服务。

## ADDED Requirements

### Requirement: Authenticated isolated workspaces
pilot 系统 SHALL 从已认证会话确定成员、工作区和项目权限，拒绝客户端伪造身份和跨工作区访问；来源凭据、任务和附件 SHALL 遵守相同隔离边界。登录 SHALL 防暴力尝试，会话可撤销，写操作校验请求来源。

#### Scenario: Member guesses another workspace candidate
- **WHEN** 合作团队成员请求内部团队候选或任务 ID
- **THEN** 系统拒绝访问，不泄露对象内容，也不创建跨工作区命令回执

#### Scenario: Client forges decision owner
- **WHEN** 已登录分析成员发送其他负责人的 actor_id
- **THEN** 系统拒绝该身份声明，不执行批准

### Requirement: Separate demonstration and pilot modes
系统 SHALL 区分演示与试点的数据、时钟和行为；真实工作区使用实际 UTC 时间且不能初始化或重置示例。演示数据 SHALL 不因模式切换变成真实数据。

#### Scenario: Attempt demo reset in pilot
- **WHEN** 用户或脚本在 pilot 工作区请求示例重置
- **THEN** 请求被拒绝，真实业务数据保持不变

### Requirement: Durable bounded external jobs
外部采集和模型调用 SHALL 以可查询的持久任务执行，具有输入版本、执行尝试、超时、取消、受控重试和重启恢复。重复命令或 worker 重复交付 SHALL 不产生重复业务结果；过期输入输出不能覆盖当前业务。

#### Scenario: Worker restarts after external dispatch
- **WHEN** 任务已外发但无法确认远端执行结果时 worker 重启
- **THEN** 系统标记结果未知，保留尝试记录，不自动重复可能计费的请求

#### Scenario: Inputs change during model execution
- **WHEN** 模型执行期间证据被替代
- **THEN** 旧输入输出只作为历史结果保留，显示需重新整理，不能自动采用为当前评估

### Requirement: Server controlled credentials and limits
系统 SHALL 使用服务端受限凭据引用，明确未配置、权限失败、额度不足和执行失败；凭据 SHALL 不出现在前端、日志或业务导出。来源与模型调用必须有请求和并发上限，不能自动购买或充值。

#### Scenario: Provider credential is absent
- **WHEN** 用户选择尚未配置凭据的真实来源
- **THEN** 系统说明未配置并提供人工导入入口，不发外部请求、不返回伪装成真实的样例

### Requirement: Independent ECS deployment and recovery
试点 SHALL 支持在指定 ECS 独立发布、健康检查、备份恢复和回滚，不覆盖现有 d2market 服务、端口或数据库；团队公网访问 SHALL 具备 HTTPS 和登录。本轮受控团队试用可使用经授权 SSH 隧道及 loopback HTTP，后续 Cloudflare 子域名公网接入仍须 HTTPS。发布状态必须区分本地通过、ECS通过和已验证成员可访问。

#### Scenario: Port or capacity conflict before release
- **WHEN** 预检发现目标端口被占用或资源不足
- **THEN** 部署停止在启动新负载之前，保留现有服务及检查结果

#### Scenario: Restore a pilot backup
- **WHEN** 在隔离目录恢复经验证的备份
- **THEN** 候选、批准、任务、结果和回执一致，未完成任务可按执行状态恢复且不重放已确认外部调用

#### Scenario: Operator reconciles a confirmed external result
- **WHEN** 运营人员取得与原 DataForSEO 结果未知任务匹配的官方成功记录及原查询结果
- **THEN** 系统仅在工作区、分析负责人权限、当前输入版本、任务 ID、查询条件及执行时间校验通过后幂等恢复原任务的发现批次，保留超时尝试和恢复审计，不重发查询，原费用与免费恢复费用分开记录

# system-health Specification

## Purpose

提供可被外部探活与部署冒烟测试使用的健康检查，反映 Web Worker、数据库连通性与后台 Worker 的可用状态。

## Requirements

### Requirement: 健康检查端点
系统 SHALL 提供无需认证的 GET /api/health，包含数据库耗时与构建期确定的版本。Cloudflare 保留数据库可达时 200、不可达时 503，CI 完整 SHA、本地短 SHA/无 Git 回退包版本的兼容行为；Node 本地/CI/镜像均 MUST 使用完整 git SHA，必需依赖不可用返回 503。所有响应 MUST 脱敏且包含 version。（O2）

#### Scenario: 数据库正常
- **WHEN** 探活请求 Cloudflare health 且数据库可达
- **THEN** 返回 200，包含 db.latencyMs 与 version

#### Scenario: 数据库不可达
- **WHEN** 数据库连接失败或超过 5 秒探测上限
- **THEN** 返回 503 并标明数据库不可用，不泄露连接串或主机名

#### Scenario: 区分部署版本
- **WHEN** CI 以完整 commit SHA 构建并部署 web
- **THEN** health 无论 200 或 503 的 version 都等于该完整 SHA

#### Scenario: Node 本地完整版本
- **WHEN** 在本地 Git checkout 构建 Node web 或从归档显式提供合法完整 APP_VERSION
- **THEN** health version 为完整 40 位 SHA，不能回退短 SHA 或包版本

### Requirement: 健康检查不受缓存影响
健康检查的数据库探测 MUST 使用不带查询缓存的数据库连接，使返回结果反映数据库的实时可达性。

#### Scenario: 缓存连接仍有旧结果
- **WHEN** 数据库刚刚停止，而带缓存的连接上仍存有之前的查询结果
- **THEN** 健康检查仍返回 503

### Requirement: 后台 Worker 心跳
后台任务运行时的定时任务 SHALL 在成功运行后记录时间，health SHALL 保留 jobs.lastCronAt；超过两个心跳调度周期未成功时 SHALL 能被判断为停摆。Node 未装配 scheduler 时 MUST 明确 unavailable 并保留空时间，不伪造成功。（O2，J3 的执行实现由 B 提供）

#### Scenario: 定时任务正常
- **WHEN** 定时任务按计划成功写库
- **THEN** jobs.lastCronAt 更新为该次时间

#### Scenario: 定时任务停摆
- **WHEN** 定时任务超过两个心跳周期未成功
- **THEN** 时间早于两个周期前，探活可告警且 Node readiness 返回 503

#### Scenario: B 尚未实现
- **WHEN** Node 无 scheduler 实现
- **THEN** 报告 unavailable 与 jobs.lastCronAt=null，不更新虚假心跳

### Requirement: Node 依赖健康状态
Node health SHALL 报告实时数据库、缓存、队列及 scheduler 状态和最近成功 cron 时间；成功依赖为 up，故障为 down，未装配为 unavailable。仅全部必需依赖正常且心跳有效时返回 200，其他情况返回 503；MUST 不以数据库可达替代队列/消费者就绪。（O2）

#### Scenario: 真实依赖就绪
- **WHEN** B 队列消费者与调度器装配且 DB/缓存/队列探测与心跳正常
- **THEN** health 返回 200，包含完整 SHA、db/cache/queue 状态及 jobs.lastCronAt

#### Scenario: 缓存或队列故障
- **WHEN** DB 正常但缓存或队列探测失败
- **THEN** health 返回 503，分别标记失败组件，仍有 version 和已知心跳字段

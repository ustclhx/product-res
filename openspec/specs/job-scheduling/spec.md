# job-scheduling Specification

## Purpose
定义可选 Node 自托管 jobs 的持久定时调度，确保时区、同一定时任务的互斥与停机后补跑策略可预测，并保留健康检查中的成功运行时间，供单机部署和每日长时采集任务可靠使用。

## Requirements

### Requirement: jobs 内的时区 Cron（J1）
Node 目标 SHALL 在 jobs 进程内根据 cron 表达式与明确的 IANA 时区调度；配置 Asia/Singapore 时 MUST 按该时区执行。运行记录 SHALL 使用 UTC 时间；处理器 SHALL 获得原计划时间，重试/补跑 MUST NOT 改写为实际重试时间。

#### Scenario: 新加坡每日采集
- **WHEN** 调度配置 `0 2 * * *` 与 Asia/Singapore
- **THEN** 每日在新加坡当地 02:00 启动，对应前一 UTC 日 18:00，记录可核对的原计划时间

#### Scenario: 非法配置
- **WHEN** 启动时任务的 cron 或时区非法
- **THEN** 配置校验失败并指出参数名称，进程不以隐式宿主时区继续调度

### Requirement: 双实例定时任务互斥（J2）
同一 Node 定时任务 SHALL 在两个 jobs 实例间去重领取同一计划时间，且整个运行期间 MUST 不并发执行该定时任务的另一个实例；跨下一个计划时间的长任务仍 MUST 互斥。故障恢复 SHALL 延续原运行身份，业务副作用 SHALL 保持幂等。

#### Scenario: 两实例同时调度
- **WHEN** 两个 jobs 同时遇到同一定时任务的同一计划时间
- **THEN** 只形成一次运行，两个实例的业务执行计数合计为一次

#### Scenario: 长任务跨下一个触发点
- **WHEN** 一个任务运行尚未完成又到达下一计划时间
- **THEN** 第二次运行不与第一次重叠，错过的计划按该任务补跑策略处理

### Requirement: 可配置错过运行策略（J2）
Node 调度 SHALL 支持每任务 `skip` 或 `once` 补跑策略，默认 skip。恢复时 skip SHALL 丢弃错过的计划并等待下一次，once SHALL 将错过的多个计划合并为最近一次计划的一个补跑；两个实例恢复 MUST 不重复补跑。已领取未完成的任务 MUST 继续恢复而非被 skip 丢弃。

#### Scenario: 跳过停机期间运行
- **WHEN** skip 任务在停机期间错过三个计划时间后恢复
- **THEN** 不执行这三个计划，下一正常计划可以执行

#### Scenario: 双实例补跑一次
- **WHEN** once 任务错过三个计划时间后两个 jobs 同时恢复
- **THEN** 只创建最近错过计划的一个补跑，保留该计划时间，不逐个回放历史运行

#### Scenario: 恢复未完成运行
- **WHEN** skip 任务已开始但中途 jobs 重启
- **THEN** 恢复原未完成运行，不把它当作尚未领取的错过计划丢弃

### Requirement: 成功心跳可观察（J3）
Node 目标 SHALL 保留既有五分钟 heartbeat 的成功路径，将实际成功时间持久写入 `jobs.lastCronAt`，健康检查 SHALL 无缓存返回 ISO UTC 时间或未运行时的 null。失败或仅进程存活 MUST 不推进成功时间；各定时任务 SHALL 保留可查询的计划时间和运行结果。

#### Scenario: 心跳成功与停摆
- **WHEN** heartbeat 成功执行后停止 jobs 超过两个五分钟周期
- **THEN** 健康检查仍返回上次成功的旧时间，可由探活判断停摆，而非更新时间为请求时间

#### Scenario: 删除缓存补偿失败
- **WHEN** 既有五分钟任务的前置删除凭据缓存补偿失败
- **THEN** 本次任务报告失败，不写入新的成功心跳时间

### Requirement: 既有五条定时触发行为一致
Node 目标 SHALL 保留现有五条触发器的业务映射、独立子任务的失败处理和原计划时间。默认时区 MUST 维持 UTC，用户可显式配置其他时区；Cloudflare Cron Triggers 的既有配置及发布 MUST 保持。

#### Scenario: 每日指标补跑
- **WHEN** 每日 03:00 的任务在晚些时候按原计划时间补跑
- **THEN** 空间清理与日指标均被独立尝试，指标聚合原计划时间对应的前一 UTC 日，重复运行覆盖结果而不累计

#### Scenario: 十分钟维护部分失败
- **WHEN** 十分钟维护中的计费恢复或文件清理之一失败
- **THEN** 另一个仍被尝试执行，最终该次调度报告失败

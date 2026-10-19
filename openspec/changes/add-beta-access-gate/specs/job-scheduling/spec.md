## ADDED Requirements

### Requirement: 数据流水线定时计划可暂停
系统 SHALL 支持可选环境变量 DATA_PIPELINE_SCHEDULES；取值为 `paused` 时，数据层每日流水线、选品每日 / 打标签 / 准备度与回看提醒定时计划 MUST 仍注册，但每次触发直接返回并记录 `pipeline.paused` 日志；空串或未设置时照常运行。暂停 MUST NOT 影响调度器健康检查、就绪门、预扣对账计划和手动触发入口。

#### Scenario: 暂停时到点触发
- **WHEN** DATA_PIPELINE_SCHEDULES=paused，selection-daily-v1 到点触发
- **THEN** 不执行选品流水线，记录 pipeline.paused 与计划 ID，运行视为成功

#### Scenario: 未设置
- **WHEN** DATA_PIPELINE_SCHEDULES 为空或未设置
- **THEN** 所有计划按原逻辑执行

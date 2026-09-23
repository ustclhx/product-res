# validation-tasks Specification

## Purpose

把获批候选的待验证问题变成有负责人、期限和完成条件的具体任务，收集询价、样品与小测的结果并支持下一步判断。任务跟踪不等同于自动执行外部业务或证明商品成功。

## Requirements

### Requirement: Actionable validation plan
系统 SHALL 对获批候选建立验证计划，任务关联批准评估，包含验证问题、任务类型、负责人、期限、完成条件及预期指标。支持询价、样品、小测三种任务；任务自身不执行外部商业动作。

#### Scenario: Create sample validation task
- **WHEN** 分析人员为获批候选创建样品任务并填写完成条件
- **THEN** 负责人在任务列表看到候选、问题、期限和条件，且能返回原批准依据

### Requirement: Task progress and result checks
系统 SHALL 区分待处理、进行中、受阻、已完成、已取消；逾期单独显示。完成任务 SHALL 要求结果、证据/记录及达成情况；取消或受阻 SHALL 要求原因。任务完成 SHALL 不被自动标为商业成功。

#### Scenario: Finish test that failed its target
- **WHEN** 负责人录入有效测试结果但指标未达到目标
- **THEN** 任务可标记已完成，结论显示未达目标，候选保留待决策下一步而非成功状态

### Requirement: Explicit validation conclusion and outcome handoff
系统 SHALL 要求决策负责人依据任务结果明确继续验证、进入结果跟进或停止；已批准候选无论是否上市 SHALL 保留结果义务，未上市可记录“未开展经营/停止原因”。

#### Scenario: All tasks done without conclusion
- **WHEN** 全部验证任务完成但负责人尚未作验证结论
- **THEN** 系统显示待决策，不自动关闭候选或取消结果跟进

#### Scenario: Stop before launch
- **WHEN** 负责人决定停止且记录原因
- **THEN** 系统保留验证结果并进入可填写未上市结果的复盘入口，不虚构零销量或零成本

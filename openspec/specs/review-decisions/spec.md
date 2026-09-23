# review-decisions Specification

## Purpose

让决策负责人在明确的材料和版本基础上选择批准验证、退回补证、观察或否决，并保留每次决定的理由与操作者，使返工、例外和重新审阅成为可追溯流程而不是覆盖历史。

## Requirements

### Requirement: Four explicit human decisions
系统 SHALL 允许决策负责人对当前有效提交选择批准验证、退回补证、观察、否决；每项决定 SHALL 保存理由、操作者、时间、所审评估及标准版本。退回 SHALL 指明需补的材料或问题。

#### Scenario: Approve current evaluation
- **WHEN** 决策负责人填写理由并批准当前有效提交
- **THEN** 候选进入验证准备，创建结果跟进义务，不自动下单、上架或投放

#### Scenario: Return for evidence
- **WHEN** 负责人指定需补证问题后退回
- **THEN** 分析人员看到明确待办，补证并重新评估后可再次提交，原退回记录保留

### Requirement: Decision history and reopening
系统 SHALL 追加决策事件而非覆盖历史；观察或否决后的候选 SHALL 支持由决策负责人填写原因重新打开，重新打开后需重新满足提交条件。

#### Scenario: Reopen rejected candidate
- **WHEN** 新证据出现后决策负责人说明原因并重新打开
- **THEN** 候选回到准备阶段，原否决仍可查看，不直接沿用旧批准或跳过人审

### Requirement: Safe retries and conflict handling
系统 SHALL 对重复提交同一业务命令返回同一结果，对相同请求标识但不同内容拒绝；并发决定 SHALL 校验预期版本，一次只接受一个合法迁移。

#### Scenario: Approval request retried
- **WHEN** 同一批准因网络重试被发送两次
- **THEN** 系统只有一条批准事件和一份结果跟进义务

#### Scenario: Two reviewers use stale view
- **WHEN** 一项决定已生效，另一个基于旧版本的决定到达
- **THEN** 系统返回冲突并要求刷新，不覆盖已记录决定

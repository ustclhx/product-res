# evidence-screening Specification

## Purpose

让每项初筛结论能够追溯至具体来源、采集时间和已确认的规则，并把缺失、过期、冲突及估算与已核验事实区分开，避免数据不足被错误解释为商品不符合条件。

## Requirements

### Requirement: Traceable evidence and data quality
系统 SHALL 为证据保留候选、字段/主张、值和单位、币种/窗口、来源定位、观察与录入时间、事实/估算/假设分类、核验状态、版本和独立样例标记；缺失、过期和冲突 SHALL 明示。

#### Scenario: Replace outdated supplier quote
- **WHEN** 用户录入新报价替换过期报价
- **THEN** 系统生成新证据版本，旧评估仍可查看原报价，当前初筛提示需要重算

### Requirement: Deterministic screening on eligible inputs
系统 SHALL 仅使用已确认规则及符合规则质量/时效/单位要求的已核验事实作硬排除；估算、假设、缺失、过期或冲突输入 SHALL 产生补证需求。筛选结果 SHALL 显示规则、输入版本和原因，且初筛通过不等于批准验证。

#### Scenario: Verified MOQ exceeds confirmed limit
- **WHEN** 有效、已核验 MOQ 为 500，已确认上限为 200
- **THEN** 系统记录该规则失败并排除候选，展示 500、200、证据及标准版本

#### Scenario: Missing or estimated MOQ
- **WHEN** MOQ 缺失、过期、冲突或仅为估算
- **THEN** 系统要求补证且不自动排除，不将未知替换为零

### Requirement: Human restoration without rewriting results
系统 SHALL 允许决策负责人对规则排除作带原因的例外恢复，保存原排除、恢复人和原因。恢复 SHALL 不自动批准验证，也不豁免未解决的必填证据。

#### Scenario: Restore excluded candidate
- **WHEN** 决策负责人填写原因后恢复候选
- **THEN** 候选返回可准备评估的状态，保留原排除与例外标记；未填原因的恢复被拒绝

### Requirement: Supplemental evidence ownership
系统 SHALL 允许为缺口指定补证负责人和截止日，录入证据后重新检查缺口而非仅凭任务勾选认定完整。

#### Scenario: Task checked but evidence missing
- **WHEN** 参与人尝试在无有效证据时完成必填补证项
- **THEN** 系统仍显示未解决缺口并阻止按完整材料提交

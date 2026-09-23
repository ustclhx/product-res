# selection-projects Specification

## Purpose

让有跨境经验的团队用业务语言定义一次选品的目标、渠道、标准和责任人，并在后续评估和复盘中找回当时确认的标准，避免用变化后的口径解释旧决策。

## Requirements

### Requirement: Channel-specific project setup
系统 SHALL 支持 Amazon、eBay、独立站三种项目模板，共用固定阶段，配置渠道、市场、方向、目标、约束、分析负责人和决策负责人。必填材料及适用成本字段 SHALL 随模板变化。

#### Scenario: Create independent-store project
- **WHEN** 用户选择独立站模板并填写必要信息
- **THEN** 项目呈现独立站的流量/获客及履约字段，不强制填写 ASIN 或 FBA 字段，展示后续固定阶段

#### Scenario: Required owner missing
- **WHEN** 用户未指定分析或决策负责人而尝试确认项目标准
- **THEN** 系统指出缺失项并保留草稿，不进入候选筛选

### Requirement: Confirmed and immutable criteria versions
系统 SHALL 允许修改硬规则、必填证据、负责人及期限；硬规则和必填证据 SHALL 经决策负责人确认后形成不可覆盖的标准版本。系统 SHALL 不提供任意步骤编排。

#### Scenario: Change criteria after evaluation
- **WHEN** 已有评估的项目确认新标准
- **THEN** 系统创建新版本，旧评估继续引用旧版本，当前候选显示需按新标准重新评估

### Requirement: Demonstrated role responsibilities
系统 SHALL 在原型中提供明确的参与人及角色切换，区分分析、决策、补证职责并在业务服务中检查操作角色；界面 SHALL 标明这是角色演示而非登录或生产权限。

#### Scenario: Analyst attempts approval
- **WHEN** 分析人员尝试批准候选验证或确认标准
- **THEN** 系统拒绝该动作并显示需要决策负责人，历史记录不发生变化

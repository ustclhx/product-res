# candidate-evaluation Specification

## Purpose

帮助分析人员把需求、竞争、差异化、供给成本和风险组织为可复核的判断，同时呈现反证、未知与假设。节点 AI 只辅助整理和解释，评估快照为人工决策和后续结果对照提供依据。

## Requirements

### Requirement: Multidimensional evaluation snapshot
系统 SHALL 展示需求、竞争、差异化、供应成本及风险五类评估，关联证据、假设、反证与未知，并保存所用标准、证据和模拟 AI 版本。预测成本等数值 SHALL 标注口径与来源，不以单一总分替代决策。

#### Scenario: Incomplete optional dimension
- **WHEN** 非必填的竞争数据缺失
- **THEN** 评估显示未知和影响，不生成伪精确得分，已具备的其他维度仍可查看

### Requirement: Bounded simulated AI assistance
系统 SHALL 在补证、评估和复盘节点提供带“模拟 AI”标记的结构化整理结果；每条事实性解释 SHALL 引用当前输入证据，建议与事实分离。无法校验的引用和无效输出 SHALL 被拒绝，不推进业务状态。

#### Scenario: AI cites nonexistent evidence
- **WHEN** 模拟输出引用不存在或其他候选的证据
- **THEN** 系统显示分析失败或需人工整理，保留输入和失败原因，不将输出存为有效评估

#### Scenario: AI suggests approval
- **WHEN** 模拟 AI 建议进入验证
- **THEN** 系统只展示建议，候选仍需人工提交及决策负责人批准

### Requirement: Submission readiness and frozen versions
系统 SHALL 在必填材料有效、标准已确认、硬排除已解除或有有效例外时允许分析人员提交评估。提交 SHALL 冻结当前评估版本；后续证据或标准变化需新评估，不覆盖旧提交。

#### Scenario: Stale submitted inputs
- **WHEN** 提交后必填证据或标准发生变化，负责人尝试批准旧提交
- **THEN** 系统指出版本失效并要求重新评估/提交，不批准过期快照

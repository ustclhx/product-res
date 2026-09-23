## MODIFIED Requirements

### Requirement: Multidimensional evaluation snapshot
系统 SHALL 展示需求、竞争、差异化、供应成本及风险五类评估，关联证据、假设、反证与未知，并保存所用标准、证据和所用 AI 版本及模拟/真实标记。预测成本等数值 SHALL 标注口径与来源，不以单一总分替代决策。

#### Scenario: Incomplete optional dimension
- **WHEN** 非必填的竞争数据缺失
- **THEN** 评估显示未知和影响，不生成伪精确得分，已具备的其他维度仍可查看

### Requirement: Bounded simulated AI assistance
系统 SHALL 在补证、评估和复盘节点提供结构化整理结果：演示输出带“模拟 AI”标记，试点输出带真实模型来源及待人工复核标记；每条事实性解释 SHALL 引用当前输入证据，建议与事实分离。无法校验的引用和无效输出 SHALL 被拒绝，不推进业务状态。

#### Scenario: AI cites nonexistent evidence
- **WHEN** 任一模式输出引用不存在或其他候选的证据
- **THEN** 系统显示分析失败或需人工整理，保留输入和失败原因，不将输出存为有效评估

#### Scenario: AI suggests approval
- **WHEN** AI 建议进入验证
- **THEN** 系统只展示建议，候选仍需人工提交及决策负责人批准

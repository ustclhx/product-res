## Purpose
让业务人员能够辨认 AI 草稿是否仍对应当前材料、标准或结果，保留历史与人工修订，避免把过期整理当成当前结论；继续以服务端校验和人工复核保护正式评估。

## ADDED Requirements
### Requirement: Live freshness and guarded adoption
系统 SHALL 在读取草稿时反映输入变化并解释失效原因，不修改历史输入输出；无法核验的真实草稿 MUST 不可直接采用。

#### Scenario: Evidence changes after generation
- **WHEN** 新材料替代旧材料，或证据到期、标准或人审问题变化
- **THEN** 候选和任务读取显示旧稿过期及原因，正式采用被拒绝

#### Scenario: Review uses frozen approval
- **WHEN** 阅读结果复盘草稿
- **THEN** 时效依据所选结果及批准快照，而不是把当前补证混入原批准依据

### Requirement: Latest available draft and preserved manual work
页面 SHALL 优先显示最新成功且未过期草稿，保留历史；复制后输入失效 MUST 提示重新核对并阻止携带旧来源保存，不清空人工输入或静默移除来源。

#### Scenario: Newer failed run
- **WHEN** 最近运行失败但存在有效旧稿
- **THEN** 有效稿仍可查看，失败状态单独显示，过期稿不可复制采用

## MODIFIED Requirements

### Requirement: Persistent and clearly marked demonstration
演示模式 SHALL 为 Amazon、eBay、独立站提供可重复样例，全局及数据/AI 输出均标识示例或模拟；保存操作到本地持久化存储，刷新和重启不丢记录。重置 SHALL 明确确认范围并仅重置当前示例工作区。

#### Scenario: Refresh after review
- **WHEN** 负责人作出决定后刷新页面或重启本地服务
- **THEN** 相同候选、决定、版本和任务仍可查看，不恢复成初始演示状态

#### Scenario: Reset demonstration
- **WHEN** 用户确认重置示例工作区
- **THEN** 系统恢复指定样例版本并明确用户录入的演示数据将被清除，不影响源码、研究文档或其他工作区

#### Scenario: Open a real pilot workspace
- **WHEN** 已登录用户打开试点工作区
- **THEN** 界面明确工作区与真实/测试数据状态，不提供模拟角色切换或示例重置，后台任务使用业务语言展示进展

## ADDED Requirements

### Requirement: Two team data loop acceptance
试点 SHALL 对合作团队与内部自建站团队分别保留从真实来源、补证、AI草稿、人审、验证到真实结果或未上市原因、反馈及新项目标准的追溯记录。工程联调与真实试点 SHALL 分开验收，不设人工工时改进比例或盈利门槛；尚缺真实材料时不得将试点标记完成。

#### Scenario: Confirm a next round criterion from pilot results
- **WHEN** 负责人依据已回填结果或明确未上市原因确认标准反馈并创建下一轮项目
- **THEN** 可从新标准追溯实际结果、验证、原批准和市场来源，历史决定不变，记录工时但不因无效率基线拒绝流程验收

#### Scenario: Only test fixtures have completed
- **WHEN** 契约和浏览器测试通过但尚无团队真实结果材料
- **THEN** 系统与交付记录只声明工程验证通过，真实试点验收保持待完成

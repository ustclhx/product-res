# prototype-experience Specification

## Purpose

为非技术业务人员提供以项目、候选和任务为中心的可操作原型，确保样例与真实数据含义清晰、操作能够保存和复盘，并为后续团队验证准备观察记录而不预先宣称业务价值。

## Requirements

### Requirement: Business-first navigation and states
系统 SHALL 提供工作台、选品项目、验证任务入口；工作台优先展示待补证、待决策、逾期及待结果。关键页面 SHALL 展示下一步、负责人、阻塞理由，以及加载、空、失败、过期和可重试状态。关键动作 SHALL 支持键盘并不只依赖颜色识别状态。

#### Scenario: Open returned candidate
- **WHEN** 分析人员从工作台打开退回候选
- **THEN** 首先看到需补的问题、负责人和下一步，并能查看原评估、证据与退回理由，无需对话提示词

### Requirement: Persistent and clearly marked demonstration
系统 SHALL 为 Amazon、eBay、独立站提供可重复样例，全局及数据/AI 输出均标识示例或模拟；保存操作到本地持久化存储，刷新和重启不丢记录。重置 SHALL 明确确认范围并仅重置当前示例工作区。

#### Scenario: Refresh after review
- **WHEN** 负责人作出决定后刷新页面或重启本地服务
- **THEN** 相同候选、决定、版本和任务仍可查看，不恢复成初始演示状态

#### Scenario: Reset demonstration
- **WHEN** 用户确认重置示例工作区
- **THEN** 系统恢复指定样例版本并明确用户录入的演示数据将被清除，不影响源码、研究文档或其他工作区

### Requirement: Deterministic end-to-end acceptance
系统 SHALL 在无真实数据商、店铺或模型密钥的情况下完成两种入口到结果反馈的演示，并覆盖退回重提、未知不排除、人工恢复、重复提交、失败重试及刷新恢复。

#### Scenario: Offline provider demo
- **WHEN** 使用已安装依赖但不配置任何外部 API 密钥运行验收
- **THEN** 所有声明的业务链路使用确定性示例执行，未覆盖方向明确告知无样例，不发起外部商业动作

### Requirement: Honest value-validation preparation
系统 SHALL 保存关键步骤的操作者、动作、时间及版本，并允许记录核验/补证/纠错等人工工时与试用反馈。操作间隔 SHALL 不被当作人工投入；示例记录 SHALL 不进入真实效率结果。

#### Scenario: No baseline for efficiency
- **WHEN** 尚无人工流程基线或只有示例工时
- **THEN** 系统展示待验证状态，不生成“节省工时比例”或“提高选品成功率”结论

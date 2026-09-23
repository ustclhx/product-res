# 集成审查记录

独立只读审查与 supervisor 接口/页面核对后，以下问题已修复并增加回归：

| 问题 | 修正 | 验证 |
| --- | --- | --- |
| 新证据替代后 AI 草稿保留旧引用 | 新草稿只列当前证据，复制模拟输出时替换引用和未知项；历史快照不变 | 浏览器退回→补证→模拟整理→重评→重提→批准 |
| 退回后直接重提旧评估 | 要求新 EvaluationRevision，原退回决定和问题保留 | test_evidence_review |
| 观察窗口尚未结束就完成复盘 | OUTCOME_WINDOW_OPEN，保留 OUTCOME_PENDING | test_lifecycle |
| 已提交的失败节点请求无回执 | 持久化错误结果和幂等回执，相同请求重放 | test_foundation |
| 预测与实际窗口结构不同 | 统一 UTC 起止时间、币种、GROSS/NET 与成本字段 | lifecycle 与集成测试 |
| 真实零销量被拒绝 | 允许保存 0，贡献利润标记 ZERO_UNITS 不可比 | test_lifecycle |
| 反馈可确认非法规则 | 结构、操作符与有限数值校验 | test_lifecycle / test_foundation |
| 同来源不同结果被当成重复静默忽略 | 409 OUTCOME_SOURCE_CONFLICT，明确新来源版本 | test_lifecycle |
| 手工起步工作区无法观察工时 | 无需样例初始化即可显示业务与录入工时 | test_demo |
| CSV 畸形端口/地址可能报 500 | 返回业务输入错误，不写入 | test_project_intake |

前端按最终接口重新对齐：项目版本、全量规则、CSV 行映射、候选来源、当前与批准标准区分、任务证据勾选、合法状态迁移、带时区日期、结果版本与反馈新项目入口。文件级 ESLint 屏蔽已移除。

数据与 AI 都是原型模拟能力；以上验证证明本地工作流实现与契约行为，不证明真实市场覆盖、节省工时或经营收益。

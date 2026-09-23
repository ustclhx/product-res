## Purpose
为采购协作人员提供围绕缺失字段、责任人和证据来源的补证工作台，明确正式报价、公开参考价格以及 OEM 不同准备阶段的材料边界，支持线上商品线索与线下厂商录入并保持历史可追溯。

## ADDED Requirements
### Requirement: Structured sourcing evidence
系统 SHALL 提供报价、售价与车型适配专用表单；保存来源、观察时间、核验依据、单位及不可变版本，拒绝无口径或非法数值，保护并发与工作区隔离。
#### Scenario: Offline supplier quote
- **WHEN** 成员录入线下供应商正式报价、MOQ、数量单位及核验依据
- **THEN** 保存来源记录及对应证据；任务和采购批准不会自动完成
#### Scenario: Public reference
- **WHEN** 用户录入商品页参考价或目标售价
- **THEN** 其不得成为已核验采购成本或实际售价
#### Scenario: Physical compatibility
- **WHEN** 仅完成桌面检查而尚无实车样品测试
- **THEN** 系统不得把车型适配视为已验证通过

### Requirement: Evidence workbench and stage readiness
系统 SHALL 展示每个字段的当前质量、处理责任、期限和下一步；OEM 研究、打样、上市准备要求分开显示，正式初筛标准不被隐式修改。
#### Scenario: Unlisted OEM research
- **WHEN** OEM 处于研究准备阶段
- **THEN** 突出参考报价、MOQ、目标价、桌面适配，实际售价与实车适配列为后续阶段；研究材料齐全不等于采购批准
#### Scenario: Revision and stale evidence
- **WHEN** 有证据被替代、过期或存在冲突
- **THEN** 页面即时反映当前缺口并保留历史，不按旧初筛结果声称材料可用

### Requirement: Honest domestic source access
系统 SHALL 识别支持的国内商品链接并允许人工录入线上材料或线下厂商；未获授权的官方连接不得宣称已接通。
#### Scenario: 1688 link without credentials
- **WHEN** 用户粘贴支持的 1688 商品链接
- **THEN** 只自动识别平台和商品编号，显示详情接入尚需授权，价格 MOQ 等仍由来源材料录入

### Requirement: Research task completion retains uncertainty
系统 SHALL 允许 OEM 研究阶段的参考价、参考 MOQ 和目标价任务，依据当前无冲突且未过期的研究材料完成资料收集；证据仍保留未核验或估算状态。
#### Scenario: Complete reference collection
- **WHEN** 负责人引用当前参考报价并记录完成结果
- **THEN** 任务可标记完成研究资料收集，正式成本、初筛及采购批准不被提升

### Requirement: Vehicle evidence follows target configuration
系统 SHALL 拒绝把其他目标配置的实车测试记录标为已核验适配；变更目标车辆配置 SHALL 撤回原适配证据的当前有效性并保留历史。
#### Scenario: Change target seats after testing
- **WHEN** 已有实车适配结果后变更座椅配置
- **THEN** 当前适配恢复待核验，原结果仍可追溯

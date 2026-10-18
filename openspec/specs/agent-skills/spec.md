# agent-skills Specification

## Purpose

为本模板提供能够依据仓库真实入口执行的项目级 Agent Skills，使使用者在 Codex 与 Claude 中获得一致的启动、部署准备与业务扩展流程，并能区分已验证结果、所需外部授权和未完成验收。

## Requirements

### Requirement: 双目录技能入口
系统 SHALL 提供 quick-start、deploy-cloudflare、deploy-selfhost、new-page、new-module、new-static-page、add-ai-model、security-scan；每个技能 SHALL 有 name/description 和可执行步骤、真实命令、验收条件、常见故障，两处目录内容 MUST 完全一致。

#### Scenario: 两种 agent 使用同一技能
- **WHEN** 使用者分别读取 `.agents/skills` 与 `.claude/skills` 下同名技能
- **THEN** 获得逐字节一致的指导，且引用能在项目中解析

### Requirement: 启动选项与配置归属
quick-start SHALL 收集名称、域名、目标、功能开关和默认语言，运行非交互生成与安装/类型/单元自检，并指导本地数据库、迁移、管理员和首次 AI 调用；外部服务 key SHALL 列出获取入口与模板配置、运行时设置、secret 三层归属。

#### Scenario: 关闭计费的团队工具
- **WHEN** 使用者选择关闭 billing 与 AI、selfhost、单语言
- **THEN** 生成器收到相应显式参数，流程跳过支付 seed 与 AI 调用并说明开关约束

#### Scenario: AI 缺少授权或凭据
- **WHEN** 生成完成但 AI 凭据、模型套餐授权或余额不足
- **THEN** 流程标记首次 AI 调用未验收，给出对应配置入口，不伪造调用成功

### Requirement: 部署先预检再授权
部署技能 SHALL 默认只读预检并支持环境、域名与管理员输入；Cloudflare 支持 --env/--domain/--admin-email，selfhost 使用同 SHA 发布集合与 bundle。任何资源创建、配置写入、secret、迁移或部署 MUST 先列出具体动作并取得覆盖这些动作的明确确认；重复执行 SHALL 复核已有资源并跳过匹配项，冲突 MUST 停止。

#### Scenario: 默认请求部署
- **WHEN** 使用者调用部署技能但未批准具体写入动作清单
- **THEN** 只报告资源、配置缺口和 dry-run 结果，不创建资源、不迁移、不写 secrets、不发布

#### Scenario: 已有资源重复执行
- **WHEN** 名称、ID、环境和用途与已确认的部署清单一致
- **THEN** 复用资源；不同或无法核实时请求处理冲突，不覆盖或删除

### Requirement: 业务扩展沿用模板边界
页面与模块技能 SHALL 复用既有鉴权、后台操作、表格、语言、错误、日志和租户查询模式，优先复用现有数据表与模块；静态页 SHALL 提供语言与 SEO；AI 技能 SHALL 优先用后台参数 schema 配置，新增 Provider 才扩展既有能力接口。

#### Scenario: 新增租户页面和服务
- **WHEN** 使用者要求新增 app 页面及后端能力
- **THEN** 数据访问使用可信空间身份与租户范围，入口验证权限，文案覆盖启用语言，相关工程检查和核心行为验证通过

### Requirement: 安全审查与真实验证证据
security-scan SHALL 复用工程检查、敏感路径/凭据扫描与 diff 审查，报告范围且不输出真值。技能交付 MUST 包含临时项目生成/安装/typecheck/unit、最小页面和模块样例以及部署只读/dry-run 的结果；样例代码 MUST 丢弃，未完成外部验收 MUST 明示。

#### Scenario: 提交前扫描
- **WHEN** 使用者要求检查当前变更
- **THEN** 报告鉴权、注入、Webhook、SSRF、账本边界与敏感文件的审查结果，定位问题但不展示密钥值

#### Scenario: 离线交付
- **WHEN** 本次没有执行线上部署和真实服务调用
- **THEN** 验证记录仅声明真实完成的离线检查，不将 dry-run 记为部署成功

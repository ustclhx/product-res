# agent-skills Specification

## Purpose

为本模板提供能够依据仓库真实入口执行的项目级 Agent Skills，使使用者在 Codex 与 Claude 中获得一致的启动、部署准备与业务扩展流程，并能区分已验证结果、所需外部授权和未完成验收。

## Requirements

### Requirement: 双目录技能入口
系统 SHALL 提供 quick-start、deploy-cloudflare、deploy-selfhost、new-page、new-module、new-static-page、add-ai-model、security-scan、template-sync、ui-design；每个技能 SHALL 有 name/description 和可执行步骤、真实命令、验收条件、常见故障，两处目录内容 MUST 完全一致。

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

### Requirement: 模板同步先预检再授权
template-sync 技能 SHALL 用于衍生项目。它 SHALL 先做只读预检：
- 基准记录；
- 工作区是否干净；
- 模板可达性；
- 待采纳的版本区间、各版本升级说明中的必须执行动作与 `requiresDeployed` 边界；
- 待移植的迁移。

然后在本地分支上执行同步并报告冲突与验证结果。推送、开 PR、合并以及任何环境上的迁移 MUST 先列出具体动作并取得明确确认。冲突 MUST 由使用者或在其指示下逐个处理，不得整体采用任一方。升级说明中涉及外部系统的动作（新增密钥、部署绑定、线上迁移）MUST 逐项确认，不得代为执行。

#### Scenario: 默认调用同步技能
- **WHEN** 使用者调用 template-sync 但未批准推送或开 PR
- **THEN** 只在本地同步分支上完成合并与验证并输出报告，不推送、不开 PR、不迁移任何数据库

#### Scenario: 升级说明要求新增密钥
- **WHEN** 区间内某个版本的升级说明要求配置新的 secret
- **THEN** 技能在待办清单中列出 secret 名称与配置位置，不读取也不写入任何密钥值

#### Scenario: 没有基准记录
- **WHEN** 在没有 `.template-base.json` 的衍生项目中调用技能
- **THEN** 技能改为引导基准推断，并在写入记录前请求确认

### Requirement: 页面开发前的设计关卡
新增页面或较大布局改动 SHALL 先由 ui-design 技能基于设计规范与使用者提供的参考产出设计稿，覆盖桌面与移动、浅色与深色、空、加载与错误状态，并取得使用者对该设计稿的明确确认后才开始实现。文案、小样式调整与缺陷修复 SHALL 免于此关卡。页面技能 MUST 在开发前检查已确认设计稿的链接。

#### Scenario: 未确认设计稿就要求开发新页面
- **WHEN** 使用者调用 new-page 新增页面，但没有已确认的设计稿
- **THEN** 技能先进入 ui-design 产出设计稿并请求确认，不创建路由或组件文件

#### Scenario: 修改按钮文案
- **WHEN** 使用者只要求修改现有页面的按钮文案
- **THEN** 技能直接修改，不要求设计稿

### Requirement: 设计参考优先于自由发挥
ui-design 技能 SHALL 在建立新的视觉方向前向使用者索取参考（网站或截图），并把采用的参考记录进设计规范；没有参考时 SHALL 只使用现有设计规范，MUST NOT 引入规范外的颜色、字体或组件样式。实现 SHALL 只使用共享组件包与设计 token，缺少组件时先补充组件再实现页面。

#### Scenario: 设计稿需要规范外的颜色
- **WHEN** 设计过程中需要现有 token 之外的颜色
- **THEN** 技能提出 token 变更并等待使用者确认，不在页面中写死颜色

### Requirement: 设计稿副本留存
经确认的设计稿 SHALL 以可离线打开的副本保存在项目的设计目录中，并与原链接一同写入该需求的规划文档；实现与验收 SHALL 以副本为准，链接失效时 MUST NOT 影响开发。

#### Scenario: 设计稿链接不可访问
- **WHEN** 并行 worker 无法打开设计稿链接
- **THEN** worker 读取仓库中的设计稿副本继续实现

### Requirement: 衍生项目视觉方向与同步回归
ui-design 技能 SHALL 支持衍生项目基于模板基线建立项目视觉方向，产出项目品牌 token 与视觉规范文档，可包含多站点配色。template-sync 技能在同步涉及共享组件或基线 token 时 SHALL 在合并前对组件预览页与项目关键页面截图对比，偏差 SHALL 通过 token 或项目组件修正，MUST NOT 修改模板组件。

#### Scenario: 模板升级改变按钮圆角
- **WHEN** 同步分支中的模板更新导致项目按钮圆角与项目视觉规范不符
- **THEN** 同步报告列出截图差异，修正写入项目品牌 token 或项目组件，模板组件文件保持不变

#### Scenario: 新项目建立视觉方向
- **WHEN** 使用者为一个新衍生项目提供两个参考网站
- **THEN** 技能在模板基线上产出项目品牌 token、视觉规范文档与设计系统镜像，经确认后写入项目自有文件

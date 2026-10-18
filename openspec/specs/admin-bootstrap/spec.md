# admin-bootstrap Specification

## Purpose

为新部署项目提供受邮箱验证保护的首次平台管理员引导入口，允许运维使用独立环境名单配置目标账号，确保注册默认允许未验证邮箱登录时仍无法获得管理权限，并保留可追踪且幂等的系统审计。

## Requirements

### Requirement: 已验证邮箱名单提升
系统 SHALL 将可选 BOOTSTRAP_ADMIN_EMAILS 按逗号分割、去除两侧空白并忽略大小写；仅名单内、emailVerified=true 且未封禁用户 MUST 被提升为平台 admin。未配置或空名单 MUST 禁用引导。

#### Scenario: 已验证名单账号
- **WHEN** 用户邮箱匹配含空白及大小写变化的名单且已验证、未封禁
- **THEN** 用户成为平台 admin

#### Scenario: 不符合信任条件
- **WHEN** 用户邮箱未验证、未在名单、已封禁，或名单为空
- **THEN** 用户角色不因引导改变

### Requirement: 认证事件覆盖与幂等审计
系统 SHALL 在用户创建后、邮箱验证持久化后及会话创建后检查引导规则。成功提升 MUST 同时追加 admin.user.bootstrap 审计，actor 为系统或用户本人，meta 包含触发来源；已为 admin 的用户 MUST 不重复更新或记录审计。

#### Scenario: 邮箱密码注册后验证
- **WHEN** 名单账号先以未验证邮箱注册，之后完成邮箱验证
- **THEN** 注册时不提升，验证后提升并记录触发来源

#### Scenario: 已存在账号重新登录
- **WHEN** 已验证的已有账号被加入名单后登录
- **THEN** 账号被提升；后续重复或并发触发只保留一次提升审计

### Requirement: 只提升与安全配置
系统 MUST NOT 因移除名单或关闭引导而自动降权，模板代码与文档 MUST NOT 保存真实管理员邮箱，首次运行指引 SHALL 说明验证条件和撤权规则。

#### Scenario: 移除名单
- **WHEN** 管理员邮箱从配置中移除后再次登录
- **THEN** 既有 admin 角色保留，需通过显式角色管理撤销

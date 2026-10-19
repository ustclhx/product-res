## MODIFIED Requirements

### Requirement: 已验证邮箱名单提升
系统 SHALL 将可选 BOOTSTRAP_ADMIN_EMAILS 按逗号分割、去除两侧空白并忽略大小写；仅名单内、emailVerified=true 且未封禁用户 MUST 被提升为平台 admin。未配置或空名单 MUST 禁用引导。可选环境变量 BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED 取值为 `true` 时，名单内且未封禁的用户 MUST 在不要求 emailVerified 的情况下被提升；其它取值、空串或未设置 MUST 保持已验证邮箱要求。文档 SHALL 说明该开关应配合只放行运维邮箱的注册白名单使用，并在提升完成后关闭。

#### Scenario: 已验证名单账号
- **WHEN** 用户邮箱匹配含空白及大小写变化的名单且已验证、未封禁
- **THEN** 用户成为平台 admin

#### Scenario: 不符合信任条件
- **WHEN** 用户邮箱未验证（且未显式允许）、未在名单、已封禁，或名单为空
- **THEN** 用户角色不因引导改变

#### Scenario: 显式允许未验证注册
- **WHEN** BOOTSTRAP_ADMIN_ALLOW_UNVERIFIED=true，名单邮箱以未验证状态注册
- **THEN** 用户立即成为平台 admin 并记录引导审计

#### Scenario: 开关打开但账号被封禁
- **WHEN** 开关打开，名单内用户已封禁
- **THEN** 用户角色不因引导改变

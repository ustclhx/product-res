## Purpose

为试点提供受保护的账号管理能力，使指定管理员能通过业务界面配置成员、工作区和角色，减少服务器人工操作，同时保持业务权限隔离、凭据保密、操作可追溯及既有数据兼容。

## ADDED Requirements

### Requirement: Server-authorized account administration
系统 SHALL 仅允许服务端指定的管理员读取和修改账号管理数据；管理员标识 SHALL 与业务角色分开，写请求 SHALL 校验 Origin 与 CSRF。

#### Scenario: Ordinary member attempts account access
- **WHEN** 普通成员直接调用管理 API 或打开管理页
- **THEN** 管理 API 拒绝访问，界面不提供账号管理操作

### Requirement: Create and configure accounts
管理员 SHALL 能创建账号并指定一个或多个工作区及业务角色，修改显示名称、启停账号和成员配置；系统 MUST 拒绝重复用户名、无效工作区、非法角色与过期版本。

#### Scenario: New account is assigned a workspace
- **WHEN** 管理员创建合法账号并分配工作区
- **THEN** 新账号能用生成密码登录，且只能进入获分配的工作区

#### Scenario: Concurrent edit or self lockout
- **WHEN** 修改使用旧版本，或管理员试图禁用自己或改变自己的成员配置
- **THEN** 系统拒绝操作且不部分写入

### Requirement: Safe password and session lifecycle
创建与重置 SHALL 生成随机密码并仅在该响应中提供明文；列表和审计 MUST 不包含密码及哈希。禁用、权限变动和密码重置 SHALL 使相关旧会话失效。

#### Scenario: Password is reset
- **WHEN** 管理员确认重置目标账号密码
- **THEN** 新密码可登录、旧密码不可登录，已有会话失效，审计记录操作者及目标而不包含凭据

### Requirement: Compatible deployment and bootstrap
系统 SHALL 保留既有用户、工作区及业务数据并支持控制库迁移，提供离线创建初始 admin 的受控方式；管理操作 SHALL 在控制库内原子审计。

#### Scenario: Existing pilot is upgraded
- **WHEN** 在已备份的 v1 试点库上启动新版并创建 admin
- **THEN** 原账号与业务记录继续可用，admin 能登录管理页并配置成员

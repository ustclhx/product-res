## ADDED Requirements

### Requirement: 管理员发放积分开通工作台
模板配置 `credits.requireGrantForAccess` 为 true 时，系统 SHALL 仅在当前空间存在来源为 admin 的积分发放批次，或用户为平台 admin 时允许使用工作台。未开通时工作台服务端入口 MUST 返回 403 `ACCOUNT_NOT_ACTIVATED`，工作台页面 SHALL 显示账号待管理员开通的说明；账户设置、登出与后台 MUST NOT 受影响。配置为 false 时行为不变。

#### Scenario: 未开通账号访问工作台
- **WHEN** 开关打开，普通用户空间没有管理员发放的积分
- **THEN** 工作台 server function 返回 403，页面显示待开通说明

#### Scenario: 管理员发放积分后
- **WHEN** 管理员在后台为该空间发放积分
- **THEN** 用户刷新后即可使用工作台

#### Scenario: 平台管理员
- **WHEN** 开关打开，平台 admin 的空间没有任何积分发放
- **THEN** 工作台照常可用

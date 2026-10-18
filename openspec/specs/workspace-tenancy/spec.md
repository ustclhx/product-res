# workspace-tenancy Specification

## Purpose

定义「个人空间」多租户模型：数据与计费归属 Workspace，团队能力由开关控制，以及成员、邀请、席位与数据隔离规则。

## Requirements

### Requirement: 注册即创建个人空间
每个新用户注册成功后 SHALL 自动拥有一个个人空间，用户为其唯一 owner，且该空间具有自动生成、全局唯一、用户可修改的 slug。

#### Scenario: 新用户注册
- **WHEN** 用户完成注册
- **THEN** 存在一个属于该用户的个人空间，用户角色为 owner，访问 `/app` 会被重定向到 `/app/<该空间 slug>`

### Requirement: 统一的空间 URL
应用区页面 SHALL 一律使用 `/app/$slug/...` 形式的地址，与 `multiTenant` 开关无关；`/app` 本身 SHALL 重定向到当前活跃空间，没有活跃空间时重定向到个人空间。

#### Scenario: 打开多租户开关前后链接不变
- **WHEN** 站点从 `multiTenant=false` 切换为 `true`
- **THEN** 之前分享出的 `/app/<slug>/...` 链接仍然有效

### Requirement: 团队空间开关
当 `multiTenant=false` 时，系统 MUST 拒绝创建团队空间与发送邀请，并隐藏空间切换器；当 `multiTenant=true` 时，用户 SHALL 能在 `maxWorkspacesPerUser` 与套餐权益范围内创建团队空间。开关关闭后，已有团队空间 SHALL 保持只读可访问。

#### Scenario: 关闭开关时创建团队空间
- **WHEN** `multiTenant=false`，客户端直接调用创建团队空间接口
- **THEN** 请求被拒绝

#### Scenario: 关闭开关后访问已有团队空间
- **WHEN** 站点关闭多租户开关，某用户访问其已有团队空间
- **THEN** 可以查看数据，但不能邀请成员或创建新内容

### Requirement: 个人空间限制
个人空间 MUST NOT 能邀请成员或转让所有权。

#### Scenario: 向个人空间发邀请
- **WHEN** 用户尝试向自己的个人空间邀请他人
- **THEN** 请求被拒绝

### Requirement: 空间角色权限
空间成员 SHALL 具有 `owner`、`admin` 或 `member` 角色之一：owner 拥有全部权限（含账单、删除与转让空间），admin 可管理成员与查看账单，member 只能使用 AI 与查看自己的用量。

#### Scenario: member 尝试移除成员
- **WHEN** 角色为 member 的用户请求移除另一成员
- **THEN** 请求返回 403

### Requirement: 每次请求校验成员身份
访问 `/app/$slug/...` 下的任何页面或接口时，系统 SHALL 以数据库中的当前成员关系判断访问权限，MUST NOT 依据会话缓存中的空间信息放行。

#### Scenario: 被移出后立即访问
- **WHEN** 某成员被移出空间后，在会话缓存仍有效期间访问该空间页面
- **THEN** 请求返回 403 或 404

### Requirement: 席位上限
在套餐权益规定了 `maxSeats` 时，空间成员数 MUST NOT 因并发接受邀请或新增成员而超过上限；降级导致超员时，系统 SHALL 保留现有成员但禁止新增，并向 owner 提示。

#### Scenario: 并发接受最后一个席位
- **WHEN** 空间只剩一个席位，两个被邀请人同时接受邀请
- **THEN** 只有一人加入成功，另一人收到席位已满的错误

#### Scenario: 降级后超员
- **WHEN** 空间降级到席位更少的套餐后成员数超过新上限
- **THEN** 现有成员保留，新的邀请被拒绝，owner 在空间设置页看到超员提示

### Requirement: 租户数据隔离
任何空间的成员 MUST NOT 能读取或修改其他空间的业务数据或文件，包括通过猜测 ID 直接访问资源的情况。

#### Scenario: 用他人空间的资源 ID 访问
- **WHEN** 用户在自己空间的 URL 下使用另一空间某条记录的 ID 发起请求
- **THEN** 返回 404，不泄露该记录是否存在

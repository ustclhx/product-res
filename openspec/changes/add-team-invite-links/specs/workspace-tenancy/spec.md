## ADDED Requirements

### Requirement: 团队空间邀请链接的生成与管理
当 `multiTenant=true` 时，团队空间的 owner 与 admin SHALL 能生成邀请链接：选择加入后的角色（`member` 或 `admin`，MUST NOT 允许 `owner`）、有效期（1、7 或 30 天，默认 7 天）与可选的人数上限。完整链接 SHALL 只在生成成功时返回一次；空间设置页 SHALL 列出该空间的链接及其角色、状态（有效、已过期、已作废、已用完）、已用次数与上限、过期时间和创建人，并允许 owner 与 admin 随时作废。member MUST NOT 看到或调用这些操作；个人空间 MUST NOT 显示这些操作，服务端 MUST 拒绝个人空间与 `multiTenant=false` 时的生成请求。

#### Scenario: owner 生成链接
- **WHEN** 团队空间 owner 选择角色 admin、有效期 7 天、上限 3 人生成链接
- **THEN** 返回一次完整的 `/join/<token>` 链接，列表中出现一条角色 admin、已用 0/3、7 天后过期的有效链接

#### Scenario: member 尝试生成链接
- **WHEN** 角色为 member 的用户直接调用生成接口
- **THEN** 请求返回 403，且不创建链接

#### Scenario: 个人空间生成链接
- **WHEN** 用户对自己的个人空间调用生成接口
- **THEN** 请求被拒绝，个人空间设置页不显示邀请链接区块

#### Scenario: 请求 owner 角色
- **WHEN** 生成请求的角色为 owner
- **THEN** 请求返回 400，且不创建链接

#### Scenario: 作废链接
- **WHEN** admin 作废一条有效链接
- **THEN** 列表中该链接显示已作废，之后用该链接加入被拒绝

### Requirement: 通过邀请链接加入团队空间
用户打开 `/join/<token>` 时：未登录 SHALL 先进入登录或注册，完成后回到该链接，未登录时页面 MUST NOT 显示空间名；已登录 SHALL 显示“加入 <空间名>（角色）”并在确认后加入，以链接指定的角色成为成员并进入该空间；已是成员 SHALL 直接进入该空间且不消耗次数。链接已过期、已作废、已达人数上限、创建人已不是该空间 owner 或 admin、空间已删除或 token 不存在时，页面 SHALL 给出对应的明确提示且不加入。加入 MUST NOT 要求邮箱已验证。

#### Scenario: 未登录用户打开链接
- **WHEN** 未登录访客打开有效链接并选择注册
- **THEN** 注册完成后回到该链接页面，看到“加入 <空间名>（角色）”

#### Scenario: 确认加入
- **WHEN** 已登录且邮箱未验证的用户确认加入一条角色为 member 的有效链接
- **THEN** 该用户成为该空间 member，链接已用次数加 1，页面进入该空间

#### Scenario: 已是成员
- **WHEN** 空间现有成员打开该空间的有效链接
- **THEN** 直接进入该空间，已用次数不变

#### Scenario: 链接已过期
- **WHEN** 用户打开已过期的链接
- **THEN** 页面提示链接已过期，用户没有加入

#### Scenario: 达到人数上限
- **WHEN** 上限为 1 的链接已被一人使用，另一用户尝试加入
- **THEN** 页面提示链接已达使用上限，用户没有加入

### Requirement: 邀请链接加入遵守席位上限
通过邀请链接加入 SHALL 与邮件邀请、直接添加成员共用同一空间级事务锁，在同一事务内校验套餐权益的 `maxSeats` 与链接的人数上限后再插入成员；空间与链接的计数 MUST NOT 因并发加入而超过上限。

#### Scenario: 并发争抢最后一个席位
- **WHEN** 空间只剩一个席位，两个用户同时用同一有效链接加入
- **THEN** 只有一人加入成功，另一人收到席位已满的错误，已用次数只增加 1

### Requirement: 邀请链接的安全
邀请链接 token SHALL 是至少 256 位的随机值；数据库 MUST 只存 token 的哈希，比较 MUST 不受 token 内容影响耗时。加入与预览接口 SHALL 按客户端 IP 与用户限流，超限返回 429。token MUST NOT 出现在请求日志、错误上报、页面统计或审计记录中。生成、作废与加入 SHALL 写入审计日志，记录操作者、空间、链接 ID 与角色；生成、作废与加入 MUST 使用真实登录会话，管理员模拟登录时被拒绝。

#### Scenario: 数据库泄露
- **WHEN** 攻击者读取 `workspace_invite_link` 表
- **THEN** 只能得到 token 哈希，无法拼出可用链接

#### Scenario: 请求日志
- **WHEN** 用户打开 `/join/<token>`
- **THEN** 请求日志中的路径为 `/join/[REDACTED]`

#### Scenario: 频繁尝试
- **WHEN** 同一 IP 在一分钟内超过限流次数调用加入接口
- **THEN** 后续请求返回 429

#### Scenario: 审计
- **WHEN** 用户通过链接加入
- **THEN** 审计日志新增一条成员加入记录，包含链接 ID 与加入角色，不包含 token

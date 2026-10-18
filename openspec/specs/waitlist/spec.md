# waitlist Specification

## Purpose

在站点正式开放注册前收集感兴趣用户的邮箱，并支持运营者分批邀请。
使用去重、人机验证和限流保护邮箱收集入口，并让管理员选定的受邀用户在公开注册关闭时仍可通过邀请完成注册。

## Requirements

### Requirement: 加入等候名单
`features.waitlist=true` 时，访客 SHALL 能提交邮箱加入等候名单；同一邮箱重复提交 MUST NOT 产生重复记录，提交 SHALL 受人机验证与限流保护。

#### Scenario: 重复提交
- **WHEN** 同一邮箱提交两次
- **THEN** 名单中只有一条记录，第二次也返回成功提示

#### Scenario: 功能关闭
- **WHEN** `features.waitlist=false`，客户端调用加入接口
- **THEN** 返回 404

### Requirement: 分批邀请
管理员 SHALL 能查看名单并选择一批邮箱发送注册邀请邮件，被邀请的邮箱在注册关闭时仍 SHALL 能完成注册。

#### Scenario: 注册关闭时被邀请
- **WHEN** 运行时设置关闭了注册，被邀请的邮箱通过邀请链接注册
- **THEN** 注册成功

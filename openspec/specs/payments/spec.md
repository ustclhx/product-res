# payments Specification

## Purpose
定义用户如何通过各支付平台购买订阅与积分包，以及系统在发起结账前必须做的检查，使不同平台对用户呈现一致的购买行为。

## Requirements

### Requirement: 可配置的支付平台
定价页 SHALL 按模板配置 `billing.providers` 的顺序展示可用的支付方式；未在配置中的平台 MUST NOT 出现，其结账接口 MUST 拒绝请求。

#### Scenario: 只启用 PayPal
- **WHEN** 配置 `billing.providers=['paypal']`
- **THEN** 定价页只显示 PayPal，直接调用 Stripe 结账接口返回错误

### Requirement: 结账权限
只有空间的 owner SHALL 能为该空间发起结账（购买订阅或积分包）。

#### Scenario: 非 owner 结账
- **WHEN** 空间 admin 或 member 发起结账
- **THEN** 请求返回 403

### Requirement: 订阅结账前置检查
空间已有「会续费的」订阅时：若与目标为同一平台且该平台支持订阅内换套餐，系统 MUST 拒绝新建订阅并引导走换套餐；否则系统 SHALL 在用户确认后先将旧订阅设为周期末取消，成功后才创建新的结账。

#### Scenario: 同平台已有订阅
- **WHEN** 空间已有 Stripe 的有效订阅，再次发起 Stripe 订阅结账
- **THEN** 结账被拒绝，提示使用换套餐功能

#### Scenario: 换平台
- **WHEN** 空间已有 Stripe 的有效订阅，用户确认后发起 PayPal 订阅结账
- **THEN** 旧订阅被设为周期末取消，然后返回 PayPal 结账地址

### Requirement: 一次性付款以回调为准入账
积分包等一次性购买 SHALL 只在收到平台确认付款成功的通知后发放积分；用户从支付页返回时的主动确认（如 PayPal capture）与平台回调 MUST 无论先后到达都只入账一次。

#### Scenario: 返回页先于回调
- **WHEN** 用户从 PayPal 返回触发 capture，随后平台的付款完成回调到达
- **THEN** 积分只发放一次

#### Scenario: 用户关闭返回页
- **WHEN** 用户付款后没有回到站点
- **THEN** 平台回调到达后积分仍正常发放

### Requirement: 订阅管理入口
账单页 SHALL 为订阅提供取消与恢复操作；平台提供客户门户时 SHALL 提供跳转门户的入口。

#### Scenario: Stripe 订阅
- **WHEN** owner 打开账单页且订阅来自 Stripe
- **THEN** 页面提供打开 Stripe 客户门户的入口

#### Scenario: PayPal 订阅取消
- **WHEN** owner 在账单页取消 PayPal 订阅
- **THEN** 订阅被设为周期末取消，周期结束前权益保留

# payment-mode Specification

## Purpose

定义支付环境在开发、staging 与生产中的选择和失败行为，使支付操作、回调验签及管理显示使用一致模式，并保证正在运行的测试与沙箱验收不会被生产能力的引入改变。

## Requirements

### Requirement: 显式环境支付模式

系统 SHALL 支持 `PAYMENT_MODE=test|live`，本地与 staging SHALL 显式配置 test。模式缺失时仅 development SHALL 默认 test；其他环境的支付入口 MUST 拒绝操作、记录结构化日志并返回 HTTP 503（后台事件抛错），MUST NOT 自动选择另一模式。

#### Scenario: 开发环境缺失模式
- **WHEN** development 环境未提供 PAYMENT_MODE
- **THEN** 支付使用 test，PayPal 使用 Sandbox

#### Scenario: 非开发环境缺失模式
- **WHEN** staging、production 或未知环境未提供 PAYMENT_MODE
- **THEN** 支付入口关闭，HTTP 返回 503，后台事件失败，日志不包含凭据值

#### Scenario: 非法模式
- **WHEN** PAYMENT_MODE 不是 test 或 live
- **THEN** 配置校验失败，支付不能执行

### Requirement: Stripe 模式与凭据匹配

test 模式 SHALL 仅接受 sk_test_，live 模式 SHALL 接受 sk_live_ 或 rk_live_；错配 MUST 在任何远端请求或付款副作用前失败并返回 503，不回退。已启用但凭据缺失的 provider SHALL 保持不可用与既有告警行为。

#### Scenario: 匹配模式
- **WHEN** test 提供 sk_test_ 或 live 提供 sk_live_/rk_live_ 且 webhook secret 齐全
- **THEN** 对应 Stripe 支付能力可用

#### Scenario: 错配模式
- **WHEN** live 提供测试密钥或 test 提供 live 密钥
- **THEN** 支付失败且无远端调用、无账务副作用

### Requirement: PayPal API 与验签环境一致

系统 SHALL 在 test 使用 PayPal Sandbox API，在 live 使用 PayPal live API；OAuth、业务请求、Webhook 验签与补偿快照 SHALL 共用所选环境的凭据和 webhook ID，MUST NOT 在失败后尝试另一环境。

#### Scenario: Test PayPal
- **WHEN** test 模式发起 PayPal 请求
- **THEN** 仅请求 https://api-m.sandbox.paypal.com，保持原 Sandbox 行为

#### Scenario: Live PayPal
- **WHEN** live 模式发起 PayPal 请求
- **THEN** 仅请求 https://api-m.paypal.com，验签使用该环境配置的 webhook ID

### Requirement: Stripe 回调与重放模式隔离

Stripe 回调 SHALL 使用当前模式的 webhook secret 验签，并 MUST 在读取平台快照和账务写入之前拒绝已签名但 livemode 与运行时模式不同的事件；后台重放 SHALL 遵守相同限制。

#### Scenario: 已验签的跨模式事件
- **WHEN** live runtime 收到 livemode=false 的已签名事件，或 test 收到 livemode=true
- **THEN** 回调或重放被拒绝，不执行平台补充查询或账务写入

### Requirement: 入口统一与实际模式展示

所有 Web 支付、定价、认证删除及 Jobs 支付入口 SHALL 采用统一环境模式；后台 SHALL 显示实际 test/live 模式，支付配置日志 SHALL 标示实际模式。公开定价读取失败 SHALL 降级为支付不可用，不能伪装配置成功。

#### Scenario: 后台实际模式
- **WHEN** 管理员读取 live 环境的支付后台
- **THEN** 页面显示 live 模式，日志与实际运行时一致

#### Scenario: 公开定价降级
- **WHEN** 支付模式配置不正确
- **THEN** 公开定价仍可展示静态信息，支付选项全部不可用

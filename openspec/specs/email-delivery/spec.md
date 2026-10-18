# email-delivery Specification

## Purpose
定义部署管理员如何选择邮件发送通道，并使认证与业务通知复用统一模板和异步队列。发送通道的变化必须保留重试、失败分类和死信语义，避免邮件正文与凭据进入日志或错误追踪。

## Requirements

### Requirement: Resend 或 SMTP 通道选择
Node 邮件 SHALL 可配置为 Resend 或通用 SMTP，并复用现有模板、发件人与回复地址。显式选择通道时 MUST 校验其必需配置，缺失或非法 MUST 启动失败且仅报告变量名，不得自动退回 log 或其他通道。现有开发用 log 通道 SHALL 保留，Cloudflare 默认邮件路径 MUST 保持兼容。

#### Scenario: 选择 SMTP
- **WHEN** 部署配置选择 SMTP 且 host、port、TLS 模式、发件人和所选认证方式配置有效
- **THEN** jobs 通过 SMTP 发送相同模板邮件，不要求 Resend API key

#### Scenario: 凭据配置错误
- **WHEN** 显式选择 Resend 缺 API key，或 SMTP 认证只提供 user 未提供 password
- **THEN** 启动拒绝并列出变量名，不发送或记录正文，不退回 log，不通过另一个通道补发

### Requirement: SMTP 传输安全与结果分类
SMTP SHALL 支持隐式 TLS 与强制 STARTTLS，并校验证书；明文模式 SHALL 仅用于显式配置的受控内部中继或测试。网络超时、连接失败与临时 4xx SHALL 作为可重试失败，永久 5xx/本地非法配置 SHALL 作为不可重试失败。临时 SMTP 状态 MUST 优先于客户端的认证/收件人错误分类。日志和错误追踪 MUST 不含 SMTP 响应正文、密码、收件人内容或邮件正文。

#### Scenario: TLS 不可用
- **WHEN** 配置强制 STARTTLS 的服务器不支持升级或证书验证失败
- **THEN** 发送失败，不降级为明文或禁用证书验证，队列接收脱敏的分类结果

#### Scenario: 服务器临时与永久拒绝
- **WHEN** SMTP 返回临时 451 或永久 550
- **THEN** 451 进入队列重试，550 进入有效不可重试失败处理，日志仅有安全错误码与任务上下文

#### Scenario: 临时认证失败
- **WHEN** SMTP 返回 454，而客户端同时标记为认证错误
- **THEN** 消息仍按临时失败进入重试，不能仅按认证错误类别提前死信

### Requirement: 邮件通道保持持久队列语义
邮件 SHALL 继续通过现有持久队列异步发送。Node 成功确认、无效消息确认、初次加最多 5 次重试及指数退避规则 MUST 不因通道改变。有效不可重试或重试耗尽失败 MUST 先持久记录死信再确认，记录失败 MUST 不提前确认；邮件服务暂时不可用 MUST 不使已成功入队的用户请求失败。

#### Scenario: SMTP 暂时不可用
- **WHEN** 用户请求重置密码成功入队，而 SMTP 首次发送失败后恢复
- **THEN** 用户请求已成功返回，消息按原退避重试并送达，成功后确认，成功同批消息不被重复重试

#### Scenario: 永久失败或耗尽
- **WHEN** 有效邮件不可重试或第六次尝试失败
- **THEN** Node 持久死信成功后才确认；死信写入失败时保留可恢复消息，无效消息仍沿用原确认策略

### Requirement: SMTP 至少一次边界
SMTP 发送 SHALL 保持稳定的业务消息身份。发送被远端接受后而本地确认前崩溃时，系统 SHALL 允许按至少一次语义恢复；MUST NOT 承诺 SMTP 提供幂等去重或 exactly-once，MUST NOT 在不确定发送结果时自动切换另一通道。

#### Scenario: 接受后连接中断
- **WHEN** SMTP 服务可能已接受邮件但 jobs 未能确认成功
- **THEN** 按原重试策略恢复且消息身份不变，可能重复投递的边界被记录，不跨通道补发

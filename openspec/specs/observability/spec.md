# observability Specification

## Purpose

让运营者能发现并定位线上问题（错误、慢请求、异常业务事件），同时保证采集的数据不泄露密钥与用户隐私。

## Requirements

### Requirement: 错误上报
Web 与后台 Worker 中未处理的异常 SHALL 上报到错误追踪服务，并附带部署版本、请求 ID、空间 ID 与用户 ID（不含邮箱等个人信息），堆栈 SHALL 能映射回源码。

#### Scenario: 接口抛出未处理异常
- **WHEN** 某接口抛出未处理异常
- **THEN** 错误追踪中出现一条带版本、请求 ID 与可读源码堆栈的事件

### Requirement: 结构化日志
每个请求与后台任务 SHALL 输出 JSON 格式日志，包含请求 ID、空间 ID、用户 ID、路由或任务名、耗时与结果；同一请求触发的后台消息 SHALL 携带同一请求 ID。

#### Scenario: 追踪一次结账
- **WHEN** 运营者按请求 ID 检索日志
- **THEN** 能看到该结账请求以及由它投递的后续队列消息的日志

### Requirement: 敏感信息脱敏
日志与错误上报 MUST NOT 包含密钥、密码、令牌、完整的支付信息或 AI 对话内容。

#### Scenario: 携带令牌的请求出错
- **WHEN** 带有 Authorization 头的请求出错
- **THEN** 上报事件中该头部已被移除或打码

### Requirement: 流量统计
公开页面 SHALL 接入不使用 Cookie 的流量统计；产品分析 SHALL 默认关闭，只有在模板配置中显式开启时才加载对应脚本。

#### Scenario: 默认配置
- **WHEN** 站点使用默认配置
- **THEN** 页面只加载无 Cookie 的流量统计，不加载产品分析脚本

### Requirement: Node 可选错误追踪
Node web/jobs SHALL 可选启用错误追踪，未配置 DSN 时 MUST 不发送事件且保留共享 JSON 日志，业务和探活不因此失败。启用时 SHALL 上报未处理异常与既有明确采集点，附带 release、请求 ID 和可用的用户/空间/任务标识；错误追踪不可达 MUST NOT 改变业务结果或邮件 ack/retry/死信语义。

#### Scenario: 不启用监控
- **WHEN** Node web/jobs 没有配置 Sentry DSN
- **THEN** 正常提供业务服务，没有 Sentry 出站请求，失败仍有脱敏结构化日志

#### Scenario: 后台异常与上报故障
- **WHEN** 队列任务失败，或错误追踪服务暂时不可达
- **THEN** 有效失败继续按原策略重试/死信；上报仅携带脱敏上下文，不触发额外发送尝试或吞掉业务错误

### Requirement: Node 监控上下文与脱敏
Node 错误事件 SHALL 沿用既有敏感字段移除规则。并发请求或任务的身份与标签 MUST 隔离；事件和 breadcrumbs MUST NOT 包含邮箱、密码、认证头、Cookie、链接令牌、预签名 query、邮件正文、AI 内容或外部凭据。采集范围 MUST 通过既有脱敏边界，不能绕过它引入自动请求体采集。

#### Scenario: 并发空间异常
- **WHEN** 两个不同空间的 HTTP 请求或后台任务并发失败
- **THEN** 每个事件只包含自身的 requestId/workspaceId/userId/jobId，不残留另一个空间的身份

#### Scenario: 敏感请求错误
- **WHEN** 错误含 Authorization/Cookie、验证码链接、SMTP/S3 凭据或文件签名 URL
- **THEN** 发送的事件及日志不含敏感原文，保留定位所需的安全机器码与源码堆栈

### Requirement: Node 发布与源码映射
Node web/jobs 错误事件的 release SHALL 与该构建的完整 Git SHA 对齐；source map SHALL 通过既有受控上传流程关联同一版本的 Node 输出。上传 token MUST 仅用于构建后的上传步骤，源码映射与凭据 MUST NOT 经公开静态路由提供。停机 SHALL 在既有退出预算内等待已捕获事件发送，不得延长任务退出边界。

#### Scenario: 同版本可读堆栈
- **WHEN** 启用监控的 Node 生产输出捕获受控异常，且对应版本 source map 上传已完成
- **THEN** 事件显示完整版本 SHA 和对应源码位置，Node 与 Cloudflare 产物不会串用

#### Scenario: 优雅停机与断网
- **WHEN** 捕获事件后进程收到 SIGTERM，监控服务可达或不可达
- **THEN** 发送受剩余停机预算约束，退出不会无限等待，公开路由没有暴露 source map 或上传凭据

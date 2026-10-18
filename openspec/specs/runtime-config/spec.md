# runtime-config Specification

## Purpose

定义模板配置、运行时设置与环境变量如何加载和校验，以及三者各管各的内容、互不覆盖的规则，确保配置错误在启动时暴露而不是在线上请求中暴露。

## Requirements

### Requirement: 环境变量启动校验
apps/web 与 apps/jobs SHALL 按所选目标的 schema 校验所需配置与能力。Cloudflare 在处理第一个请求/事件前校验 bindings；Node 在监听端口或启动处理器前校验。必需项缺失或非法 MUST 拒绝服务且仅报告字段名，不输出密钥值；校验 MUST 保留公开页面的可选集成降级策略。（R3）

#### Scenario: 缺少必需项
- **WHEN** 部署的 Worker 缺少必需的 HYPERDRIVE 绑定
- **THEN** 任何请求返回 5xx，日志列出 HYPERDRIVE 名称，不含密钥或连接串值

#### Scenario: 配置齐全
- **WHEN** 所选目标的必需配置和能力齐全且合法
- **THEN** 服务正常处理请求，不要求另一目标的绑定

#### Scenario: Node 启动错误
- **WHEN** Node 缺少必需数据库配置、缓存配置或认证 secret
- **THEN** 在监听端口前以非零状态退出，错误只列字段名

### Requirement: 模板配置类型化默认值
模板配置（`template.config.ts`）SHALL 对每个未显式设置的选项提供默认值，并 MUST 在构建期对非法取值（如未知的登录方式或计费方式）报类型错误。

#### Scenario: 省略可选项
- **WHEN** 模板配置中省略 `billing.overage`
- **THEN** 运行时读取到文档约定的默认额度

#### Scenario: 非法取值
- **WHEN** 模板配置把 `ai.defaultPricingMode.video` 设为未定义的计费方式
- **THEN** 类型检查失败，构建不能通过

### Requirement: 运行时设置回退到代码默认值
运行时设置（`setting` 表）中缺少某一项时，系统 SHALL 使用代码中为该项定义的默认值，MUST NOT 去读取环境变量或模板配置作为替代。

#### Scenario: 设置项不存在
- **WHEN** `setting` 表中没有「注册开关」这一项
- **THEN** 系统使用代码默认值（允许注册），行为与该项显式设为默认值时一致

### Requirement: 已启用的可选集成缺少凭据时告警
模板配置启用、但凭据为可选的外部集成（如支付服务商）缺少凭据时，服务 SHALL 继续处理其他功能并以该集成不可用的方式运行，记录集成名称和缺失变量名的告警，MUST 不输出密钥值。Cloudflare 同一 isolate、Node 同一进程内同一集成 SHALL 只告警一次。

#### Scenario: jobs 缺少支付凭据
- **WHEN** 模板启用 stripe 而 jobs 缺少 STRIPE_SECRET_KEY
- **THEN** 其他任务照常执行，告警包含 stripe 与字段名且无密钥值

#### Scenario: 凭据部分缺失
- **WHEN** 启用 paypal 但只配置 PAYPAL_CLIENT_ID
- **THEN** PayPal 不可用，告警列出 PAYPAL_CLIENT_SECRET 与 PAYPAL_WEBHOOK_ID

#### Scenario: 凭据齐全
- **WHEN** 所需可选集成凭据齐全
- **THEN** 不记录缺凭据告警

### Requirement: Node 运行时文件密钥
Node SHALL 在启动时读取 .env 与进程环境（进程环境优先），并为声明的密钥支持 NAME_FILE 挂载文件。NAME 与 NAME_FILE 同时提供 MUST 报冲突；文件不可读或内容为空 MUST 启动失败且不泄露值。凭据 MUST 不进入构建产物、镜像、仓库或客户端。（R4）

#### Scenario: 挂载密钥
- **WHEN** 仅通过 NAME_FILE 配置可读的非空密钥文件
- **THEN** 服务读取内容并经相同 schema 校验，日志和健康响应不含内容

#### Scenario: 冲突或非法文件
- **WHEN** 同时提供直接值和文件，或所需文件不可读/为空
- **THEN** 服务启动失败，报告字段名而非内容或文件路径

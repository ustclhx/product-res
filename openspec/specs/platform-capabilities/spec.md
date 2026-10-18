# platform-capabilities Specification

## Purpose
定义业务在不同部署目标中访问平台能力的中立契约，使 Cloudflare 与自托管运行时复用相同业务行为，并明确请求生命周期和后续持久任务引擎的交接边界。

## Requirements

### Requirement: 目标中立的平台访问
业务代码 SHALL 通过按能力定义的接口访问 env、数据库、KV、限流、后台延续和请求元数据，MUST NOT 直接导入 cloudflare:* 或依赖 Workers 全局能力类型。仅目标适配器、明确的 composition entry 和目标测试夹具允许平台导入；Node 生产产物 MUST 不加载 Cloudflare 专用模块。（R2）

#### Scenario: 非法业务导入
- **WHEN** 业务模块通过静态、动态 import、export from 或 require 引用 cloudflare:workers
- **THEN** 工程检查失败并指出文件与导入；不能因引用位于 apps 而绕过检查

#### Scenario: 按目标装配
- **WHEN** 同一业务 handler 在 Cloudflare 与 Node 执行
- **THEN** 两者使用相同业务逻辑并获得各目标提供的能力，Node 无需 Workers bindings 或全局类型

### Requirement: Node 请求后台延续
Node SHALL 在响应结束及客户端断开后继续跟踪已注册后台 Promise；SIGTERM/SIGINT 时停止接收新请求并等待在途请求与后台任务，达到可配置停机上限才退出。后台异常 MUST 记录脱敏日志，不成为未处理 rejection；正常运行不添加响应后平台时限。（A1、R6）

#### Scenario: 断开后仍结算
- **WHEN** 客户端在模型流尚未完成时断开，服务端已注册消费与结算 Promise
- **THEN** 服务端继续消费，保存用量并按原账本规则结算

#### Scenario: 优雅退出
- **WHEN** 进程收到 SIGTERM，后台任务在排空上限前完成
- **THEN** 进程等待任务完成后关闭资源并退出

#### Scenario: 排空超时
- **WHEN** 后台任务超过停机上限仍未完成
- **THEN** 进程记录未完成任务数量并有界退出，不宣称任务已持久完成

### Requirement: 可信客户端 IP
Node SHALL 仅在真实 TCP peer 位于已配置可信代理列表时读取转发头，从右向左解析代理链取得第一非可信客户端地址；未配置可信代理或头非法时使用 peer。Cloudflare SHALL 保留由其可信入口提供的客户端 IP。MUST 不信任客户端自行提供的 cf-connecting-ip。（H2）

#### Scenario: 伪造转发头
- **WHEN** 非可信 peer 发来伪造 X-Forwarded-For 和 cf-connecting-ip
- **THEN** 限流与认证使用该 peer，伪造头不能改变 IP

#### Scenario: 多层可信代理
- **WHEN** 可信 peer 传来包含多个代理的合法链
- **THEN** 从右侧剥离可信代理后使用第一非可信地址，不无条件使用最左项

### Requirement: 应用请求标识
系统 SHALL 为每个请求生成应用 requestId 并贯穿响应与结构化日志；cf-ray 存在时仅作为附加关联字段，不存在时功能正常。（H3）

#### Scenario: 没有 Cloudflare 头
- **WHEN** Node 收到不含 cf-ray 的请求
- **THEN** 响应和关联日志具有同一应用生成的 requestId

### Requirement: 后台任务能力契约
平台 SHALL 定义独立的 queue、workflow、scheduler 契约，并提供既有 Cloudflare 适配。契约 MUST 表达批量逐条确认/重试、单独的事务入队能力、工作流创建/状态/终止/发事件与持久步骤/睡眠/有界事件等待、cron 时区/补跑/心跳。Node 实现归 B，未装配时 MUST 明确不可用，不提供假成功或内存生产后端。

#### Scenario: B 尚未装配
- **WHEN** Node 进程启动但没有任务引擎
- **THEN** 队列及调度能力报告 unavailable，相关业务拒绝执行，完整认证验收仍待 B

#### Scenario: Cloudflare 兼容
- **WHEN** 现有邮件 batch 逐条 ack/retry 或媒体 runner 使用重试、终态、事件等待
- **THEN** Cloudflare 适配保持原有行为，不因新增 Node 契约改变其投递与持久步骤语义

#### Scenario: 不支持事务入队的目标
- **WHEN** 某目标仅具普通队列发送能力
- **THEN** 不将普通 send 标为支持与数据库回滚绑定的事务入队能力

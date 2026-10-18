# cache-rate-limit Specification

## Purpose
定义会话与设置缓存以及认证、AI、公开 API 防刷的跨目标行为，确保自托管多进程共享缓存与计数，同时保持敏感会话和精确业务配额始终以数据库为准。

## Requirements

### Requirement: 共享 KV 行为
自托管 SHALL 使用 Compose 内共享缓存服务实现认证 secondaryStorage、配置与模型缓存，支持字符串/JSON 读取、写入秒 TTL 和删除；web/jobs SHALL 共享环境命名空间并隔离用途键。Cloudflare SHALL 保留现有 KV TTL 行为。敏感操作 MUST 继续实时查库。（C1）

#### Scenario: 跨进程缓存与失效
- **WHEN** web 写入缓存，jobs 读取或删除相同键
- **THEN** 使用相同值与命名空间，删除或 TTL 到期后读取未命中

#### Scenario: 敏感会话已吊销
- **WHEN** 缓存仍含旧会话但数据库会话已失效
- **THEN** 敏感操作拒绝该会话，不能因 Node 缓存替换而放行

### Requirement: 原子共享防刷
自托管 SHALL 在同一缓存服务中原子更新限流计数与过期时间，保留 RL_AUTH、RL_AI、RL_API 的键维度、限额与周期配置。跨 web 实例 SHALL 共用计数，超限返回 429 并阻止副作用；缓存不可达 MUST 返回 503，不能自动放行。精确额度与积分仍以 PG 事务为准。（C2）

#### Scenario: 多实例超过限额
- **WHEN** 同一限流键的请求分布到多个 web 实例并超过配置限额
- **THEN** 超限请求返回 429，不创建用户、不发邮件或启动模型调用

#### Scenario: 缓存故障
- **WHEN** 防刷缓存服务不可达
- **THEN** 受保护请求返回 503，不退回内存计数或成功响应

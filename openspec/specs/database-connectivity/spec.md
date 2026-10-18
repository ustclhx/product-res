# database-connectivity Specification

## Purpose
定义 Cloudflare 与自托管服务对同一 Postgres 数据模型的连接、资源生命周期和权限行为，确保池复用不会改变事务、租户隔离及账本并发控制的既有保证。

## Requirements

### Requirement: 双目标连接生命周期
系统 SHALL 兼容既有 Hyperdrive 输入，并支持连接串或进程拥有的数据库连接池。Node web/jobs SHALL 复用有限进程池并在优雅退出时关闭自有资源，不在每请求新建池、不关闭借用池；Cloudflare SHALL 保留每请求/事件客户端，不跨请求缓存 I/O 对象。（D1）

#### Scenario: Node 连续请求
- **WHEN** 多个请求访问同一 Node 进程
- **THEN** 共用有界连接池，完成单个请求不关闭其他请求所需的池

#### Scenario: Cloudflare 请求
- **WHEN** Workers 处理新请求或事件
- **THEN** 创建属于该调用的客户端，并保留 Hyperdrive 连接和缓存语义

### Requirement: 数据库最小权限
自托管 SHALL 保留 app、migrator、readonly 三角色，分别用于业务 DML、迁移 DDL、只读排查。运行时应用 MUST 不取得 migrator 或超级用户凭据，初始化 SHALL 复用现有 infra 权限规则，包括审计数据写保护。（D2）

#### Scenario: 验证权限边界
- **WHEN** app 尝试 DDL 或修改历史 audit_log，readonly 尝试写入，migrator 应用迁移
- **THEN** 前两者被拒绝，合法迁移成功，默认权限也覆盖迁移新建表

### Requirement: 保持事务与锁语义
Node 直连 Postgres 17 SHALL 保持显式事务、回滚、SELECT FOR UPDATE、事务级 advisory lock 和租户 scoped 查询语义；业务锁与账本规则 MUST 不因目标变化而弱化。（D4）

#### Scenario: 并发争抢与回滚
- **WHEN** 两事务争抢同一行锁或 advisory_xact_lock，先取得者提交或回滚
- **THEN** 后者在锁释放后执行，回滚不会留下业务写入或残留事务锁

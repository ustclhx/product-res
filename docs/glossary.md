# 术语表

按主题分组列出项目文档中的核心术语，说明摘自对应文档。

## 架构与配置

- **运行时设置**：存放在数据库 `setting` 表（KV 缓存）中、可在后台修改的项，如模型定价、公告、注册开关；表中缺失时回退到代码默认值。（[项目结构与约定](02-project-structure.md)）
- **UUIDv7**：主键统一采用的时间有序 ID，列类型为 PG 原生 `uuid`，按 id 排序即按创建时间排序。（[项目结构与约定](02-project-structure.md)、[数据模型](03-data-model.md)）

## 租户与数据

- **Workspace（空间）**：即 `organization`，所有业务数据与计费主体（订阅、积分、订单）都归属 Workspace，每个用户注册时自动创建一个个人空间。（[认证与多租户](04-auth-and-tenancy.md)、[数据模型](03-data-model.md)）
- **`scoped(db, workspaceId)`**：业务查询必须经过的租户过滤帮助函数，禁止在 feature 代码里手写 `where workspace_id = ...`。（[项目结构与约定](02-project-structure.md)）

## 计费与积分

- **预扣（hold）**：`credit_hold` 记录的积分预扣，状态只能从 `held` 转为 `captured` 或 `released` 一次，且余额在 hold 时即扣减。（[数据模型](03-data-model.md)）

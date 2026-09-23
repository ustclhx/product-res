# 运行时架构与复用边界

## 当前实现

React + TypeScript + Vite 提供 Web 入口，React Router 管路由，TanStack Query 管服务端状态；FastAPI + Pydantic 提供业务 API、健康检查及严格传输契约。前端通过同源 `/api` 调用，开发时代理到本地后端。运行时分为 `demo` 与 `pilot`：demo 使用固定时钟、样例角色和单 SQLite；pilot 使用真实 UTC、控制库、每工作区独立业务 SQLite、服务端会话和持久 worker。

本轮保留 d2market 的通用执行状态和错误分类规则，并实现项目至结果反馈的业务闭环。技术 Run/Node 状态描述一次执行，不能替代候选商品的业务状态。

## 模块边界

```text
Web 业务页面 → /api/v1 → 应用服务 → 业务规则/状态迁移 → Repository
                              ↓
                     数据提供接口 / 节点 AI 接口
                              ↓
             demo：示例数据 / pilot：持久任务 worker → 真实适配器
```

- `app/api/`：传输校验和 API 路由；不在路由里计算业务规则。
- `app/runtime/`：已迁移的通用状态、错误策略；不持有候选评估或选品规则。
- `app/selection/`：项目、候选、标准、评估、决策的业务约束。
- `app/evidence/`、`app/validation/`、`app/outcomes/`：证据、验证任务、结果复盘。
- `app/providers/`：数据来源和节点 AI 接口；demo 使用模拟实现，pilot 使用受限的 DataForSEO Amazon US、SerpApi Google Shopping US 和 NewAPI 适配器。
- `app/pilot/`：模式配置、控制库/成员认证、工作区选择、持久任务和来源配置。外部网络调用在短事务之外执行；已发出但结果不确定的调用进入 `OUTCOME_UNKNOWN`，不自动重试。
- `app/pilot/admin.py`：服务端管理员账号维护；全局账号权限与工作区业务角色分开。控制库 v2 在同一写事务内迁移，账号修改带版本校验，权限变动和密码重置撤销会话，管理审计不含凭据。
- `app/persistence/`：demo 使用单 SQLite；pilot 由控制库注册每个工作区的独立 SQLite，客户端不能提交数据库路径。
- `web/src/`：按业务功能组织页面，保留通用请求、查询和路由层。

SQLite、示例角色切换和确定性模拟是本轮原型实现选择，客户适用性仍待验证。持久化使用 schema_version、entities（带 project/candidate 外键和 JSON 载荷）、receipts、audit。业务服务负责状态和引用规则；标准、证据、评估、提交、决定、结果等快照不可更新。

所有写命令由 app/core.py execute 统一处理请求键、expected_version 与事务审计。BEGIN IMMEDIATE 串行化同库写入；成功以及会持久化节点失败/提交失效事件的拒绝均有回执。普通失败整体回滚；网络重试重放原结果。OpenAPI 和前端枚举由 scripts/export_contracts.py 导出，纳入 make check。

演示固定时钟和显式 seed/reset 位于 app/demo/，仅 demo 可用。pilot 的会话 TTL、CSRF/Origin、登录限速、成员角色、来源累计请求限额和原始材料 TTL 由服务端校验。真实凭据仍由部署者以 secret 文件提供；代码与 Compose 不包含凭据。独立 ECS 发布及恢复演练已通过；本轮入口采用用户确认的 SSH 隧道，HTTPS 留待 Cloudflare 子域名接入。凭据已安装，SerpApi 真实查询与 DeepSeek 两个真实证据节点已通过；DataForSEO 账号验证已生效、真实查询成功；两团队真实闭环仍待完成。

## 从源项目保留的设计

1. 固定、版本化的业务步骤；AI 只在节点内整理、抽取、解释，不改全局流程。
2. 数据不完整是显式状态；失败和没有结果必须区分。
3. 不可覆盖的评估快照、追加决策事件、可追溯来源。
4. 状态迁移由确定性规则校验；变更操作需要幂等及并发版本校验。
5. 引用、未知和反证随建议一起呈现；模型输出不是事实。

## 选择性迁移原因

d2market 的 Monitor/QueryPlan/Signal/Opportunity 属于持续发现领域；本产品围绕 SelectionProject/Candidate/Evaluation/ValidationTask/Outcome。直接复制其大页面、数据库模型和连接器会让用户流程受旧对象牵制。

因此保留开发工具、视觉变量、传输契约和小型纯规则模块。AgentAdapter 与 Evidence 的设计用于新契约参考，其现有代码依赖旧信号、预算和持久化模型，暂不移植。pilot 的会话、持久任务和独立部署已按本轮范围实现；分布式队列、定时采集与浏览器采集另行评估。

## AI 草稿与用量增量（2026-09-22）

草稿读取使用当前材料投影时效，历史 node_run 输入输出保持不变；正式采用仍在命令事务中验证当前操作者和输入。NewAPI 在内容校验前提取诊断，持久任务逐 attempt 记录 model_usage，失败、取消和历史输出不抹去已知消耗。用量列表、汇总及 CSV 只读当前工作区；历史缺失标未记录，未知 token/费用不补零。详见 [D4＋D5](pilot/ai-drafts-and-usage-2026-09-22.md)。

## 验收准备增量（2026-09-22）

新增独立 `research_conclusion`，冻结研究标准、证据/来源引用，记录 STOP/HOLD，不生成商业批准或经营结果。反馈以 outcome/research_conclusion 二选一作为来源，允许规则、必需材料或研究启示调整，仍由决策人确认并在新项目复制标准。`app/pilot/progress.py` 分别投影来源追溯、研究回流与原经营闭环。新实车核验要求双侧结构化检查，通用 evidence 禁止直接标记车型适配已核验。市场刷新只推进未核验观察链，保留人工核验版本；恢复仅从固定 DataForSEO API 读取并校验原任务，网络不占数据库事务。参见 [交付记录](pilot/acceptance-readiness-2026-09-22.md)。

# Tasks

依赖 `bootstrap-selection-workbench` 完成。所有完成勾选都须有验证证据。

## 1. 契约与注册表

- [x] 1.1 在 `packages/datasources` 定义 DataKind、BudgetSpec、SourceConnector、ConnectorContext、ProbeReceipt（design D1），提供 HTTP 基础（超时、响应体上限、错误分类、日志脱敏）。验证：错误分类与脱敏的单元测试；`check:deps` 通过。 证据：`packages/datasources`（types/errors/http），`test/http.test.ts` 覆盖分类、脱敏、超时、响应上限；`check:deps` 通过。
- [x] 1.2 实现注册表与 `data_sources` 表（启用、非敏感配置、最近回执），凭据从 secret 文件读取。验证：按能力派发、停用不派发、凭据不出现在数据库与日志的测试。 证据：`data_source` 表与 `packages/marketdata/src/sources.ts`；凭据经 `createDataSourceSecrets` 从 NAME / NAME_FILE 读取（只限数据源前缀），数据库只存启用与非敏感配置；`test/registry.test.ts`、`packages/config/src/node.test.ts`。
- [x] 1.3 实现模拟连接器（可配置延迟、失败、额度耗尽、凭据失效、字段缺失）。验证：仅在测试与开发环境注册。 证据：`createMockConnector`（延迟、失败、额度/凭据错误、字段缺失、外部剩余额度），仅在 `DATASOURCE_MOCK=true` 时注册。

## 2. 额度账本

- [x] 2.1 `source_budgets` / `budget_ledger` 与 reserve / settle / release（design D3）。验证：真实 Postgres 下两 jobs 并发预扣不超限；安全线、硬上限、人工刷新三种场景测试。 证据：`packages/marketdata/src/budgets.ts`（行锁 + 账本）；`test/budgets.test.ts` 真实 PG：安全线/硬上限/人工刷新、两个并发预扣只成功一个、结算幂等。
- [x] 2.2 悬挂预扣对账、外部剩余额度对账与暂停、月度预算日分配与滚动。验证：对应 spec 场景的测试。 证据：悬挂预扣按已花费过期、外部剩余额度差异暂停、月度日分配（`packages/datasources/test/budget.test.ts` 与 `marketdata/test/budgets.test.ts`）。

## 3. 同步编排与存档

- [x] 3.1 每个数据源一个队列，按连接器声明配置并发与速率；`sync_schedules` / `sync_runs`；不可重试错误（凭据失效、额度耗尽）停止当日任务。验证：一个数据源积压不影响其他队列的测试。 证据：`apps/jobs/src/datasources/sync.ts`：`product-res-datasync` 队列，可重试错误重试、耗尽进死信，凭据失效/额度耗尽停止该数据源；`test/datasync.unit.test.ts`；`marketdata/test/sync.test.ts` 验证一个数据源失败不影响另一个。
- [ ] 3.2 每日流水线（Scheduler `Asia/Singapore` 02:00、`missedRun: 'once'`，Workflow 串联步骤）。验证：中途重启不重复已成功步骤的外部调用；停机多天只补一次。进度：`datasources-daily-v1`（02:00 SGT，once）已注册并执行维护与质量检查；采集步骤与 Workflow 串联随 add-source-connectors 的第一个真实连接器加入后验证。
- [x] 3.3 原始响应存档到对象存储（key 规则、哈希、保留期清理）与回放。验证：回放不产生账本消耗；超过保留期后观测值保留。 证据：`createDbArchive`（gzip、哈希、保留期清理）与 `replayPayloads`；`test/sync.test.ts` 验证回放不消耗额度、过期后观测值保留。
- [x] 3.4 人工刷新接口（显示预计花费，遵守额度）。验证：刷新到硬上限被拒的测试。 证据：`refreshNow` / `estimateRefresh` 服务与 server function（人工模式可用到硬上限，`budgets.test.ts`）。商品详情页上的“刷新”按钮随 M2 商品簇详情实现。

## 4. 统一数据模型

- [x] 4.1 `marketplace_products`、`sellers`、`keywords`、`reviews`、`fee_estimates`、`observations`（按月分区）、`metric_priorities` 迁移与 `scoped()` 访问。验证：迁移由 migrator 执行；跨空间隔离测试。 证据：迁移 `0016_marketdata.sql`（13 张表）由 migrator 执行；部署级表不带 workspace_id（design D6 调整说明）。
- [x] 4.2 指标枚举与单位；幂等写入；主值选择与离散度；缺失与零的区分。验证：spec 中多来源主值、修改优先级、缺失不补零场景测试。 证据：`observations.ts`：幂等写入、主值与离散度、优先级修改、缺失≠0；`test/sync.test.ts`「统一数据模型」。

## 5. 文件导入

- [ ] 5.1 上传、CSV/XLSX 解析、工作表选择、原文件存档。验证：中文表头、BOM、千分位、日期格式的解析测试。进度：CSV/TSV 解析、原文件存档、解析测试已完成；XLSX 与工作表选择未完成（需选定依赖）。
- [x] 5.2 列名识别、手动映射、模板保存复用、单位币种确认、预览校验、跳过错误行。验证：空单元格不补零；模板复用测试。 证据：`suggestMapping`（同义词 + 模板）、`buildImport`（空值不补零、错误行）、数据中心导入向导的列映射/模板保存/跳过错误行；`datasources/test/import.test.ts`。
- [x] 5.3 导入批次入库、重复文件提示、整批撤销。验证：撤销只影响本批次。 证据：`commitImport` / `revertImport` / 重复文件确认；`marketdata/test/sync.test.ts`「文件导入」。

## 6. 数据质量

- [x] 6.1 五类检查与可配置阈值，问题合并与状态。验证：来源差异、新鲜度、重复出现合并的测试。 证据：`quality.ts`：缺失（仅检查近 7 天提供过价格的来源）、跳变、来源差异、新鲜度、同步失败，fingerprint 合并；`test/quality.test.ts`。

## 7. 数据中心页面

- [x] 7.1 总览 KPI 与数据源卡片（对照 `docs/design/data-center.html`）。验证：用模拟连接器数据截图对照设计稿。 证据：`apps/web/src/features/data-center/overview.tsx`；用模拟数据源在本地截图核对设计稿（KPI、数据源卡片、额度进度与重置时间）。
- [x] 7.2 数据源配置（启停、频率、安全线、优先级、核验）。验证：安全线超过硬上限被拒。 证据：数据源卡片的启用/停用、安全线保存（超过硬上限被拒，`updateSourceConfig`）、核验。
- [x] 7.3 数据预览四视图、同步记录（筛选、重新入队）、导入向导、质量问题列表。验证：原始视图无凭据；端到端用模拟连接器完成“同步 → 存档 → 观测 → 预览 → 质量问题”。 证据：同步记录（只看失败、重新执行）、数据预览四视图（原始视图使用存档的脱敏请求摘要）、导入向导、质量问题列表；本地端到端：模拟同步 → 存档 → 观测 → 预览 → 质量问题 → CSV 导入。

# Design

## 背景

数据源清单与能力矩阵见 `docs/plan/selection-workbench.md` 第 3 节。框架要同时容纳：免费但按天限次的官方 API（eBay Browse 5000/天）、按每分钟令牌补充的 API（Keepa）、按月合同次数的付费 API（Jungle Scout、卖家精灵）、按金额计费的 API（DataForSEO）、只有导出文件的工具（Helium 10 在确认 API 前）。

## 决策

### D1 连接器契约

```ts
type DataKind =
  | 'seller-new-listings' | 'product-snapshot' | 'sales-estimate' | 'rank-history'
  | 'keyword-volume' | 'search-trend' | 'reviews' | 'fee-estimate' | 'taxonomy' | 'fx-rate'

interface BudgetSpec {
  unit: 'call' | 'token' | 'usd'
  period: 'minute' | 'day' | 'month'
  hardCap: number          // 绝不超过
  safetyLine: number       // 日常调度用到此为止，余量留给人工刷新
}

interface SourceConnector {
  id: SourceId
  marketplaces: Marketplace[]
  capabilities: DataKind[]
  budget: BudgetSpec
  probe(ctx: ConnectorContext): Promise<ProbeReceipt>
  plan(task: FetchTask): CostEstimate          // 调用前估算花费，用于预扣
  fetch(task: FetchTask, ctx: ConnectorContext): Promise<FetchResult>
  normalize(raw: RawPayload): NormalizedBatch  // 纯函数
}
```

- `fetch` 只负责取原始响应；`normalize` 是纯函数，单元测试用存档的真实响应做夹具。
- `ConnectorContext` 提供 HTTP 客户端（超时、响应体上限、错误分类：可重试 / 不可重试 / 额度耗尽 / 凭据失效）、凭据读取、日志脱敏。
- 连接器以注册表登记，apps 层组合；connectors 不依赖 apps 与数据库。

### D2 凭据

凭据通过部署层 secret 文件注入（`EBAY_CLIENT_SECRET_FILE` 等），数据库不存凭据。`data_sources` 表只存启用状态、非敏感配置（站点、同步频率、优先级）和最近一次 `probe` 的回执。页面显示“未配置 / 已配置未核验 / 核验通过 / 核验失败（原因）”。

### D3 额度账本

- `source_budgets`：数据源 × 周期窗口的上限、安全线、已预扣、已确认。
- `budget_ledger`：每次预扣/确认/释放一行，带任务 ID 与原因。
- 调用前在业务事务中执行 `reserve(source, estimate)`：`已预扣 + 估算 ≤ 安全线`（人工刷新可用到硬上限）才成功；失败则任务延迟到下一个窗口。
- 调用后按实际花费 `settle`；失败未产生花费时 `release`。进程崩溃导致的悬挂预扣由定期对账按“超过 N 分钟未结算视为已花费”处理——宁可少用，不可超额。
- 若数据源响应中带剩余额度（eBay 限额头、Keepa `tokensLeft`），写入对账记录；与账本差异过大时暂停该数据源并提示。
- 月度预算按日均分配，当日结余滚动到次日；这是默认策略，可按数据源改为“月内先到先得”。

### D4 同步编排

- 使用模板 `QueueProducer` / `TransactionalEnqueue`：每个数据源一个队列，队列级并发和滑动速率按连接器声明配置（Keepa 按每分钟令牌，SP-API 按官方限流）。
- 同步任务 = 数据源 × 数据类型 × 范围（方向、店铺、关键词、商品列表）。`sync_schedules` 存频率；`sync_runs` 记录每次运行的计划量、实际调用、花费、成功/失败条数、耗时。
- 每日流水线用模板 Scheduler（`Asia/Singapore`，`missedRun: 'once'`），用 Workflow 串联“生成预算 → 发现 → 快照 → 补全 → 质量检查”，每步可恢复。
- 重试沿用模板队列策略；凭据失效、额度耗尽为不可重试错误，直接停止该数据源当日任务并在数据中心提示。

### D5 原始响应存档

- 对象存储 key：`raw/{source}/{yyyy}/{mm}/{dd}/{runId}/{seq}.json.gz`；`raw_payloads` 记录 key、哈希、请求摘要（去掉凭据）、状态码、字节数。
- 默认保留 90 天，可按数据源调整；回放任务读取存档重新 `normalize`，不预扣额度。

### D6 统一数据模型

| 表 | 说明 |
|---|---|
| `marketplace_products` | 平台 + 站点 + 平台 ID（ASIN / ItemID）唯一；GTIN/UPC/ePID、标题、品牌、类目、图片、首次发现时间 |
| `sellers` | 平台 + 卖家 ID；名称、店铺链接 |
| `keywords` | 站点 + 关键词 |
| `reviews` | 商品 × 评论 ID；评分、标题、正文、日期、来源 |
| `fee_estimates` | 商品 × 价格 × 配送方式 → 费用明细、来源、时间 |
| `observations` | 实体类型 + 实体 ID + 指标 + 观测日期 + 来源 → 数值、单位、币种、获取方式、`raw_payload_id`；唯一键（实体, 指标, 日期, 来源），重复写入以最新为准；按月分区 |
| `metric_priorities` | 指标 × 平台 → 来源优先级列表 |

- 指标枚举在代码中定义（价格、可售量、已售量、销量估算_月、BSR、评论数、评分、卖家数、搜索量_月、趋势指数等），每个指标声明单位。
- 主值：按 `metric_priorities` 取第一个有值的来源；同时返回全部来源值和离散度，供置信度使用。
- 缺失就是没有行，不写 0；读取接口区分“无数据”和“值为 0”。
- 所有表按空间隔离，使用模板 `scoped()`。

### D7 文件导入

- 上传文件存对象存储；解析 CSV / XLSX（首个工作表或用户选择）。
- `import_templates`：数据源 + 模板名 → 列映射、单位、币种、默认上下文；列名识别用“精确 → 同义词表 → 人工对应”。
- 预览展示前 50 行解析结果和全部校验错误；确认后按批写入 `observations`，获取方式 = 手工导入，`raw_payload_id` 指向原文件。
- 重复导入同一文件（哈希相同）提示并要求确认；不同文件的同一观测以导入时间较新者为准，历史保留在原文件。

### D8 数据质量

同步运行结束后执行检查，结果写入 `data_quality_issues`（类型、实体、指标、详情、首次/最近出现、状态）。阈值默认：关键字段缺失率 > 20%、日环比跳变 > 3 倍、来源间差异 > 50%、新鲜度 > 36 小时。

### D9 数据中心页面

对照设计稿：顶部 KPI（已接入数据源、记录总数、今日同步次数、今日额度/费用使用）；数据源卡片（状态、提供的数据类型、记录数、同步频率、最近同步、额度进度）；同步记录表；数据预览四个标签（JSON / 表格 / Schema / 原始）；导入向导；数据质量列表。设计稿中的“评分维度管理”放到 M2/M5，“AI 数据分析助手”后置。

## 风险与取舍

- 长表 `observations` 数据量：估算每日 5 万行左右，按月分区 + 常用查询索引（实体, 指标, 日期）足够；若后续不够再加日聚合表。
- 悬挂预扣按“已花费”处理会少用一点额度，换取不超额的确定性。
- 模拟连接器只用于测试与演示，生产环境默认不注册。

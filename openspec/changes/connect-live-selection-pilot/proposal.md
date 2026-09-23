## Why

初版已验证业务流程，现在需要让一个合作团队及内部自建站团队使用真实市场材料和 ECS 上的 NewAPI 完成可追溯的数据闭环。验收以数据从采集进入决策、验证和结果反馈为准，不预设人工工时改善或经营收益。

## What Changes

- 增加独立 ECS 试点部署、真实身份与两个隔离工作区，保留初版离线演示模式。
- 引入持久后台任务，在事务外采集和调用模型；支持有界重试、取消、重启恢复、版本重检及调用记录。
- 首批实现 DataForSEO Amazon US 与 SerpApi Google Shopping US 两个可配置连接器：真实发现批次、显式纳入、标准化证据和来源追溯。缺凭据明确未配置，不能降级为假真实数据。
- 通过同机 NewAPI 接入真实节点 AI；模型可配置，先完整支持评估整理，再接补证与结果偏差复盘。结构、引用、版本及人工决定边界不变。
- 细化字段口径及候选—SKU/测试标识—批准轮次映射；以真实人工/CSV 经营结果回填完成反馈，保留自动店铺连接器的扩展位置。
- **BREAKING（仅 pilot 模式）**：客户端 actor_id 不再作为身份来源，固定时钟、示例种子与重置不可作用于真实工作区；真实 API 使用异步任务返回，前端展示排队、执行和待复核状态。
- 本轮不接入 Keepa、Rainforest、eBay 生产 API、Shopify/WooCommerce 自动同步，不新建店铺，不自动采购/刊登/投放，不预设工时门槛；这些保留为后续独立变更。

## Capabilities

### New Capabilities
- `pilot-runtime`: 登录、工作区隔离、运行模式、后台执行、凭据配置及独立 ECS 部署恢复。
- `market-data-connectors`: 两个真实来源的查询、标准化、质量、配额和可追溯发现批次。
- `newapi-assistance`: 同机模型接入、结构化输出、输入边界、调用记录和错误恢复。

### Modified Capabilities
- `candidate-intake`: 从仅样例发现扩展为已配置真实来源和显式发现批次纳入。
- `candidate-evaluation`: 同时支持模拟与真实节点输出，保留版本、引用与人审要求。
- `evidence-screening`: 区分外部观测、核验及估算，增加可追溯来源批次和真实标记。
- `outcome-feedback`: 真实、测试与样例结果分开，并明确 SKU/批准映射及人工/CSV 回流验收。
- `prototype-experience`: 保持业务入口，增加真实试点的运行状态、模式隔离和双团队闭环验收。

## Impact

涉及配置、认证、存储迁移、任务 worker、provider、API、前端状态、部署与测试。复用现有 FastAPI/SQLite 业务基础和 d2market 的部署/模型传输设计，使用 product-res 独立 Compose 项目、文件和凭据引用，不改 d2market 服务与数据库。测试 ECS 为 43.106.17.72；本轮只读核查确认 2 vCPU、约 3.5 GiB 内存、NewAPI 状态与模型清单正常，尚未部署 product-res 或进行模型生成。

外部依赖：两个市场 API 账号/试用凭据、product-res 的 NewAPI 凭据、团队真实结果材料、合作团队可访问的 SSH 隧道（本轮），后续接入 Cloudflare 子域名 HTTPS。接口可先以契约样本开发，live 验收依赖真实授权，不以样例测试冒充完成。资料见 `research/amazon-data-sources-2026-09-20.md`、`research/ebay-dtc-data-sources-2026-09-20.md`。

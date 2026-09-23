# Product Res · 跨境选品工作流

面向已有跨境经验团队的选品工作流：项目与标准 → 候选 → 补证初筛 → 评估 → 人工决策 → 验证任务 → 结果复盘 → 下一轮标准。

仓库同时提供两个明确隔离的运行模式。`demo` 是本地离线演示，使用固定时钟、样例角色和可重置样例；`pilot` 是已实现的独立试点运行时，使用服务端登录、两个隔离工作区、持久 worker、DataForSEO Amazon US、SerpApi Google Shopping US 和 NewAPI 配置入口。pilot 支持人工/CSV 的 REAL、TEST、DEMO 结果分类和反馈闭环，凭据已安装；SerpApi 与 DataForSEO 均已取得真实市场线索，真实结果材料和团队效果仍待试点验证。

## 本地启动

需要 Python 3.12、uv，以及满足 `web/package.json` engines 的 Node（建议 Node 24）和 npm。

```sh
make setup
```

两个终端分别运行：

```sh
make api
```

```sh
make web
```

打开 `http://127.0.0.1:5173`。前端代理 `/api` 到 `127.0.0.1:8000`；健康检查为 `/api/v1/health`，OpenAPI 文档为 `/docs`。这组命令启动的是 `demo`；pilot 的创建、配置和启动见 [pilot runtime 指南](docs/pilot/runtime.md)。

若 8000 已被其他应用使用，可改用 `uv run --frozen uvicorn app.main:app --host 127.0.0.1 --port 8002`，并以 `VITE_API_TARGET=http://127.0.0.1:8002 make web` 启动前端。本次预览使用这一组合。

## 样例与持久化

空库不会静默加载样例。在工作台切换为决策负责人，明确初始化示例数据后，可查看待补证、待决策、逾期和待结果队列。固定演示时钟为 `2026-09-20T08:00:00Z`，样例版本为 `selection-workflow-demo-v1`；不把演示时钟当实时市场时间。

默认数据库为 `.local/workspace.sqlite3`。重启保留操作。可以设置 `PRODUCT_RES_DB=/absolute/path/workspace.sqlite3` 使用另一个独立数据库，前端通过 `VITE_API_TARGET` 覆盖开发代理。运行时不依赖 d2market 源目录。

重置位于工作台的展开区域，需要显式确认，仅清空当前数据库业务与试用记录并恢复样例。需要保留记录时先备份 SQLite 文件；不要手动改写不可变快照。

候选 CSV 示例在 `fixtures/demo/candidates.csv`，结果 CSV 示例在 `fixtures/demo/outcomes.csv`。结果文件中的候选/SKU/批准标识需要映射到当前工作区；无效或多义映射会阻止确认。仅支持 UTF-8 CSV，最多 2 MiB、1000 行。

## 检查

```sh
make check
cd web && npm run test:e2e
```

`make check` 包含 OpenAPI/前端枚举漂移检查、Python lint/types/tests、前端 lint/build 和请求键测试。接口变化后运行 `make contracts` 更新受版本管理的契约快照。

浏览器测试启动独立数据库、API 8001 和前端 5174，默认使用本机 Google Chrome；可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定 Chromium 可执行文件。浏览器与依赖安装需可用网络或本地缓存，正常业务运行不需要外部服务密钥。

## 业务边界

- 事实、估算和假设分开；样例标记独立于核验状态。模拟整理必须由人检查，不自动批准。
- 缺失/过期/冲突输入要求补证；人工例外保留理由，变化后重新确认。
- 决策绑定当时的标准与评估；旧版本冲突不会覆盖先到决定，网络重试复用命令键。
- 任务完成不代表商业成功。结果保留窗口、币种、来源与收入口径；未知不补零，未上市明确记录。
- 反馈标准需负责人确认，只用于下一轮；原批准依据保持不变。
- `demo` 是本地单工作区演示，不代表认证、租户隔离或外部调用能力；`pilot` 才启用服务端认证、工作区隔离、真实 UTC、持久任务和外部适配器。两者不共享运行数据，pilot 禁止演示初始化和重置。
- 两个真实市场适配器和 NewAPI 已实现并受配置、授权、工作区累计限额和超时约束；未提供凭据时保持未配置，不能把测试回执当作真实试点完成。
- ECS 独立部署已通过工程验证；独立 HTTPS 入口及两团队真实闭环尚未完成，不声称已验证客户效果。

## 文档

- [产品范围](PRODUCT.md) · [界面准则](DESIGN.md) · [架构](docs/architecture.md)
- [试用走查](docs/demo/walkthrough.md) · [规格验收映射](docs/demo/acceptance.md)
- [后端、市场数据与 AI 建设建议](docs/backend-data-ai-roadmap.md)
- [真实试点实施提案](openspec/changes/connect-live-selection-pilot/proposal.md) · [开发任务](openspec/changes/connect-live-selection-pilot/tasks.md) · [字段与数据源说明](docs/pilot/data-fields-and-sources.md)
- [d2market 复用评估](docs/d2market-reuse.md) · [市场调研](research/cross-border-product-selection-ai-agents-2026-09-16.md)
- [OpenSpec 实施任务](openspec/changes/archive/2026-09-20-build-selection-workflow-prototype/tasks.md)

源 d2market 仅作只读参考；未迁移真实环境、密钥、运行数据、业务数据库和生产连接器，已有研究文档保持原样。

Pilot 已部署于独立 ECS 容器，目前通过 SSH 隧道访问。完整工程及外部调用边界见 [验证记录](docs/pilot/verification-2026-09-20.md) 和 [现场部署记录](docs/pilot/ecs-readiness-2026-09-20.md)。NewAPI 已切到 DeepSeek 官方渠道，三个节点的真实生成 smoke 通过；市场凭据已安装，SerpApi 查询与基于真实观察的补证/评估生成已通过；DataForSEO 账号验证已生效，Amazon 查询成功（0.0033 USD），真实业务闭环仍待验收。管理员按 [凭据交接与启用清单](docs/pilot/credential-handoff.md) 接入，合作团队按 [试用指南](docs/pilot/team-trial-guide.md) 执行。

本轮试点方向为车辆内饰，先用 SSH 隧道，后续接现有域名的 Cloudflare 子域名。见 [车辆内饰试点指南](docs/pilot/vehicle-interior-pilot.md) 与 [数据源账号开通步骤](docs/pilot/market-account-setup.md)。

最新状态见 [车辆内饰真实市场接入记录](docs/pilot/live-market-verification-2026-09-21.md)。首轮研究允许仅确认必需证据、不设商业淘汰阈值；缺失或未核验材料仍要求补证。

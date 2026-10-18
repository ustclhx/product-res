# Design

## 背景

saas-template 已交付 `--target selfhost`：Node web/jobs、Postgres 17、Valkey、对象存储、DBOS 队列/调度/多步任务，并在新加坡 ECS 完成整机重启验收。本 change 只做“生成 + 骨架 + 主题 + 部署”，不写业务逻辑。

## 决策

### D1 生成到临时目录再并入

生成器要求 `--output` 是模板目录外、尚不存在的路径，并且不复制 `openspec/changes`。做法：

1. 在 scratch 目录生成：

   ```
   pnpm create-project --name product-res --domain <域名> --target selfhost \
     --output <tmp>/product-res --image-namespace ghcr.io/ustclhx/product-res \
     --ai text --billing '' --billing-enabled true --credits-enabled true \
     --marketing false --i18n false --locale zh --features '' --oauth ''
   ```

2. 把生成结果复制进本仓库根目录；冲突文件只有 `.gitignore` 和 `openspec/config.yaml`：`.gitignore` 合并两边条目，`openspec/config.yaml` 保留本仓库版本（含项目 context）。
3. 生成器自检（typecheck + 单元测试）在临时目录通过后再并入；并入后重新运行一次。

### D2 billing 开启但不接支付

生成器规定关闭 billing 必须关闭 AI。本项目需要 AI（归并、痛点归纳、理由生成），因此 billing、credits 开启、Provider 列表为空。迁移后运行 `pnpm billing:seed`，在 `/admin/models` 创建模型，在 `/admin/billing/plans` 给 free 套餐授权。面向用户的定价、订阅、充值入口隐藏（导航不展示），后台保留以便查看 AI 用量。

### D3 共享账号

只创建一个团队账号与一个空间；`BOOTSTRAP_ADMIN_EMAILS` 配置该账号以便访问 `/admin`。不新增角色模型。注册入口在初始化后关闭或限制为邀请（沿用模板的配置项；若模板没有关闭注册的开关，记录为待办，不在本 change 自行实现认证变更）。

### D4 主题映射

设计稿 token → `packages/ui/src/styles/globals.css`：

| 设计稿 | 主题变量 |
|---|---|
| `#1677ff` | `--primary`（hover `#4096ff`，active `#0958d9`） |
| `#52c41a` / `#faad14` / `#ff4d4f` | `--success` / `--warning` / `--destructive` |
| `#262626` / `#595959` / `#8c8c8c` | `--foreground` / 次级文字 / `--muted-foreground` |
| `#f0f0f0` / `#f5f5f5` | `--border` / 页面背景 |
| 圆角 8 / 12 | `--radius` 8px，卡片 12px |
| Inter + Noto Sans SC，JetBrains Mono | `--font-sans`、`--font-mono`；字体随应用自托管，中文回退系统字体 |

设计稿只有浅色；暗色沿用模板默认，不阻塞本 change。

### D5 图表

选 ECharts（雷达、瀑布、折线、气泡，词云用 `echarts-wordcloud`）：设计稿需要的图表类型齐全，词云在 Recharts 中没有。按需引入模块，封装为 `packages/ui` 的 `Chart` 容器（尺寸自适应、主题色、空数据态）。

### D6 导航与路由

| 导航 | 路由 |
|---|---|
| 工作台 | `/app/$slug/` |
| 跟卖选品 | `/app/$slug/follow` |
| 品牌选品 | `/app/$slug/category` |
| 选品档案库 | `/app/$slug/archive` |
| 算法验证 | `/app/$slug/validation` |
| 数据中心 | `/app/$slug/data` |
| 设置 | `/app/$slug/config`（模板已有的 `/app/$slug/settings` 是空间设置，保留不动） |

占位页显示页面名称和“将在 Mx 提供”，不显示假数据。

布局对照设计稿：左侧 200px 深色侧栏（`#001529`，选中项主色底）、白色顶栏（面包屑 + 账号）、内容区背景 `#f0f2f5`。模板原有的 AI 对话、空间设置、用量入口收进顶栏账号菜单；计费入口不展示。保留 `workspace-name`、`current-user` 测试标识。

## 风险与取舍

- 并入时误覆盖本仓库文件：并入前 `git status` 干净，并入后逐项检查 `docs/` 与 `openspec/changes/` 未变。
- 模板后续升级：本仓库记录生成所用的模板 SHA，后续升级按模板说明人工合并。

# Proposal

## Why

方案（`docs/plan/selection-workbench.md`）已确认改用 saas-template 的自托管目标重建选品工作台，旧 pilot 已冻结在 `frozen/selection-workflow-pilot`。后续数据层、算法和页面都需要一个已部署、可登录、视觉与设计稿一致的空壳作为基础；模板生成参数中 billing 与 AI 的绑定、生成器不能输出到已有仓库这两个限制也要在第一步解决。

## What Changes

- 用 `create-project --target selfhost` 生成项目到临时目录，再并入本仓库 main：保留 `.git`、`docs/`、`openspec/changes/` 和本仓库的 `openspec/config.yaml`。
- 模块选择：保留 auth、admin、db、jobs、ai（text）、storage、ui；billing 与 credits 保持开启但支付渠道为空，free 套餐授权所需模型；关闭营销页、博客、i18n、waitlist、newsletter、public-api、OAuth；界面语言中文。
- 团队共用一个账号和一个空间；不提供分工、指派、审批和角色切换。
- 按设计稿建立导航骨架：工作台、跟卖选品、品牌选品、选品档案库、算法验证、数据中心、设置；各页面先为占位，后续 change 填充。设计稿中的评审中心不实现。
- 把设计稿的配色、字体、圆角、阴影映射为 `packages/ui` 主题变量；引入 ECharts 并封装图表容器；新增等级标签、状态标签、风险卡片、置信度条、来源徽标等业务组件。
- 部署到新加坡 ECS（沿用模板的 Compose 与发布流程），验证登录、健康检查与每日定时任务写库。

## Capabilities

### New Capabilities

- `workbench-shell`：工作台导航结构、共享团队账号、主题与业务组件、AI 在无支付渠道下可用、部署后的基础健康要求。

### Modified Capabilities

无。模板带入的 `user-auth`、`workspace-tenancy`、`selfhost-deployment`、`job-scheduling`、`system-health` 等规格按原样适用。

## Impact

- 本仓库从“只有文档”变为完整的 TanStack Start + Postgres monorepo；`docs/design/` 的 HTML 设计稿作为视觉依据保留。
- 依赖 saas-template 当前 main（b5970a9 及之后）的生成器与自托管交付物；部署方案本身归模板负责。
- 需要准备：域名、镜像仓库命名空间（`ghcr.io/ustclhx/product-res`）、ECS 上的 secret 文件、AI 模型的服务商密钥。
- 不包含任何业务数据、数据源或算法；不涉及 Cloudflare 目标。

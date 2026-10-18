# Tasks

## 1. 生成与并入

- [ ] 1.1 记录所用 saas-template SHA；在 scratch 目录按 design D1 参数生成项目。验证：生成器自检（typecheck + 单元测试）通过，初始化清单保存到 `docs/runbooks/bootstrap-checklist.md`。
- [ ] 1.2 并入本仓库 main：合并 `.gitignore`，保留本仓库 `openspec/config.yaml`、`docs/`、`openspec/changes/`。验证：`git diff --stat` 中 `docs/` 与 `openspec/changes/` 无变化；`pnpm install && pnpm typecheck && pnpm test` 通过；`openspec validate --all --strict` 通过。
- [ ] 1.3 迁移后运行 `pnpm billing:seed`，创建文本模型并授权 free 套餐。验证：团队账号的服务端 AI 调用成功并在后台有用量记录。

## 2. 外壳

- [ ] 2.1 建立七个一级导航与路由（design D6），占位页无示例数据；隐藏定价、订阅、充值入口。验证：路由与导航的单元测试；人工检查无支付入口。
- [ ] 2.2 主题映射（design D4），字体自托管。验证：断网外部字体时页面正常；与设计稿截图对比主色、圆角、字体。
- [ ] 2.3 业务组件：等级标签、状态标签、风险卡片、置信度条、来源徽标。验证：等级阈值（75/74/49）与冷启动“未验证”的组件测试。
- [ ] 2.4 引入 ECharts，封装图表容器（雷达、瀑布、折线、气泡、词云，空数据态）。验证：组件测试覆盖空数据；`check:deps` 通过。

## 3. 共享账号与部署

- [ ] 3.1 创建团队账号与空间，配置 `BOOTSTRAP_ADMIN_EMAILS`；确认模板是否支持关闭公开注册，不支持则记录待办。验证：两台设备同时登录正常。
- [ ] 3.2 按模板 `deploy/selfhost` 发布到新加坡 ECS。验证：登录成功、健康检查通过、示例定时任务在 02:00 SGT 写入运行记录并在健康检查中显示。

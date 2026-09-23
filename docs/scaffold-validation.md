# 初始化验收记录

日期：2026-09-20。

- 在 product-res 自己的 `.venv` / `web/node_modules` 安装依赖，锁文件分别为 `uv.lock` 与 `web/package-lock.json`；不链接 d2market 的依赖目录。
- `UV_CACHE_DIR=/tmp/product-res-uv-cache make check` 通过：Ruff、Mypy、7 项 Python 测试、ESLint、TypeScript/Vite build、1 项前端幂等键工具测试。
- Python 测试覆盖健康检查、严格字段校验、显式时区与 UTC、技术状态合法/非法迁移、重试耗尽。
- TestClient 的第三方依赖出现 2 条弃用警告，当前测试通过；后续升级时处理，不代表业务流程已验证。
- 实际启动回环地址上的 FastAPI 与 Vite，浏览器确认健康代理返回可用，工作台、选品项目、验证任务三个路由可进入且标题随路由变化。
- 当前无业务数据库、真实数据连接、真实 AI 或生产认证。上面的通过只验收初始化骨架。
- [迁移哈希清单](reuse-manifest.json) 记录选定源文件与目标文件的 SHA-256；`adapted` 表示裁剪、改名、归属说明或其他适配，并不声称逐字相同。

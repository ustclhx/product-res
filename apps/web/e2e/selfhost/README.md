# Node Compose 认证验收夹具

只用于 `add-selfhost-foundation` 9.3 的本地验收；不加入正式镜像和生产 Compose。
主 runbook 负责镜像构建、证书、空卷启动、权限与资源检查和最终 `down -v`。

- 构建模板变体启用 `auth.emailPassword`、`auth.requireEmailVerification` 和
  `tenancy.multiTenant`，关闭 Turnstile 和 OAuth。功能开关仍在构建模板层。
- 真实 jobs Node 入口加载 `--import /fixture/preload.mjs`，保留 B 持久队列、共享邮件
  handler、模板 renderer 和 Resend sender。用只读 bind mount 将此目录挂到 `/fixture`。
- capture 服务使用 Node 22、非 root 用户、只读夹具挂载，启动
  `node /fixture/capture.mjs`，加入 jobs 所在的 Compose 内部网络，不配置 `ports`。
  可用 `fetch('http://127.0.0.1:8025/health')` 作内部健康检查。
- preload 只将原 sender 的 `https://api.resend.com/emails` POST 重定向到
  `http://capture:8025/emails`，移除 Authorization，拒绝其他 Resend 请求和捕获端重定向。
  capture 没有外部请求代码，不发送邮件；真实 API key 不应提供给此验收环境。
- capture 按 `idempotency-key` 内存去重，GET `/emails?to=…` 仅供测试通过
  `docker compose exec -T capture` 读取。重启 capture 会清空捕获记录；测试需在注册前启动它。
  邮件正文与验证 token 不写日志、附件或磁盘。

从根目录运行：

```sh
SELFHOST_COMPOSE_FILE=/absolute/path/acceptance-compose.yaml \
SELFHOST_BASE_URL=https://selfhost-final.local \
pnpm --filter @product-res/web exec playwright test --config playwright.selfhost.config.ts
```

`SELFHOST_COMPOSE_FILE` 支持多个 Compose 文件，用操作系统路径分隔符分隔（Linux/macOS
为 `:`）。`COMPOSE_PROJECT_NAME`、`COMPOSE_ENV_FILES` 及其他 Compose 环境变量从测试父进程
继承。请与启动容器时使用相同的项目和环境；不将 secret 放入命令行。

浏览器用 host resolver 将 URL 中的域名解析到 `127.0.0.1`，保留真实 HTTPS origin 与 Secure
cookie。浏览器允许验收自签证书；CA 信任需另用 `curl --cacert` 验证。未开启
trace、video 和 screenshot，避免记录验证链接、密码与 cookie。不要使用 Playwright 调试日志
或将 capture 输出重定向到文件。

测试验证注册提示与未验证登录拒绝、队列实际送达邮件、邮件链接验证、真实 UI sign-out、
旧会话失效、密码登录、团队创建、个人/团队切换、owner 身份和相应管理入口，最后检查
依赖健康状态与完整 SHA。测试只通过应用产生业务数据，不读取 Postgres token。

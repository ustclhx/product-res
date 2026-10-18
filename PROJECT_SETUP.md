# product-res selfhost 初始化清单

## 启用功能

- billing=true / credits=true / marketing=false / i18n=false（默认语言 zh）
- AI：text

## 运维与资源

- [ ] OCI namespace：ghcr.io/ustclhx/product-res；替换 configure-owner 为自己的 registry owner，发布项目自身镜像
- [ ] Linux / Docker Engine / Compose v2；只拉取同一个完整 SHA 的镜像与 release bundle，不在服务器构建
- [ ] Postgres 17 TLS 与 app / migrator / readonly；Valkey；专用 ingress，默认 Caddy 或现有代理
- [ ] 受限 secrets/ 与 certs/；非 root 服务 UID 可读，数据服务不开放宿主端口
- [ ] 邮件：默认 EMAIL_TRANSPORT=log；生产按 Node 邮件适配器配置 SMTP 或 Resend
- [ ] 外部应用 S3/R2：需要文件存储或清理能力时叠加 compose.s3.yaml，核对 release bundle 已装配 S3 env / _FILE 与受限应用身份；缺失则停在配置缺口
- [ ] 备份：主 S3 与独立凭据恢复副本目标（允许不同供应商/账号）；同一 R2 账号方案使用独立桶与桶级独立 token，记录失去供应商独立性及账号级共同故障风险；核验副本 token 无主桶权限、WAL/base/dump、保留策略与新空卷恢复演练
- [ ] 副本健康：BACKUP_REPLICA_MAX_AGE_SECONDS 必须大于 BACKUP_REPLICA_INTERVAL_SECONDS，至少为间隔 3 倍，并覆盖完整同步、verify/锁等待与余量；默认 300/3600 秒，检查主机显式旧值，健康预算不等于 RPO
- [ ] ownership 持久卷、唯一 executor ID、容器重建与宿主重启退出证据；未签收前禁止声明恢复验收成功
- [ ] 发布后有界检查 /api/health 与 jobs 的完整 SHA 和成功 heartbeat；回滚须确认 schema/持久任务兼容
- [ ] 数据库：迁移后运行 pnpm billing:seed；AI 模型与套餐授权在后台配置
- [ ] 文本服务商：按 Node Provider 配置密钥与后台模型价格

## 应用配置键（密钥使用受限文件与对应 _FILE；值保持为空）

- APP_URL
- APP_VERSION
- EMAIL_TRANSPORT
- EMAIL_FROM
- EMAIL_REPLY_TO
- SENTRY_ENVIRONMENT
- PAYMENT_MODE
- BETTER_AUTH_SECRET
- BOOTSTRAP_ADMIN_EMAILS
- DATABASE_URL
- MIGRATION_DATABASE_URL
- VALKEY_URL
- OPENAI_API_KEY
- ANTHROPIC_API_KEY
- GOOGLE_API_KEY
- DEEPSEEK_API_KEY

## Compose secret 文件

- secrets/postgres_password
- secrets/app_db_password
- secrets/migrator_db_password
- secrets/readonly_db_password
- secrets/app_database_url
- secrets/migrator_database_url
- secrets/valkey_password
- secrets/valkey_url
- secrets/auth_secret

复制 deploy/selfhost/.env.example 后配置 namespace、同 SHA 镜像、域名、TLS 与受限 secret 文件；参考 deploy/selfhost/README.md 和 secrets.example。
发布 CI 以 namespace 输入装配 IMAGE_NAMESPACE：

    gh workflow run selfhost-publish.yml --ref main -f sha=<full-40-character-main-sha> -f namespace=ghcr.io/ustclhx/product-res

生成副本的功能配置必须重新构建镜像。PR 不获得 registry 写入或服务器 secret，正式发布使用受信提交和完整集合 gate。
迁移后运行 pnpm billing:seed，并配置模型与套餐授权。
BOOTSTRAP_ADMIN_EMAILS 可选，仅 web；已验证且未封禁账号才提升；移除名单不会自动撤销管理员。
自检仅验证单元测试；上线前独立完成 Compose、登录/空间、heartbeat、SHA 与恢复验收。

## 交付材料状态

部署/回滚：deploy/selfhost/deploy.sh；初始化：deploy/selfhost/init-server.sh；bundle：deploy/selfhost/release/bundle.py；外部代理：deploy/selfhost/compose.proxy.yaml。仅继承已交付文件，下列缺失项仍待 owner 交付；恢复脚本尚未交付不代表可做异机恢复。首次真实 registry 发布与 B/D ownership 签收仍待协调者确认，部署成功不等于备份/恢复验收。

生成副本已继承现有发布/Compose 材料；仍需实际发布与部署验收。

## 页面与语言

- 营销页面关闭，/ 重定向至 /app，作为应用入口；营销路由不可用。
- 仅编译所选默认语言 zh；页面路径无语言前缀，其他语言前缀返回 404；不显示语言控件，忽略账号语言、cookie 与 Accept-Language。

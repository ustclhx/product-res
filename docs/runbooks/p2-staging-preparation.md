# Staging 发布准备

按 [Neon staging](staging-neon.md) §1–4 完成独立数据库、受限角色、Hyperdrive、文件桶、Worker secrets 与 GitHub `staging` environment；支付启用时另读 [支付联通](p2-payment-integration.md)。先核对新项目资源、实际 URL 与完整 SHA，再执行获授权的迁移、seed 和发布。凭据从被忽略且权限为 600 的 `.env.staging-neon` 加载，核对目标数据库与角色，避免回退到本机同名库。


```bash
set -a
. ./.env.staging-neon
set +a
psql "$NEON_MIGRATOR_URL" -X -v ON_ERROR_STOP=1 \
  -c 'select current_database(), current_user'
MIGRATION_DATABASE_URL="$NEON_MIGRATOR_URL" pnpm --filter @product-res/db db:migrate
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
pnpm --dir apps/web exec wrangler queues create product-res-events-staging --env staging
pnpm --filter @product-res/jobs deploy:staging
APP_VERSION="$(git rev-parse HEAD)" pnpm --filter @product-res/web deploy:staging
```

队列已存在后跳过 create；发布顺序与配置见 [Cloudflare 官方 Queues 配置说明](https://developers.cloudflare.com/queues/configuration/configure-queues/)。

日常发布使用 `.github/workflows/deploy-staging.yml`（main 成功 CI → 迁移 → jobs → web → 版本探活 → 浏览器冒烟）；上面的手工命令仅用于明确授权的首次准备或重验。billing 关闭时跳过 seed 与支付配置。已有队列先核对归属再复用。

发布后运行：

```sh
node scripts/staging/wait-healthy.mjs "${STAGING_URL:?先设置本项目 staging URL}/api/health" "$(git rev-parse HEAD)"
STAGING_URL="$STAGING_URL" pnpm --filter @product-res/web exec playwright test --project staging
```

核对 HTTP 200、数据库 up、完整 SHA、按调度推进的 jobs 心跳，以及注册/登录和所启用功能。支付只能在已确认的测试账户中按支付 runbook 验证；健康与价格 seed 通过不能代替购买、回调验签和去重验收。结果写入 `EVIDENCE_DIR`，PR 只引用本项目私有记录。


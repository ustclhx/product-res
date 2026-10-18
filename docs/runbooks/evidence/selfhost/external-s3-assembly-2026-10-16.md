# 外部 S3 发布装配验证（2026-10-16）

协调者授权补齐配置缺口，本批分支 `ustclhx/selfhost-external-s3` 从最新
`origin/main`（`6b0a872e10c7f056f84d0ed1d78c2bb58a9ce2fb`）创建。
[PR #235](https://github.com/ustclhx/product-res/pull/235) 的验收范围/授权记录保持独立，
本批不勾选真实 R2 或服务器验收任务。

`compose.s3.yaml` 只向 web/jobs 装配四项公开 S3 配置与两份应用凭据 `_FILE`。
未加载时基础 Compose 不要求 S3 配置或文件；加载时不启动自带对象服务，仍保留迁移、
网络、镜像与原有 secrets。应用身份不分配给 PG、migrate、Caddy 或 backup，备份身份
不分配给应用。所需权限、UID、HTTPS endpoint 和浏览器 CORS 见
[外部存储 runbook](../../selfhost-c-storage.md#正式-bundle-的外部-s3--r2-配置)。

| 验证 | 结果 |
| --- | --- |
| Node22 `pnpm check` | 通过 |
| Node22 `pnpm typecheck` | 14/14 通过（缓存） |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/selfhost/release -p 'test_*.py' -v` | 8/8 通过，含真实 Compose CLI 渲染、配置缺项拒绝与17/24项旧版材料 |
| `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/selfhost -p 'test_deploy.py' -v` | 10/10 通过 |
| `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @product-res/config test` | 56/56 通过 |
| `openspec validate add-selfhost-storage-observability --strict` | 通过，1.7 仍未完成 |
| 正式 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2` 旧材料兼容 | 新打包器按旧 Git 对象重建，manifest 与原 artifact 完全相同；包内旧校验器与干净 Compose config 通过，没有注入新 S3 文件 |

新 bundle 白名单为25项运行文件、28项 checksum；旧17/24项材料保持自己的精确契约。
Compose 测试仅使用无真值 example、虚构 endpoint 和合成镜像清单，不创建 secret、
不拉镜像或启动容器，不向外部 S3 请求。没有修改主机、DNS/R2、生产或 staging，
没有发布镜像或修改旧 bundle。待独立 PR 合并、协调者发布新 SHA 后，才从可信新集合
继续真实 R2、服务器部署与剩余验收。

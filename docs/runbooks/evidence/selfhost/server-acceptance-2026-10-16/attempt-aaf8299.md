# 正式 aaf8299 部署尝试与后续入口

2026-10-16，使用成功 [publish run 38915732484](https://github.com/ustclhx/product-res/actions/runs/38915732484)
的完整 SHA `aaf82995a06454f2c96328da90da37f59e61a73d`、正式 image-set 与 release artifact。
八服务、amd64/arm64 smoke 均成功；包内 verify、干净 example compose-config 通过，
fixture=false、rollbackCompatibleWith 为空。没有重新触发发布或修改正式 bundle。

## 阻塞：部署器拒绝已校验的 compose.s3.yaml

在获准主机 `product-res-ecs` 执行原版入口：

```sh
/root/selfhost-prep/aaf8299-bundle/deploy.sh --local \
  --dir /opt/product-res-selfhost \
  --sha aaf82995a06454f2c96328da90da37f59e61a73d \
  --bundle /root/selfhost-prep/aaf8299-bundle \
  --compose-file compose.s3.yaml \
  --compose-file compose.backup.yaml --compose-file compose.replica.yaml \
  --env-file .env.backup --env-file .env.replica
```

退出 1，固定错误：`Compose file must belong to the verified bundle`。
`deploy.py:65` 同时检查 manifest 成员和文件名；`compose.s3.yaml` 确实在 manifest 中，
但旧规则 `compose(?:\.[a-z-]+)?\.yaml` 排除了数字 3。失败发生于 Compose 计划构造，
在 config/pull/迁移/启动之前；已导入不可变 release 目录，尚无成功/尝试 state.json。
主机核对：没有 selfhost 镜像或容器，没有迁移、ACME、备份或 reboot。

源码最小修复仅允许 Compose 文件名的后缀含数字，保留 manifest 成员、路径、checksum、
非 root、网络、镜像固定等原有门。新增一个真实 Compose 构造边界回归，未 mock Compose：
旧源码报同一错误，修复后允许 S3+backup+replica，未列入 manifest 的文件和目录穿越仍拒绝。
另用真实 Docker Compose CLI、修复源码及原下载包的完整四文件组合完成只读渲染，七服务
均为正式 digest；这是本地修复验证，**不是新正式发布或服务器部署成功**。

按 [deploy-selfhost 技能 §3.2](../../../../../.agents/skills/deploy-selfhost/SKILL.md)：
“发布新SHA集合/bundle后再继续；不能修改已发布bundle或绕过门”。
因此保留主机与凭据准备，停止后续运行验收，等待协调者审阅修复并提供新的正式发布。
不要现场替换 aaf8299 的 deploy.py、checksum 或白名单，也不要省略外部 S3 来代验。

## 已完成准备与保留状态

- Cloudflare 控制台只新增 `selfhost.ezarouter.cc` A → `43.106.17.72`，代理关闭；
  主机解析已确认该 IP。其他 DNS、生产 Cloudflare 与 staging 未修改。
- 创建 `selfhost-files`、`selfhost-backups`、`selfhost-backups-replica`，位置提示 apac。
  三份独立账户 token 各限对应单桶的对象读写，不授予桶管理；尚未用 S3 请求验证权限隔离。
- 业务桶 CORS 仅允许 `https://selfhost.ezarouter.cc` 的 PUT/GET/HEAD，允许
  Content-Type/If-None-Match，暴露 ETag/Content-Length/Content-Type/Content-Disposition。
  尚未执行真实浏览器上传或 copier 验收。
- 主备份 `acceptance-20261016/pg17/` 前缀设置 35 天 Bucket Lock。副本该前缀下
  basebackups_005、wal_005、logical 分别无限保留；不锁需更新的 replica/manifest.json。
  两备份桶生命周期只保留默认“7 天中止未完成 multipart”，无按年龄删除对象/WAL/history。
  后续须验证锁与实际 WAL-G/复制/保留操作兼容；目前没有上传备份对象，不能宣称通过。
- 六份 S3 凭据均仅通过控制台 Copy 按钮→剪贴板→0600 文件，随后清空剪贴板；
  本机位于 `~/.config/product-res/selfhost-{files,backups,replica}-{access-key,secret-key}.secret`。
  主机 `/opt/product-res-selfhost/secrets/` 对应 s3、backup_s3、backup_replica_s3 文件，
  应用 UID1000、备份 UID999，文件0600；没有输出凭据值或保存 API token 原值。
- `/opt/product-res-selfhost` 0700，三份 env 0600，PG CA/含 DNS:postgres SAN 的证书与独立
  随机角色/认证 file secrets 已创建。CA 私钥仅留在受限 `/root/selfhost-prep/`。
  已下载包位于 `/root/selfhost-prep/aaf8299-bundle`，同版不可变副本在部署目录 releases 下。
  未运行空白 init、未改 Docker、SSH 或防火墙。
- 发布模板启用 OAuth/Turnstile，相关字段只填本环境未配置标识和独立随机文件；未复用
  生产/staging 凭据、未调用这些集成，不宣称登录或真实邮件验收（EMAIL_TRANSPORT=log）。
  后续文件业务验收需使用受控测试身份；若验收真实认证，需另行配置测试集成。

## 已停止的非 selfhost 服务必须保持停止

先追加原策略/状态并 fsync，再把 sub2api-deploy 三容器、new-api 四容器（含其
cloudflared_tunnel）、openclaw 一容器设为 restart=no 并 stop。warp-svc 原 enabled/active
已记录，随后 disable --now，确保获准 reboot 后也不自启。没有删除容器、卷、镜像或缓存。
停服后 available 内存 2779 MiB；此样本不是 6.4 全栈资源验收。

记录仅在主机受限目录，报告只保存文件名与 SHA256，不保存容器 ID 或系统身份：

| 记录 | SHA256 |
| --- | --- |
| stopped-containers-20261016T134454Z.tsv（协调者原 d2market 记录，保留） | 10c9e4a1cf37d66d86099f265692b2e88373e79e2765f10746f3f627baccc479 |
| stopped-containers-20261016T150055Z.tsv | 7fa4130e3b201475b30a73d67c7ede7406a9b5f902db6f50e2215078730785eb |
| stopped-systemd-20261016T150055Z.tsv | 89aec165a9167d23bcbf69271fedc2aaddd888df44662a342ca5138f57101607 |

15:03:35 UTC 再核对：本轮 8 个容器全部不运行且 restart=no，warp-svc inactive/disabled。
先前停止的 d2market 没有启动；不要为恢复测试环境而重新开启任何上述服务。

## 验证与未完成项

部署/health Python 11 项、bundle Python 8 项通过；Node22 下根 `pnpm check` 通过
（4 个既有 Biome warning，16 项工程脚本测试通过）、`pnpm typecheck` 14/14 通过
（缓存），delivery strict validate 与 diff 检查通过。修复后真实 CLI 四文件只读渲染通过。
未执行全量 pnpm test/build：改动仅 Python 文件名门及回归测试，相关测试覆盖了实际错误。

所有分配运行验收保持未勾选：storage-observability 1.7、delivery 7.1–7.4、foundation
7.4/9.4、job-engine 6.4。四 change apply instructions 已刷新，进度仍分别为
17/18、29/33、30/33（含 ACME 子项）、31/32。不改范围、不同步主 specs、不归档或合并。
下一步由协调者提供包含修复的新正式 SHA/run，复用既有受限配置后通过其原版部署入口
继续；7.3 reboot 授权仍有效，但须等待既定前置验收完成。

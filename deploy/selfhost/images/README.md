# 自托管镜像 CI 与发布

`selfhost-images.yml` 以只读 `contents:read` 在原生 amd64 Linux runner 上运行。2026-11 起
CI 与正式发布只交付 **linux/amd64**（无异构部署需求，停止 arm64 矩阵与发布）。
显式检出源后以 `git rev-parse HEAD` 固化版本；PR 使用 merge commit，不把
分支头或 workflow 默认 SHA 错当镜像版本。无 registry 写入、构建 secret、服务器凭据。

触发：main push（纯文档除外）与发布的 `workflow_call` 始终构建；PR 只在改动可能让镜像
构建/运行与普通 CI 不同时构建（`deploy/selfhost/**`、本 workflow、根与各 workspace 的
`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、PG 镜像复制的 `infra/local/initdb/**`、
镜像上下文中的 `scripts/sentry-node-maps.mjs` 与 `apps/*/scripts/build-node*.mjs`、
`apps/web/vite.node.config.ts`）。应用源码的 Node 构建由 CI 的 `build:node` 覆盖，
合并后 main 仍全量构建。同一 PR 的新推送取消旧 run；main 与发布调用不取消。
PR/main 只上传 build/smoke 证据 JSON；镜像 tar 只在发布调用中上传给同 run 的 publish 作业。

校验 Dockerfile 中基础 digest 的 manifest 含 linux/amd64（arm64 是否仍在只作提示，
供本机开发参考；未改动的 multiarch 固定 digest 保持不变），再 buildx `--load` 构建
catalog 的完整已有集合及 native-smoke。实际启动 PG/Valkey/migrate/web/jobs/Caddy/
object-storage，并以独立PG/S3夹具验收backup真实备份和逻辑恢复，核对镜像与 PID1 UID、原生 sharp、SQL→DBOS 迁移、真实五分钟 heartbeat、
TLS、web/jobs 编译 SHA（运行时伪造 APP_VERSION 不能覆盖）。cloudflared 不连接真实 Cloudflare：
在无网络、只读、cap_drop ALL 的独立容器中核对版本、`--token-file` 支持、显式数字 UID 与实际进程 UID，
并要求无 token / token 文件缺失时以固定用法错误非零退出。夹具只使用随机本地 file
secrets、自签 CA、私有网络和临时卷，无宿主数据端口；结束只清理自己创建的 project。

实际版本写入 `smoke.json` 的 runtimeVersion，基础引用输出到 CI log。当前固定基础为
Node22 bookworm、PG17 trixie、Valkey8.1.6、Caddy2.11.2、SeaweedFS Community4.48，
cloudflared2026.10.0（官方 distroless 镜像，仅隧道模式使用），pnpm12.8.1；精确 patch 与 Docker/Buildx/Compose 版本以实际 run 证据为准。

## 合并后的首次验证与触发

协调者合并后先查看 main 的 `CI` 和 `Selfhost images` 全部通过，可下载
`selfhost-image-evidence-<sha>-amd64` 检查 build.json/smoke.json。发布调用内只有成功 smoke
才上传镜像 tar（`selfhost-images-<sha>-amd64`），发布不会重新构建另一份未测镜像。

backup工具现已接入catalog与两个架构的实际runtime smoke：固定WAL-G checksum、UID999、
secret/TLS失败边界、真实base/WAL/dump与角色恢复、持久调度及资源检查，成功生成
backup-smoke.json后才允许整组artifact通过。等待新的main CI与 amd64 镜像 smoke 成功，
再由协调者明确选择namespace和完整提交号触发：

```sh
gh workflow run selfhost-publish.yml --ref main \
  -f sha=<full-40-character-main-sha> \
  -f namespace=ghcr.io/<owner>/<project>
```

workflow_dispatch 只接受在 main 上运行、目标为 main 可达完整 SHA，且该 SHA 的同仓
main push `ci.yml` 已成功。GHCR 认证仅使用内置 GITHUB_TOKEN，不需新增 secret。
trust job 只有 contents/actions/packages 的 read，build job 无 packages 权限，
publish job 单独有 contents:read/packages:write。
同 namespace 串行且不取消运行，checkout 不保留 git 凭据，无 secrets:inherit。
凭据使用 stdin login 与固定 GHCR token endpoint；403/网络/不明确404均失败。

trust job 在任何构建前先做正式 tag 门：用 workflow 所在 main 的检查代码（旧源 SHA
可能没有此门）读取源 SHA 的 catalog，逐个服务只读查询正式 `<namespace>/<service>:<sha>`。
先用匿名 GHCR pull token，被拒时再用只请求 pull scope 的 GITHUB_TOKEN（packages:read）；
任一正式 tag 已存在即在几分钟内失败，不进入镜像构建。仅明确 `MANIFEST_UNKNOWN` 的
404 算不存在；限流、5xx、网络与不明确 404 均失败关闭。GHCR 对从未发布、私有且无权
的仓库统一返回 DENIED，无法区分，因此同样失败；只有首次发布某个包时，协调者可用
`-f new_services=<逗号分隔服务名>` 显式声明这些服务，它们仍由 publish 作业写前检查。

发布前完整校验 amd64 smoke 证据、集合（包括 backup）、已测 image ID、revision 和
UID；写入临时 candidate tags，随后组合正式 `<namespace>/<service>:<full-sha>`。
每个正式 registry index 必须恰含 linux/amd64 一个平台（单一来源经 `imagetools create`
仍生成 index），子 manifest/config 的 revision 与源 SHA 相符。2026-11 前的正式发布为
amd64/arm64 双平台，已有 tag 不变，其 image-set 仍可被 bundle 校验、回滚与验收接受。
只有全部成功后上传 `selfhost-image-set-<sha>`，内容是 image-set.json
的 tag/digest/source 清单，供 D 1.4 打包。它本身不是可部署 release bundle。

首次真实 run 验收须记录 run URL、源 SHA、所有服务平台、registry digest/revision
和 image-set artifact。验证重复触发同 SHA 在 trust 的正式 tag 门即拒绝（无构建）、故障架构使 publish job
跳过，且没有可部署 bundle。服务器部署与 release bundle 验收仍归后续 D 项。

## 不可覆写与失败处理

正式 SHA 任一已存在即拒绝，包括部分失败留下的 SHA。OCI registry 不提供跨多个
仓库的原子事务，本流程依靠 namespace 串行锁、构建前只读门、写前/临写前检查及最后的成功集合门；
构建前门只节省重复构建，不替代 publish 作业在写入凭据下的写前检查。
正式发布者必须只用此 workflow；带额外权限的外部人工写入不受该锁控制。
失败可能留下 candidate 或部分正式 tag，但没有成功 image-set，更没有可部署 release。
不要删已发布正式 tag 后重跑；修正失败后用新 main SHA。candidate 仅用于组合索引，
不能供部署使用。既有成功版本不变；未设置 latest 或自动服务器部署。

## 本地验证

```sh
node --test deploy/selfhost/images/policy.test.mjs
node deploy/selfhost/images/check-bases.mjs
# Apple Silicon 本机可用 arm64，amd64 主机用 amd64；本机产物只作开发验证，不进入发布。
node deploy/selfhost/images/build.mjs <full-sha> arm64 /tmp/selfhost-images
node deploy/selfhost/images/smoke.mjs <full-sha> arm64 /tmp/selfhost-images
```

build.mjs/smoke.mjs 仍接受 `arm64`：上游固定基础 digest 仍为 multiarch，`install-walg.sh`
保留 aarch64 checksum，本机 arm64 构建和 `test-deploy-compose.py` / `test-release-compose.py`
的本地夹具（fixture 只记录实际单架构）照常可用。发布侧 `policy.architectures` 只含
amd64，publish 只读取 amd64 证据。

CI 构建使用 runner 自带 dockerd 的默认 docker driver（不经 setup-buildx 的
docker-container builder），镜像直接进入本机镜像库，省去每个镜像导出 tarball 再 load。
2026-11-18 PR #411 实测构建 197–213s（原 docker-container 约 470s）；同时试验的
docker-container + `type=gha` 层缓存（mode=max）冷 553s、热 675s：`COPY . .` 之后的
依赖安装与构建随源码失效，缓存写入数百 MB 层反而更慢，因此未采用远端层缓存。

本机 Docker Desktop credential helper/代理可能挂起；用只含 CLI plugin 路径的临时
匿名 DOCKER_CONFIG 并保持当前 Docker endpoint，不能复制宿主 auths。连续卡住超过
15 分钟停止自己启动的进程，使用 CI 的架构结果，不结束其他工作区进程。

发布接口依据 [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)、
[GHCR 发布权限](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
与 [Buildx manifest 组合](https://docs.docker.com/reference/cli/docker/buildx/imagetools/create/)；
这些文档不代替本项目实际 registry 发布证据。

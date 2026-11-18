# 同 SHA release bundle

`deploy/selfhost/release/bundle.py` 使用 Python 3 标准库。打包端需要 Git；服务器校验和部署
只需要 Python 3、Docker Engine、Compose v2，不安装 Node/pnpm 或拉取业务源码。

## 来源与信任

正式输入是 `selfhost-publish.yml` **全部服务的 linux/amd64 构建与 smoke 成功后**上传的
`selfhost-image-set-<sha>/image-set.json`，以及同一完整 main commit 的可信 Git 对象。
操作者须确认发布 run URL、成功结论、完整 SHA、namespace 和来源仓库；不要以存在某个
SHA tag 代替成功集合。发布成功后 workflow 将同 SHA 的上述材料打包为 `selfhost-release-<sha>` artifact；
发布需要明确授权；验收workflow只读取已有成功发布，不触发或覆写SHA。可选 `rollback_compatible_with` 输入只填已审阅的完整
历史SHA列表，默认空值使回滚门保持关闭。脚本校验清单、引用和 SHA，checksum 用于传输完整性，不提供签名
或 registry 身份证明。因此应从受信 Actions artifact 下载，并使用已验证 SSH host key
传输；不要使用第三方提供的 bundle 或 image-set。后续新发布由协调者决定。

目前正式 image-set 使用 `ghcr.io/<owner>/<project>/<service>`。每个服务同时记录
`tag: ...:<sha>`、`digest: sha256:...` 和 `reference: ...@sha256:...`，平台恰为
`linux/amd64`（2026-11 起停止 arm64 发布；此前已发布的 `linux/amd64`、`linux/arm64` 集合仍可校验、
回滚和验收；显式本地fixture只记录实际单架构，可为 arm64）。catalog 与集合必须包含 web/jobs/migrate/postgres/valkey/
caddy/object-storage/backup；pending、重复、缺失、混 SHA 或非 digest 引用均拒绝。

## 打包与干净目录验证

在可信检出目录执行，`--output` 必须不存在。源文件通过 Git 对象读取，未提交文件、
本地 `.env`、secrets、证书、数据库、ownership、备份和运行 release 状态都不会被读取。
缺少任何固定运行文件时失败，不生成半成品，也不覆盖前成功 bundle。

```sh
python3 deploy/selfhost/release/bundle.py build \
  --source . --sha <full-main-sha> \
  --image-set /tmp/downloaded-image-set/image-set.json \
  --output /tmp/releases/<full-main-sha>
python3 deploy/selfhost/release/bundle.py verify /tmp/releases/<full-main-sha> \
  --sha <full-main-sha>
python3 /tmp/releases/<full-main-sha>/release/bundle.py compose-config \
  /tmp/releases/<full-main-sha> --sha <full-main-sha>
```

新版完整运行清单为基础/backup/object-storage/replica Compose、代理与外部 S3 override、
restore/drill与自包含宿主恢复器、三个附加无真值env示例、deploy/init/health入口、初始化防火墙
脚本、运行时挂载的 `object-storage-init.mjs` 与 `Caddyfile.object-storage`、无真值示例和
服务器校验器及README/OPERATIONS。Dockerfile、build.sh、业务源码和镜像内部的备份实现不复制。新增运行文件
时需审阅更新 `RUNTIME_FILES`；不能改成递归复制整个 deploy 目录。

bundle 根目录含 `release.json`、`image-set.json`、仅保留服务名的 `image-catalog.json`、
`images.env`。`.env.example` 中八服务镜像全部替换为该集合的 digest；所有运行文件及
这三个生成文件都有 SHA-256。新版附加env示例同样固定到集合digest。`release.json` 自身不循环计算 checksum，信任来自受信
artifact 与传输渠道。校验拒绝 symlink、额外文件、缺文件、checksum 不符和镜像示例不符。

`compose-config` 在 bundle 干净目录读取 example 与最后的 images.env，清掉进程业务
环境变量，检查渲染后的基础服务无 build、镜像与集合一致；该步不启动服务、不读取
secret 内容。secret/TLS 真值需由操作者在实际部署目录另行提供。

## 部署与回滚声明

`deploy.sh --local|--host <host> --dir <directory> --sha <sha> --bundle <directory>`
消费已解压 bundle。部署目录自己的 `.env` 提供公开运行配置，镜像值始终来自经过校验的
bundle。每个 SHA 的 bundle 仅导入一次，成功版本与前成功 bundle 均保留。
实际操作和失败处置见 [部署 runbook](selfhost-deploy.md)。

`rollbackCompatibleWith` 默认空数组，禁止把“都使用同版本 PG”当作兼容证明。
它表示**该 release 应用迁移后**，允许恢复列表内 SHA 的应用代码；包含实际迁移过但
health 失败的 release 也必须用于兼容门。制作声明前必须人工审阅 schema 向后兼容、
DBOS handler/checkpoint、旧长任务已排空或仍能由匹配 handler 承接，并在 PR 保存证据。
经确认后可重复传入参数，声明作为受审 release 材料记录：

```sh
python3 deploy/selfhost/release/bundle.py build \
  --source . --sha <new-full-sha> --image-set /tmp/image-set.json \
  --output /tmp/releases/<new-full-sha> \
  --rollback-compatible-with <previous-full-sha>
```

缺少声明时不得绕过门、不自动 down migration。需要匹配备份恢复到新空卷；恢复入口
及异机 ownership 签收仍属后续任务，不用删除 owner 目录或修改 DBOS 内部表代替。


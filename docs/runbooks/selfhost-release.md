# 同 SHA release bundle

`deploy/selfhost/release/bundle.py` 使用 Python 3 标准库。打包端需要 Git；服务器校验和部署
只需要 Python 3、Docker Engine、Compose v2，不安装 Node/pnpm 或拉取业务源码。

## 来源与信任

正式输入是 `selfhost-publish.yml` **全部服务、两架构成功后**上传的
`selfhost-image-set-<sha>/image-set.json`，以及同一完整 main commit 的可信 Git 对象。
操作者须确认发布 run URL、成功结论、完整 SHA、namespace 和来源仓库；不要以存在某个
SHA tag 代替成功集合。发布成功后 workflow 将同 SHA 的上述材料打包为 `selfhost-release-<sha>` artifact；
发布需要明确授权；验收workflow只读取已有成功发布，不触发或覆写SHA。可选 `rollback_compatible_with` 输入只填已审阅的完整
历史SHA列表，默认空值使回滚门保持关闭。脚本校验清单、引用和 SHA，checksum 用于传输完整性，不提供签名
或 registry 身份证明。因此应从受信 Actions artifact 下载，并使用已验证 SSH host key
传输；不要使用第三方提供的 bundle 或 image-set。后续新发布由协调者决定。

目前正式 image-set 使用 `ghcr.io/<owner>/<project>/<service>`。每个服务同时记录
`tag: ...:<sha>`、`digest: sha256:...` 和 `reference: ...@sha256:...`，平台恰为
`linux/amd64`、`linux/arm64`（显式本地fixture只记录实际单架构）。catalog 与集合必须包含 web/jobs/migrate/postgres/valkey/
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

## 本地夹具与未完成证据

```sh
python3 -m unittest discover -s deploy/selfhost/release -p 'test_*.py' -v
```

行为用例覆盖同 SHA Git 白名单、防真值混入、缺材料/缺服务/混 SHA、checksum/额外文件/
symlink 拒绝、前成功版本保护以及显式 fixture 门。`build --fixture` 标记本地夹具，
`verify/compose-config --allow-fixture` 才接受；服务器正式部署默认拒绝。fixture namespace
额外允许 `localhost:<port>/<project>` 或 `127.0.0.1:<port>/<project>`，仅适用于隔离本机。

Docker save 的 config 内容 hash、本地 image ID 与 registry manifest/index digest 必须分别核对；
本机 containerd store 的 inspect.Id 可能对应导出包的另一个 OCI blob，并不等于 config hash。
本机 tar/digest 夹具只能证明打包结构；即使本地 registry 返回真实 manifest digest，
也不证明正式 GHCR 两架构 revision/发布信任门。首次发布已在用户授权后成功，见下文；后续先确认main CI与两架构smoke成功，再下载
成功image-set，按同SHA build/verify/config验收。不要自行触发publish workflow。

备份、restore/drill与副本脚本已经交付；第二次正式release已包含完整运行白名单。
打包器按指定Git SHA自身的受审白名单打包，校验器只接受原17项、恢复版24项或外部S3版25项的确切集合，
不接受任意manifest文件名。旧SHA仍使用旧工具和白名单，不将未发布修复冒充该SHA材料。
B/D ownership、VM全栈恢复和真实服务器验收仍待签收。

外部 S3 版新增 `compose.s3.yaml`，连同三个生成文件共28项 checksum（另有
`release.json`），不改写旧17/24项的已发布材料。部署加
`--compose-file compose.s3.yaml`，所需公开配置从同包 `.env.example` 填写，凭据遵循
`secrets.example`，不递归复制本机 secret。bundle 测试使用 Docker Compose CLI 在无秘密、
不启动容器的情况下渲染基础/外部S3/外部S3+backup，验证凭据隔离和缺配置拒绝，并验证
17/24项历史版本仍按自己的 Git 对象生成；不代表真实 R2 联通或服务器验收。

2026-10-14 本机补充结构证据：使用八个已实际构建镜像的本地 ID、固定运行材料临时
Git fixture commit `1f7cb280a68a14068186914a46c24a364189bf6c`，完成 build/verify 与
干净 bundle 的基础 Compose config（caddy/jobs/migrate/postgres/valkey/web）。导出 web tar
后核对本地 ID 对应 OCI blob 内容 hash、config hash 与原始 revision；config digest 为
`sha256:930619fbf6b7c557b2f26fdd271229fb80acbf9a30e67066488274f771fb0249`，
原始 web revision 为 `ffd6ba7a6bfa706893ab4a0dfe095afb008ae4a1`。backup 本地镜像
revision 是另一提交，因此该材料明示 fixture，拒绝作为正式同 SHA 集合或 registry
发布证据；没有进行 pull 或触发发布。临时源码/bundle/tar 均自动清理。

## 首次正式 GHCR 集合（2026-10-14）

用户已批准的[发布run 38573156122](https://github.com/ustclhx/product-res/actions/runs/38573156122)
成功，源SHA `80983d29f83cb5b57563fc8360119793cf8c12be`，namespace
`ghcr.io/ustclhx/product-res`。amd64/arm64 image smoke均成功，八镜像可匿名拉取。
不得重触发同SHA发布或覆写tag。

该SHA含#187原17文件打包白名单；正式部署bundle已从Git对象及成功image-set生成，
由bundle内原版校验器完成verify和干净目录config。它支持部署/初始化/回滚，但不含
restore/drill/replica及附加env示例。当前补齐只影响包含修复的后续source SHA，完整恢复
bundle的正式发布签收仍待协调者决定新发布，不能用本地fixture代替。

以上缺口仅适用于首次发布，第二次发布的完整材料见下文。

`Selfhost released bundle acceptance` 是独立只读CI：读取上述成功集合，匿名pull八镜像，
空卷执行bundle初部署、已有版本升级、失败与回滚。第二版本为本地registry元数据变体，
明确fixture，业务/schema/handler不改，不能用来宣称第二个正式GHCR版本已发布。
CI artifact包含原SHA部署bundle、image-set与脱敏演练报告；真实server/ownership仍待签收。

## 第二次正式 GHCR 集合与完整 bundle（2026-10-14）

用户已批准的[发布 run 38588820873](https://github.com/ustclhx/product-res/actions/runs/38588820873)
成功，源 SHA `081305013b022f457c561eecf5828b1959e13908`，namespace
`ghcr.io/ustclhx/product-res`；八服务的 amd64/arm64 smoke 与完整集合发布成功。
从该 run 下载 `selfhost-image-set-081305013b022f457c561eecf5828b1959e13908`，
按同 SHA Git 对象重新生成 24 项完整运行 bundle，其 manifest 与该 run 的
`selfhost-release-081305013b022f457c561eecf5828b1959e13908` 压缩 artifact 一致。
包内校验器 verify、干净目录基础/backup/object-storage/replica/组合/外部代理 config 均通过。

恢复材料包含 `restore.sh`、`restore-drill.sh`、`backup/restore.py`、`compose.replica.yaml`
和三份附加无真值 env 示例。共 27 个文件有 checksum，另有 `release.json`；
所有镜像引用固定到该发布集合的 digest，包内没有业务源码、构建文件或运行真值。
验收 workflow 已固定到这次成功发布，并拒绝缺少上述恢复材料的 bundle。
证据与可重复命令见 [d-bundle2 报告](evidence/selfhost/d-bundle2-2026-10-14/report.md)。
后续发布仍由协调者决定，不重触发 `selfhost-publish` 或覆写正式 SHA。

## 第三次正式 GHCR 集合与 ownership 升级边界（2026-10-15）

用户已批准的[发布 run 38624392597](https://github.com/ustclhx/product-res/actions/runs/38624392597)
成功，完整 SHA 为 `598d1f68b6ef7b19e8a6d30c13575bac1701b7c2`，namespace 为
`ghcr.io/ustclhx/product-res`。同版 artifact 包含正式八服务 image-set 和完整运行 bundle；
jobs 使用进程持有的 ownership 卷 flock，保持独立 PID namespace，不使用 `pid:host`。
只复用该成功发布，不再次触发发布或覆写镜像。
正式新卷部署、exit/namespace/recreate/实际reboot、SSH入口及兼容回滚证据见
[d-vm2报告](evidence/selfhost/d-vm2-2026-10-15/report.md)，本轮1.5/2.1/2.3/6.3已验收。
回滚的第二版仅为本地registry版本元数据fixture；真实服务器第7组仍保持BLOCKED。

**BREAKING：** 修复前镜像（0813050及更早）从未部署到真实服务器，不提供缺少
machineId或token锁文件的旧owner升级迁移路径。此正式版本要求新卷部署，旧owner记录
会保守拒绝；不得自动改写旧记录、删除目录或换executor ID绕过。异机恢复退出证明仍
为开放设计项，恢复数据库不代表可启动jobs，须等待独立流程与签收。

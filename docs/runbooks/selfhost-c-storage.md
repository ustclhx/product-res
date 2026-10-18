# C 1.4：Node 文件接线验收与 B 交接

Node 配置通过 `nodeStorageConfig` 映射 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE` 和两个显式凭据，交给 `createNodeStorage`。完全未配置时 files/downloadFile unavailable，部分配置拒绝启动；预渲染不读取密钥或创建客户端。两个凭据支持固定 `_FILE` allowlist。端点必须同时被服务端和浏览器访问，不能在签名后改 Host、协议、路径或 query；生产使用 HTTPS。

web 装配 files 与 downloadFile，jobs 只注入所需删除能力，`string|string[]` 在 composition 逐 key 桥接。只有装配后才执行既有十分钟文件清理；删除失败保留数据库锚点供下一轮重试。

## 正式 bundle 的外部 S3 / R2 配置

使用包含 `compose.s3.yaml` 的新正式 SHA bundle；旧发布没有该装配，不能手改旧 bundle、
checksum 或现场追加未审阅 override。由发布负责人合并、发布同 SHA image-set/bundle，
通过包内 verify 后再部署；应用镜像仍从该集合拉取，服务器不构建。

在部署目录的0600 `.env` 填公开配置，不写凭据值：

```dotenv
# 将占位 account-id 和桶名替换为部署方的专用资源；R2 region 必须为 auto。
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=selfhost-files
S3_FORCE_PATH_STYLE=true
```

endpoint 必须同时供浏览器签名请求和服务端访问，R2 使用其 S3 API 地址，不能使用
`r2.dev` 或自定义公开下载域名，不能在签名后改写 URL。R2 公共 HTTPS 使用 Node 的系统
信任库；已有 PG CA 挂载保持，不关闭证书校验。region、bucket 不从供应商隐式推断；其他
S3 端点填其实际 region/path-style，虚拟主机寻址需额外验证对应 DNS/TLS。

按 `secrets.example` 准备 `secrets/s3_access_key_id` 与 `secrets/s3_secret_access_key`：
父目录0700、单文件0600，属主1000或精确 ACL 允许应用 UID1000 读取。Compose file secret
不会自动改属主。R2 控制台创建只限应用私有桶对象读写的 S3 API 凭据，应用需要上传、
HEAD/GET、失败清理 DELETE 与媒体 multipart；不分配桶管理、其他桶或备份权限，不复用
backup/replica token。两个值只经受保护文件传入 `_FILE`，不放 `.env`、argv 或日志。

桶由运维方事先创建并保持私有；该 override 不创建/修改远端桶，也不需要 bucket 管理
凭据。CORS 仅允许 APP_URL 的 **origin**，方法 PUT/GET/HEAD，允许
Content-Type/If-None-Match，暴露 ETag/Content-Length/Content-Type/Content-Disposition；
浏览器自动发送 OPTIONS，用真实浏览器核对允许来源成功、未授权来源拒绝。

```sh
<bundle-dir>/deploy.sh --host <explicit-authorized-host> --dir <deploy-dir> \
  --sha <full-sha> --bundle <bundle-dir> --compose-file compose.s3.yaml
```

默认仍用 `COMPOSE_PROFILES=caddy`。不要同时加载 `compose.object-storage.yaml`；外部路径
没有 SeaweedFS、对象存储卷或 object-storage-init 依赖，基础迁移/readiness/网络/UID/日志
边界保留。外部 S3 secrets 只挂给 web/jobs，PG、migrate、Caddy 和 backup 均不获得。
启用备份可另加 `--compose-file compose.backup.yaml --env-file .env.backup`，副本同理，
其桶和凭据独立。部署器按既有 `.env.example` 公开键保存 S3 endpoint/region/bucket/
path-style 配置快照，回滚仍需匹配 bundle 和兼容声明；它不会保存或恢复凭据内容。

基础 Compose 不加载 `compose.s3.yaml` 时，即使 `.env` 中留有这些公开占位配置，也不会
要求或挂载 S3 secrets；文件能力未配置时继续明确 unavailable。关闭外部路径需在新部署
计划中省略该文件，保留对象和凭据文件，不执行桶删除。切换 endpoint 不迁移已有对象。

本批只修复发布装配并验证无凭据 Compose/bundle；C 1.7 真实 R2 上传确认、短期下载、
租户/配额、失败清理和 copier 仍须待新发布与真实受限凭据后验收，不提前勾选。

## 本地真实 HTTP 验收

先构建当前 Node web 产物，再运行隔离 runner：

```sh
pnpm --filter @product-res/web build:node
node apps/web/scripts/test-node-storage.mjs
```

runner 要求本机已有 `postgres:17`、`valkey/valkey:8.1.6-alpine`、`chrislusf/seaweedfs:4.48` 镜像。禁止自动拉取，缺镜像明确失败。创建名称含 `selfhost-c-wire-storage` 的三个专用 Docker 容器，只映射随机 loopback 端口，随机生成本次 PG 三角色密码、Valkey 密码和 S3 凭据。通过 stdin 或临时文件传入，不输出真值；退出、失败和 SIGINT/SIGTERM 清理本次容器和临时目录，不碰既有 worktree 资源。迁移只应用仓库已有 SQL，不生成迁移。

`storage-http.node.ts` 启动 `.output/server/index.mjs` 真实生产进程，沿用认证 HTTP fixture 的实际 Better Auth 会话，验证：

- 声明上传 → 预签名条件 PUT → HTTP 确认 → attachment 下载，重复确认只计一次。
- 实际大小与声明不符拒绝确认，对象不可下载；删除故障留下 pending 墓碑，清理失败保留，恢复后删除对象与记录。
- 真实 S3 的小对象并发确认竞争同一空间剩余配额，只有一个成功。已用大额配额以数据库 fixture 表达，不生成大文件。
- 跨租户、失效会话与撤销分享返回 404，不发出新的下载签名。
- storage ready 而媒体 workflow 未装配时，真实 `/api/ai/tasks` 返回 503，task/hold 计数不变。
- `/server/index.mjs.map` 与 `/index.mjs.map` 不公开。

同一 runner 复用既有 `features/files/http.test.ts` 的守卫和错误响应回归。S3 协议完整安全矩阵继续由 `pnpm --filter @product-res/storage test:node:s3` 负责；此 HTTP runner 不重复虚拟主机 DNS/TLS、multipart 或签名篡改矩阵。

## C → B 5.3/5.4

C 的交付是 `createNodeStorage(config)`、`createNodeMediaCopier(config)`、中立 `Storage` / `MediaOutputCopier` 以及文件 HTTP/清理能力。B 5.3 将两工厂注入既有 `persistMediaOutputs`，保留确定性 key、pending/ready、实际字节、空间锁、重放和失败清理。B 5.4 接媒体工作流的 create/status/sendEvent/terminate 后才能开放媒体提交；workflow gate 与存储 gate 独立。

本批不移植媒体 workflow、不修改 B 勾选。真实本地 PG/Valkey/S3 通过只证明协议与 Node 接线；外部 R2/第二兼容服务联通、浏览器 CORS、自带 object-storage profile 的持久化与全栈资源预算仍需相应独立验收，不在此记录提前通过。

# Storage 接口与 C 交接

业务从 `@product-res/storage` 导入文件函数、`Storage` 和 `MediaOutputCopier`。中立入口不加载 Workers 模块，也不需要 Workers 全局类型。Cloudflare composition root 从 `@product-res/storage/cloudflare` 导入两个工厂，每个请求或事件显式装配，再向业务注入。

```ts
const storage = createCloudflareStorage(env)
const copyOutput = createCloudflareMediaCopier(env.FILES)
await declareUpload(db, storage, input)
await persistMediaOutputs({ db, storage, copyOutput, task, result, limits })
```

`Storage` 提供四项操作：

- `head(key)` 返回 `{ size, mime }` 或 `null`；缺少 Content-Type 时 `mime` 为 `null`，上传确认按不匹配拒绝。
- `delete(key)` 幂等删除单个对象；失败必须传播，以保留数据库重试线索。
- `presignUpload(key, mime)` 返回 `{ uploadUrl, headers, expiresIn }`；Cloudflare 保留十分钟 PUT、签入 Content-Type 与 If-None-Match，已确认文件不可覆盖。
- `presignDownload(key, attachment?)` 返回 URL；Cloudflare 保留五分钟 GET，显式下载的 attachment 响应头参与签名。

`MediaOutputCopier(key, output, limits)` 返回实际存储的 `{ mime, size }`。C 的 adapter 负责禁重定向的 HTTPS 域名白名单下载、响应 MIME 匹配、实际字节限额和流释放，不能仅信任 Content-Length。对象写入失败应拒绝；`persistMediaOutputs` 负责 pending 记录、空间锁、最终配额确认、重放幂等与失败清理。Cloudflare copier 保留 FixedLengthStream 长度检查、未知长度的 5 MiB multipart 与 abort 清理。

`cleanupFiles` 仅要求 `Pick<Storage, 'delete'>`，原 R2 bucket 也结构兼容。分享 token 的授权、撤销和租户校验仍由业务函数执行。

Node composition 从 `@product-res/storage/node` 显式导入工厂；中立/Cloudflare 入口不会加载 Node S3 SDK。工厂只接受配置对象，不读取 env、文件密钥或云主机 metadata：

```ts
import { createNodeMediaCopier, createNodeStorage } from '@product-res/storage/node'

const config = {
  endpoint: 'https://objects.example.com',
  region: 'us-east-1',
  bucket: 'files',
  forcePathStyle: true,
  accessKeyId: secrets.accessKeyId,
  secretAccessKey: secrets.secretAccessKey,
}
const storage = createNodeStorage(config)
const copyOutput = createNodeMediaCopier(config)
await persistMediaOutputs({ db, storage, copyOutput, task, result, limits })
```

这里提供 B 5.3/5.4 的存储前置能力。web/jobs 装配和 Node 媒体工作流仍由协调者/B 完成；只装配存储时媒体提交仍需在任务创建/积分预扣前拒绝。

## Node S3 策略与支持操作

`@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner` 和 `@aws-sdk/lib-storage` 精确锁定 **3.1149.0**，传递依赖由 lockfile 锁定。SDK 的 requestChecksumCalculation/responseChecksumValidation 均为 `WHEN_REQUIRED`，不自动添加可选 CRC32/checksum trailer。PUT 显式用 `signableHeaders` 签入 `content-type` 和 `if-none-match`；浏览器只需发送返回的两项头，不要求额外 checksum 头。签名默认使用 UNSIGNED-PAYLOAD，真实 MIME 仍由 HEAD 和业务声明匹配；校验依据 [SDK 官方 presigner 文档](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/)。升级版本必须重跑真实协议 fixture。

- HEAD：返回实际 Content-Length/Content-Type；只有 NoSuchKey/404 返回 null。403、网络故障返回固定 `STORAGE_HEAD_FAILED`，不能伪装 missing。
- DELETE：单对象幂等，失败返回 `STORAGE_DELETE_FAILED`，保留业务清理锚点。
- PUT：600 秒，返回 Content-Type/If-None-Match:*，同 key 的重复/并发写入由服务原子拒绝。
- GET：300 秒，显式 attachment 响应覆盖参与签名，默认保留 inline。
- key：沿用 CF 的 `ws/<workspace>/<file>` 与 `ws/<workspace>/ai/<task>/<index>` 租户前缀；所有操作拒绝 `.`/`..` 段。
- copier：已校验 URL 或 binary Uint8Array/ReadableStream 输入，实际字节计数、固定长度匹配；未知长度也受限。复用 `media-validation.ts` 的 HTTPS 白名单、MIME 与大小规则，fetch 禁重定向。SDK multipart partSize=5 MiB、queueSize=1，64 KiB 读取背压，无整文件聚合；内存为分片缓冲及当前上游 chunk，调用者应逐块生产流。

SDK/网络失败不携带驱动消息、URL、凭据或 cause。源断流为 `MEDIA_DOWNLOAD_FAILED`，写入失败为 `STORAGE_WRITE_FAILED`；cancel、abort 或删除失败明确返回 `STORAGE_CLEANUP_FAILED`。copier 等待上传结束后取消源流、abort 已记录的 multipart 并删除可能完成的对象。调用方使用确定性 key 和 pending 数据库记录重试；`persistMediaOutputs` 的业务确认失败仍保留 pending 墓碑供既有 `cleanupFiles` 重试，不改现有业务错误与日志语义。桶管理员还应设置未完成 multipart 生命周期回收，处理进程被强制结束或清理持续不可达的窗口。

不支持原子 `If-None-Match`、签名头、multipart/abort 或 attachment 的端点不能视为兼容：保留失败，不退回 HEAD→PUT，不移除禁止覆盖头，不自动更换端点。桶必须私有；预签名不代替空间权限和配额检查。

## 共享接线补丁（协调者）

配置增加 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY` 必需字段及 `S3_FORCE_PATH_STYLE`（默认 true，严格接受 true/false）。完全未配置时保持 unavailable；任何原始参数出现即启用校验（默认填充的 path-style 不算启用），部分配置启动拒绝。endpoint 仅 HTTP(S)，无内嵌凭据/query/fragment，错误只含字段名；生产使用 HTTPS。将两个凭据键加入固定 `_FILE` allowlist，并复用冲突/文件读取校验。

**一个公开、浏览器可达 endpoint 同时用于签名与服务端操作。** 不能签名后替换 Host/path/query/协议。R2 经 S3 API 使用 `https://<account-id>.r2.cloudflarestorage.com`、region=`auto`、部署 bucket 与显式凭据，不需要 CF binding。其他 S3 兼容服务按自身 region 配置。`forcePathStyle=false` 需要 bucket 子域 DNS/TLS 与服务虚拟主机支持。

web Node runtime 将上述字段映射为 config 注入 `createNodeStorage`，装配 files 与 downloadFile；预渲染和未配置时不创建 SDK。jobs Node runtime 的 `files.delete(string|string[])` 用逐 key 调用 `storage.delete` 桥接，registration 仅在已装配时启用既有十分钟清理。B 将 `createNodeMediaCopier(config)` 注入现有媒体持久化，工作流能力 gate 单独保留。本包新增 ./node export 与 SDK 依赖已完成，构建脚本仅在对应 Node composition 导入该入口；CF 构建保持现有入口。

## 验证

`pnpm --filter @product-res/storage test:node:s3` 启动随机凭据、私有桶的 **SeaweedFS 4.48 测试容器**，只映射随机 loopback 端口；容器名包含 selfhost-c-storage，结束自动移除。虚拟主机 fixture 提供临时 CA、bucket wildcard DNS/TLS 与保留 Host/path/query 的 TLS 反代，验证证书不被禁用；无需修改系统 hosts。该 fixture 不进入 deploy/，不代表外部 R2/第二端点联通或 S2 全栈预算/CORS 验收。

测试覆盖两种寻址的 PUT→HEAD→attachment GET→DELETE、匿名拒绝、403、过期/篡改/MIME 签名、重复与并发拒覆盖，来源/重定向/MIME/缺或伪造长度、实际超限/断流、binary 输入、串行分片与残留分片检查、清理失败安全传播。有隔离 worktree/CI PG 时同时执行真实对象已成功而业务确认失败后的确定性重放及满额配额只计一次；缺 PG 时该脚本拒绝，不静默跳过验收。

`pnpm --filter @product-res/storage typecheck` 分别检查中立、Cloudflare、CF 测试和 Node adapter/夹具；`pnpm --filter @product-res/storage test` 保留 CF 签名和文件/媒体集成，并在真实 Node 子进程加载中立与 ./node exports。集成需要本 worktree 或 CI 隔离数据库配置。

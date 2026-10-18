# fal.ai 夹具来源

## 真实录制（3.2）

`fal.recorded.json` 在 2026-10-12（Asia/Taipei；UTC 起始时间为 2026-10-11T18:20:21.144Z）使用真实 `FAL_KEY` 直接请求 Queue API，未部署 staging。每个条目保存实际 HTTP 状态和脱敏后的完整 JSON 形状；测试不携带凭据、不访问网络。

| 条目 | 模型 / 取得方式 | HTTP 与观察 |
|---|---|---|
| `imageSubmit`、`duplicateSubmit` | `fal-ai/flux/schnell`；两次 POST 使用同一个 `Idempotency-Key`、完全相同的参数和临时回调地址 | 200，均 `IN_QUEUE`；两个不同 `request_id` |
| `imageInitialStatus`、`duplicateIN_PROGRESS` | GET 基础模型 `fal-ai/flux/requests/:id/status` | 202，`IN_PROGRESS`，`logs=null`、`metrics={}` |
| `imageStatus`、`duplicateStatus` | 轮询同一状态地址，直到完成 | 200，`COMPLETED`，分别带推理指标 |
| `imageResult`、`duplicateResult` | GET `fal-ai/flux/requests/:id` | 200，512×512 PNG，主机为 `v3b.fal.media`，保留 timings / seed / safety / prompt 字段 |
| `imageWebhook` | 临时 webhook.site 接收器实际收到的 fal POST；200 是接收器的应答 | `status='OK'`、`error=null`；payload 与第一张图片查询结果一致 |
| `cancelCompleted` | 完成图片的 PUT cancel | 400，`ALREADY_COMPLETED` |
| `videoSubmit`、`videoCancel` | `fal-ai/wan/v2.2-a14b/text-to-video/turbo`，480p；POST 后立即 PUT `fal-ai/wan/requests/:id/cancel`，未等待 / 获取视频结果 | 提交 200；取消 202，`CANCELLATION_REQUESTED`，取消请求往返 232 ms |
| `videoAfterCancelStatus` | 取消后的即时 GET status | 202，仍为 `IN_PROGRESS`；202 仅代表接受取消请求，不保证停止推理 |

### 幂等实测与费用

两次图片请求使用相同的 `Idempotency-Key` 和完全相同的请求体（单张、512×512、1 step、seed 42、PNG），返回不同作业 ID，且主动查询确认两个作业都完成。当前端点未按该头去重，因此 `idempotentSubmit=false`，Provider 忽略客户端键，不自动重试。结论仅限本次测试的端点和请求头；不能据此断言所有未测试机制均不支持幂等。

本轮总共 **3 次提交**，不重试：两个低价 FLUX schnell 图片各按 [公开价格](https://fal.ai/models/fal-ai/flux/schnell) $0.003 / 向上取整百万像素估算，一次立即取消的 [480p Wan turbo](https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video/turbo)即使计全价也为 $0.05。保守合计最多 **$0.056 < $1**；这是按价格估算的上限，不是账号账单核对。视频没有真实结果录制，不将它的文档夹具计入本轮实测。

### 脱敏与签名

作业 ID、内部重试 ID 使用一致别名，Queue URL 同步替换 ID；媒体 URL 删除真实路径 / 查询 / fragment，保留主机和扩展名。提示词为公开测试文本，不含用户输入。凭据、账号 ID、临时接收器地址和原始签名不保存到夹具、终端输出、PR 或卡片。

录制脚本在内存中对回调**原始请求体**计算 SHA-256，按 fal 的 request ID / user ID / timestamp / hash 协议拼接签名消息，从公开 JWKS 获取 Ed25519 公钥，确认真实签名及 ±5 分钟时间窗通过，再脱敏载荷。`metadata.callbackRawBodySignatureVerified=true` 记录该现场检查；脱敏会使原签名失效，离线测试对 `imageWebhook.body` 使用临时 Ed25519 密钥重新签名，分别验证真实载荷解析与签名协议，不声称本地签名来自 fal。

### 回调接收地址（2026-10-12 起）

2026-10-12 的 `imageWebhook` 由第三方 webhook.site 接收；此后录制回调**不再使用任何第三方接收器**，改用自建的临时地址：本机起一个只记录请求的接收服务，再用 Cloudflare quick tunnel 暴露为临时 HTTPS 地址，例如：

```sh
docker run --rm cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:<端口>
```

quick tunnel 无需账号配置、不创建持久 Tunnel 资源，进程退出即失效；不要复用或改动已有的命名 Tunnel。接收服务只在内存中处理原始请求体，完成签名核对与脱敏后再落盘，录制结束即停止接收服务与 tunnel。

## 文档补充与公开 JWKS

`fal.documented.json` 仍保留未录制分支：单独查询的 `IN_QUEUE`（图片查询时已运行）、生成失败、视频结果、ERROR / payload_error 回调与内部重试。其字段依据下列官方文档构造，不作为真实 API 验收证据；真实提交、运行 / 完成状态、图片结果、取消与成功回调测试使用 `fal.recorded.json`。

- [Queue](https://fal.ai/docs/documentation/model-apis/inference/queue)：提交、状态与取消。
- [Webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks)：OK / ERROR / payload_error、gateway_request_id 与验签。
- [FLUX schnell](https://fal.ai/models/fal-ai/flux/schnell/api)、[Wan turbo](https://fal.ai/models/fal-ai/wan/v2.2-a14b/text-to-video/turbo/api)：图片及视频输出。

`fal.jwks.recorded.json` 是 2026-10-09 从公开 JWKS 端点录制的公钥响应（无需 API key，不含账号信息），用于覆盖真实公钥编码并拒绝本地临时签名，不用于线上信任根。响应的 `x` 使用带 `=` 填充的 Base64url，解析同时接受无填充格式。

再次录制时先确认模型现价和费用预算；只跑低价图片，视频仅提交后立即取消，不因结果缺失再次提交。使用临时接收器需要显式得到任务授权；脱敏后只保存必要的 JSON 与取得方式，不提交任何密钥、账号信息或可访问临时接收器的地址。

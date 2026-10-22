# 设计：eBay 账号删除通知

## D1 协议（已按官方文档与官方 SDK 核实，2026-10-22）

来源：developer.ebay.com/marketplace-account-deletion、Notification API OpenAPI（`getPublicKey`）、
GitHub `eBay/event-notification-nodejs-sdk`（`lib/validator.js`、`lib/client.js`）与 `eBay/event-notification-java-sdk`。

- **Challenge**：eBay 在保存端点与 token 后发 `GET <endpoint>?challenge_code=...`。响应 200、
  `content-type: application/json`、正文 `{"challengeResponse": "<hex>"}`，其中
  `hex = SHA-256(challengeCode + verificationToken + endpoint)`，顺序固定；用 JSON 库序列化，避免 BOM。
  endpoint 必须与后台填写的地址逐字一致：取 `new URL(APP_URL).origin + '/api/webhooks/ebay/account-deletion'`。
- **Verification token**：32–80 字符，仅 `[A-Za-z0-9_-]`。不合规时按“未配置”处理。
- **通知正文**：`metadata.topic = MARKETPLACE_ACCOUNT_DELETION`、`notification.notificationId`、`eventDate`、
  `publishDate`、`publishAttemptCount`、`data.username` / `data.userId` / `data.eiasToken`。文档注明自 2025-09-26 起
  部分美国用户的 `username` 字段可能是不可变 userId，因此两者都参与匹配。
- **签名**：头 `X-EBAY-SIGNATURE` 为 base64(JSON `{alg, kid, signature, digest}`)。用 kid 调
  `GET https://api.ebay.com/commerce/notification/v1/public_key/{kid}`（应用令牌，scope `https://api.ebay.com/oauth/api_scope`），
  响应 `{key, algorithm, digest}`，key 为不带换行的 PEM，目前为 `ECDSA` + `SHA1`。签名为 base64 的 DER ECDSA 签名
  （Java SDK 用 `<digest>with<algorithm>` 即 `SHA1withECDSA`，Node SDK 用 `crypto.createVerify('ssl3-sha1')`）。
  官方要求公钥缓存“合理时间（建议 1 小时）”，不能每条通知都拉取。
- **状态码**：确认用 200/201/202/204；SDK 在验签失败时返回 **412 Precondition Failed**，其他错误 500。
  未确认的通知 eBay 会重发；24 小时持续失败后标记端点故障，30 天未修复判为不合规。

## D2 验签实现

- 放在 `packages/connectors/src/ebay-notification.ts`，只用 WebCrypto（`crypto.subtle`），不依赖 node:crypto。
  DER 签名转 IEEE P1363（r‖s）后用 `ECDSA` + 公钥给出的摘要（SHA1 / SHA256 / ...）验签；曲线按 P-256 → P-384 → P-521 依次尝试导入。
- 签名字节：先用原始正文验签，失败再用 `JSON.stringify(JSON.parse(raw))`（官方 SDK 的做法）。
- 公钥缓存：进程内按 kid 缓存 1 小时，最多 32 个；拉取失败不缓存。应用令牌与 Browse 连接器共用
  `requestEbayAppToken`（抽自 `ebay.ts`），在通知模块内单独缓存到过期前 5 分钟。
- 这两次调用属于 eBay 合规接口，不是数据源调用，不计入 Browse 每日额度，也不写 raw_payload。
- 头缺失 / 无法解析 / 验签失败 → 412；公钥接口不可达或 client 凭据缺失 → 503（eBay 会重发）。

## D3 处理顺序与去重

验签 → 解析 topic（非 `MARKETPLACE_ACCOUNT_DELETION` 直接 204，不处理）→ 单事务：
`pg_advisory_xact_lock(hashtext('ebay-account-deletion:' || notificationId))` → 查 `audit_log`
（`action='ebay.account_deletion'`、`target_id=notificationId`）已存在则 204 → 删除 → 写 audit_log → 提交 → 204。

- 不新增表：`audit_log` 只追加、永久保留，天然适合作为已处理记录；advisory lock 保证并发重发不会重复处理。
- 删除本身幂等，即使去重失效也只是多一次空删除。
- 不入队：删除必须可靠，同步事务失败返回 500 由 eBay 重发即可；涉及的表规模小（店铺池 / 卖家级数据），
  单次删除远低于 eBay 超时。没有需要投递的异步副作用。

## D4 删除策略（`packages/follow/src/ebay-account-deletion.ts`）

匹配键：`username` 与 `userId` 去空白、小写后去重；比较时对列取 `lower()`。仅限 eBay
（`platform = 'ebay'` 或 `marketplace like 'ebay-%'`），不触碰 Amazon。

| 表 | 处理 | 理由 |
|---|---|---|
| `tracked_store`（所有空间） | **删除行** | `seller_key` 非空且参与唯一键，清空需要造占位值；被删除用户的店铺已不可追踪，保留 removed 行没有业务价值。`tracked_product.origin_ref` 无外键，只留 uuid，不含个人数据 |
| `direction_seller`（所有空间） | 删除行 | 对标店铺池同样以用户名为键 |
| `store_listing` | 删除行 | 以卖家为键的“店铺 × 商品”关系 |
| `marketplace_seller` | 删除行，并删除 `entity_type='seller'` 且 entity_id 为这些行的 `observation` | 卖家实体与其观测 |
| `marketplace_product.seller_id` | 置空 | 商品本身是公开刊登数据，保留价格 / 销量观测；只断开与用户的关联 |
| `lead_event.payload.sellerKey` | 去掉该键 | 店铺线索备注中记录的用户名 |
| `sync_run.scope.sellerId` | 去掉该键 | 同步记录的范围 |
| `raw_payload`（`task.scope.sellerId` 匹配） | 正文置空并标记 purged | 卖家新品搜索的原始响应 |

## D5 已知残留

`raw_payload` 中通过商品详情 / 关键词搜索顺带出现的 `seller.username` 存在 gzip 正文里，无法按内容检索，
随默认 90 天保留期由现有清理任务清除。若需更强保证，后续可缩短 eBay 来源的保留期或在存档前剥离卖家字段。

## D6 配置与日志

- `EBAY_VERIFICATION_TOKEN` 通过 `createDataSourceSecrets(process.env)`（NAME → NAME_FILE → `OPTIONAL_SECRETS_DIR/NAME`）读取；
  自托管 compose 已把 `secrets/optional` 挂进 web 容器，无需改 compose。缺失或不合规：GET 503、POST 503。
- 验签所需 `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` 同样经该函数读取。
- 日志与审计只写 `userHash = sha256hex('ebay:' + lower(username))`、各表计数、notificationId、publishAttemptCount；
  不写用户名、userId、eiasToken 明文与原始正文。
- 跨空间删除不经 `scoped()`：这是部署级合规操作，必须覆盖所有空间；函数只按 eBay 用户名过滤。

# 提案：eBay 账号删除通知（add-ebay-account-deletion）

## 为什么

项目要启用 eBay Production keyset（Browse API，应用令牌）。eBay 要求所有持久化 eBay 数据的应用订阅
Marketplace Account Deletion 通知；只有“不持久化 eBay 数据”的应用才能申请豁免。本项目持久化了 eBay
卖家用户名及其商品（`tracked_store`、`store_listing`、`direction_seller`、`marketplace_seller`、
以卖家为实体的 `observation`、`marketplace_product.seller_id` 等），不能豁免，必须实现通知端点。

生产地址：`https://product.ezarouter.cc/api/webhooks/ebay/account-deletion`（Cloudflare Tunnel → web:3000）。

## 改什么

- 新增路由 `apps/web/src/routes/api/webhooks/ebay/account-deletion.ts`：
  - `GET ?challenge_code=`：按官方协议返回 `{"challengeResponse": hex(sha256(challengeCode + verificationToken + endpoint))}`；
  - `POST`：校验 `X-EBAY-SIGNATURE`（ECDSA，公钥经 Notification API `getPublicKey` 用应用令牌获取并按 kid 缓存），
    失败返回 412；成功后按 notificationId 去重，在一个事务中删除 / 匿名化该 eBay 用户的数据，返回 204。
- `packages/connectors`：抽出 eBay 应用令牌函数供 Browse 连接器与通知校验共用；新增通知协议模块（challenge、
  签名头解析、验签、公钥缓存）。
- `packages/follow`：新增跨空间删除函数 `deleteEbayUserData`，覆盖所有保存 eBay 用户名的表。
- 配置：`EBAY_VERIFICATION_TOKEN` 经 `createDataSourceSecrets`（`EBAY_` 前缀已在白名单）读取；缺失时 GET、POST 都返回 503。
- 文档：`deploy/selfhost/README.md` 写明 token 生成、eBay 后台填写项与 Send Test Notification 预期。

## 不改什么

- 不新增数据表与迁移：去重复用只追加的 `audit_log`，配合事务级 advisory lock。
- 不处理 Amazon 数据；不订阅其他 eBay 通知主题。
- 不对 Cloudflare 目标做额外适配（本项目只部署 Node 自托管）。

## 风险

- 签名覆盖的字节：官方 SDK（Node / Java）都对“解析后再紧凑序列化”的 JSON 验签。我们先按原始正文验签，
  失败再按紧凑序列化验签，两者都用同一公钥校验，不降低安全性。
- 原始响应存档（`raw_payload`，gzip 正文，默认保留 90 天）中顺带出现的用户名无法按内容检索；
  只能清理任务范围指向该卖家的存档，其余随保留期到期清除，见 design D5。
- 真实验收依赖 eBay 后台“Send Test Notification”，需协调者在部署后完成。

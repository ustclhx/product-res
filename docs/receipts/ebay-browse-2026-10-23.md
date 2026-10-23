# eBay Browse 核验回执（2026-10-23）

## 凭据
- Production keyset：
  - App ID 含 `-PRD-`，Cert ID 以 `PRD-` 开头；
  - 存于服务器 `secrets/optional/EBAY_CLIENT_ID`、`EBAY_CLIENT_SECRET`，均为 0600、UID 1000，已去掉末尾空白。
- 应用令牌：`client_credentials`，scope `https://api.ebay.com/oauth/api_scope`。HTTP 200，`token_type=Application Access Token`，`expires_in=7200`。
- Marketplace Account Deletion：
  - 端点 `https://product.ezarouter.cc/api/webhooks/ebay/account-deletion`，已在 eBay 后台保存，challenge 验证通过；
  - Verification token 存于 `secrets/optional/EBAY_VERIFICATION_TOKEN`。

## 接口（EBAY_US，共 3 次调用）

| 调用 | 结果 |
|---|---|
| `item_summary/search?q=kids backpack&limit=20` | 200，total 158,820。`seller` 含 `username`、`feedbackScore`、`feedbackPercentage` |
| `item/{itemId}`（getItem） | 200。`estimatedAvailabilities[]` 含 **`estimatedSoldQuantity`**、`estimatedAvailableQuantity`、`estimatedRemainingQuantity`、`estimatedAvailabilityStatus`；样本值 sold=0、available=1、IN_STOCK |
| `item/?item_ids=…`（getItems，10 个） | **403**，errorId 1100 Access denied，"Insufficient permissions to fulfill the request." |

## 结论
- **快照策略（add-source-connectors design D2 第二种情况）：** `getItem` 返回官方已售量，`getItems` 需要额外授权，本应用不可用。因此商品快照改为默认逐个调用 `getItem`，已售量取官方值（T1）。批量模式只在显式 `mode: 'batch'` 时使用。
- **核验探测（probe）：** 不再调用 getItems，避免把 403 误判为凭据失效。
- **额度：** 测试规模下，100 个商品每日快照约 100 次，加卖家新品扫描，远低于安全线 4500。规模扩大到 2000 个热点商品时约 2500 次/天，仍在额度内。

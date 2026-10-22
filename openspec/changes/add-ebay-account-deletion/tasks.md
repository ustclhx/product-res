# 任务

## 1. 协议与验签
- [x] 1.1 `packages/connectors`：抽出 `requestEbayAppToken`；新增 `ebay-notification.ts`（challenge、签名头解析、WebCrypto 验签、按 kid 缓存公钥）与单元测试（challenge 向量、真实密钥对签名、篡改正文、缓存）

## 2. 删除
- [x] 2.1 `packages/follow`：`deleteEbayUserData` 按 design D4 删除 / 匿名化，事务内 advisory lock + audit_log 去重；集成测试（删除效果、Amazon 与其他卖家不受影响、去重）

## 3. 路由与配置
- [x] 3.1 `apps/web` 路由 `/api/webhooks/ebay/account-deletion`（GET challenge、POST 验签 → 去重 → 事务删除 → 204）；token 缺失 503、验签失败 412；处理器单元测试
- [x] 3.2 `deploy/selfhost/README.md`、`secrets.example` 写明 token 生成规则、eBay 后台填写项与 Send Test Notification 预期

## 4. 部署与验收（协调者）
- [ ] 4.1 服务器写入 `secrets/optional/EBAY_VERIFICATION_TOKEN` 与 Production `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`，发布后在 eBay 后台保存端点（challenge 通过）
- [ ] 4.2 eBay 后台 Send Test Notification 返回 204，日志出现 `ebay.account_deletion.processed`

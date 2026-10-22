## ADDED Requirements

### Requirement: eBay 账号删除端点验证

系统 SHALL 在 `/api/webhooks/ebay/account-deletion` 响应 eBay 的 challenge 请求：对 `GET ?challenge_code=<code>`
返回 200、`content-type: application/json`，正文为 `{"challengeResponse": hex(SHA-256(code + verificationToken + endpoint))}`，
endpoint 为 `APP_URL` 的 origin 加固定路径。verification token MUST 从 `EBAY_VERIFICATION_TOKEN` 密钥读取，
长度 32–80、字符限 `[A-Za-z0-9_-]`；缺失或不合规时 MUST 返回 503。

#### Scenario: 正确的 challenge 响应
- **WHEN** eBay 发送 `GET ?challenge_code=abc` 且 token 已配置
- **THEN** 返回 200 JSON，`challengeResponse` 等于按上述顺序拼接后的 SHA-256 十六进制

#### Scenario: token 缺失
- **WHEN** 未配置 `EBAY_VERIFICATION_TOKEN`
- **THEN** GET 与 POST 都返回 503，不计算哈希、不处理通知

### Requirement: eBay 通知验签

系统 SHALL 对每个 POST 通知校验 `X-EBAY-SIGNATURE`：解码出 kid 后用 eBay 应用令牌获取公钥并按 kid 缓存，
以 ECDSA 和公钥给出的摘要算法校验签名。头缺失、无法解析或签名不匹配时 MUST 返回 412，且 MUST NOT 修改任何数据。

#### Scenario: 篡改正文
- **WHEN** 通知正文在签名后被修改
- **THEN** 返回 412，数据库无变化

#### Scenario: 公钥缓存
- **WHEN** 一小时内收到多条相同 kid 的通知
- **THEN** 公钥只获取一次

### Requirement: eBay 用户数据删除

验签通过的 `MARKETPLACE_ACCOUNT_DELETION` 通知 SHALL 按 notificationId 去重，并在单个事务中删除或匿名化该
username / userId 在所有空间与部署级表中的 eBay 数据（店铺池、对标店铺、店铺商品关系、卖家实体及其观测、
商品的卖家关联、线索备注与同步范围中的用户名、以该卖家为范围的原始响应正文），完成后返回 204。
审计与日志 MUST 只记录用户名哈希，MUST NOT 记录明文。

#### Scenario: 删除生效
- **WHEN** 收到某 eBay 用户的删除通知
- **THEN** 所有空间中该用户的店铺池与对标店铺行被删除，卖家实体与其观测被删除，商品保留但卖家字段为空，返回 204

#### Scenario: 重复通知
- **WHEN** 同一 notificationId 再次送达
- **THEN** 返回 204，不重复写审计记录

#### Scenario: 数据库失败
- **WHEN** 删除事务失败
- **THEN** 返回 500，eBay 重发后再次处理

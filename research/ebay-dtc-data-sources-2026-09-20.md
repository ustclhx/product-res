# eBay 与独立站数据源调研（2026-09-20）

## 范围与证据边界

- 本稿只使用 eBay、Shopify、WooCommerce、SerpApi 官方文档/定价页；没有注册、购买、登录商家账号，也没有访问用户数据。
- “文档验证”指官方页面明确写出的能力、权限或限制；“实测”指实际发出 API 请求。本轮**没有实测**，因为没有任何生产/沙盒凭据。因此 demo 的连通性、响应字段和当前配额仍需在取得账号后复核。
- 公开市场数据（eBay Browse、SerpApi）与自营经营数据（Shopify/WooCommerce）分开处理；前者不能推导某商家的真实订单/退款。

## 结论先行

本轮选择 SerpApi 配合 Amazon 数据源完成真实 demo；eBay 作为后续候选：

1. **低门槛公开市场 demo：SerpApi Google Shopping**。用一个关键词返回价格、商家、标题、评分等结构化结果，免费计划每月 250 次搜索；适合先做“竞品价格/供给观察”，但它是 Google Shopping 搜索结果抓取服务，不是成交或订单数据。
2. **后续渠道候选：eBay Browse search + getItem**。Browse 的搜索只需 Application access token（client-credentials）；可显示在售商品、价格、卖家、配送、库存可用性等。生产使用受 eBay Buy API 资格、审批和可能的合同约束。Sandbox 可验证协议，但本次实施不包含 eBay 适配器，真实接入须通过 Production 准入。

Shopify/WooCommerce 适合作为第二阶段“接入自己的店铺经营结果”：必须由店主/管理员授权或生成密钥，只能访问被授予的店铺范围；不能用它查询所有竞品店铺订单。

## eBay Browse API

### 能力与 OAuth

- 官方 Browse 文档列出 `GET /buy/browse/v1/item_summary/search`、`GET /buy/browse/v1/item/{item_id}`、按 legacy ID 查询和 item group 查询；search 返回匹配商品摘要，getItem 返回购买决策所需的完整商品信息。[Browse API](https://developer.ebay.com/api-docs/buy/api-browse.html)
- Browse API 概览明确写明所有 Browse 方法需要 **Application access token**，由 client-credentials grant 获取；只搜索公开商品时不需要某个卖家的用户授权。[Browse API overview](https://developer.ebay.com/develop/api/buy)
- eBay 为 Sandbox 和 Production 分别发放 Client ID/Client Secret；凭据在 Developer Program 的 Application Keys 页面取得，两个环境的 token 不能混用。[OAuth credentials](https://developer.ebay.com/api-docs/static/oauth-credentials.html)
- eBay FAQ 区分 token：只搜索的 Browse 可用 Application token；访问用户个人数据必须使用 User token。[FAQ](https://developer.ebay.com/support/faq)

### Production、Sandbox 与门槛

- Buy API 总览称不少 Buy API 是 Limited release，只对经业务团队批准的开发者开放；Buying Integration Guide 说明 Buy APIs 目前为 public beta，并附 production 要求。[Buy APIs overview](https://developer.ebay.com/api-docs/buy/buy-overview.html)
- 官方 production 指引要求开发者账号和环境对应的 keyset；Production keyset 还需订阅或选择退出 marketplace account deletion/closure notifications，否则 keyset 可能 disabled。[Get started](https://developer.ebay.com/develop/guides/sell/get-started-with-ebay-apis)
- eBay 对 Buy API production 的公开说明包括标准资格、eBay 支持组织审批及签约；Sandbox 可用于开发测试，但响应可能是 mock 数据。[Marketing API restrictions](https://developer.ebay.com/api-docs/buy/marketing/overview.html)
- 因此：Sandbox 适合做协议/UI demo；真实线上市场数据需要 Production keyset，且是否立即放行不能从“能创建 keyset”推断。

### 已成交/历史销量边界

- Browse 文档的定位是搜索和检索**可购买** item；getItem 重点字段是 `itemEndDate`、`estimatedAvailabilityStatus` 和商品/配送/卖家信息。[Browse API](https://developer.ebay.com/api-docs/buy/api-browse.html)
- Browse release notes 明确新增的是 listing **剩余可用数量** `estimatedRemainingQuantity`，不是已售数量。[Release notes](https://developer.ebay.com/api-docs/buy/browse/static/release-notes.html)
- eBay 的 Marketplace Insights API 才是“retrieve the sales history of items sold on eBay”，但官方 marketplace 支持表明确写着该 API restricted、当前不向新用户开放。[Buying application guide](https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application)；[marketplace support](https://developer.ebay.com/api-docs/buy/ref-marketplace-supported.html)
- 结论：Browse demo 可以展示“当前在售供给/价格/剩余可用量”，不能承诺“成交量、历史销量或已成交列表”。不要把在售 listing 的库存或搜索排序当销量代理。Marketplace Insights 对新账号不可作为快速 demo 依赖。

## Shopify 自营店铺经营数据

- Shopify Admin API 的 app authentication 文档说明：应用代表 merchant 调用 GraphQL Admin API；token 携带 access scopes，每次请求只返回 token 被授予的范围。[App authentication](https://shopify.dev/docs/apps/build/authentication-authorization)
- `read_orders` 覆盖 `Order`、`Fulfillment`、`OrderTransaction` 等；默认订单读取窗口为最近 60 天，旧订单要额外申请 `read_all_orders`。[Manage access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)
- Shopify 的 access-scope reference 明确，订单相关数据包含受保护的客户字段；非开发店铺在满足 protected customer data 要求并获批前，字段会被 redact。[Access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- Refund 是订单上的财务记录，可通过 GraphQL `refund` 查询；文档要求 `read_orders` 或 `read_marketplace_orders`。[Refund query](https://shopify.dev/docs/api/admin-graphql/latest/queries/refund)
- 自有组织店铺可使用 client-credentials grant，但官方限制为 app 与 store 属于同一 Shopify organization；其他店铺走 merchant install/授权码或 Shopify CLI 管理的安装流程。[Client credentials](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant?lang=node)
- 经营结果 demo 所需门槛：一个 Shopify app（或店铺内 custom app/适用授权流程）、店铺域名、店主/管理员同意 scopes 与 access token；这些 token 只代表被授权的特定店铺，无法查询所有竞品店铺的订单/退款。

## WooCommerce 自营店铺经营数据

- WooCommerce REST API 要先在店铺后台 `WooCommerce > Settings > Advanced > REST API` 生成 key；选择关联 WordPress 用户，权限可为 Read、Write 或 Read/Write，权限遵循该用户角色/能力。[Authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- 官方快速开始使用 `wp-json/wc/v3/orders`，通过 Consumer Key/Consumer Secret（HTTPS 下 Basic Auth）访问；当前推荐 REST API v3。[REST API](https://developer.woocommerce.com/docs/apis/rest-api/)；[REST API v3](https://developer.woocommerce.com/docs/apis/rest-api/v3/)
- 官方 API 文档包含订单退款能力（创建/变更订单退款）；因此可做自营订单、订单状态、退款流水 demo，但数据范围由该站点和 key 的 WordPress 用户权限决定。[REST API reference](https://woocommerce.github.io/woocommerce-rest-api-docs/wp-api-v2.html)
- 若站点不能用 HTTPS，WooCommerce 文档要求 one-legged OAuth 1.0a；生产 demo 应使用 HTTPS Basic Auth 或官方 SDK，并把 secret 放服务端。[Authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- WooCommerce 没有一个“全市场竞品订单”接口；REST key 绑定单个站点/用户。接入门槛是店主/管理员生成 key 并提供站点 URL，属于明确的商家授权数据。

## SerpApi Google Shopping（公开补充源）

- 官方 endpoint 是 `https://serpapi.com/search?engine=google_shopping`；`q` 必填，可按 location、价格、排序、免邮、sale、small business 等过滤，返回 Google Shopping 结果。[Google Shopping API](https://serpapi.com/google-shopping-api)
- 页面说明当前布局约返回首屏 40 项，offset pagination 的 `start` 会被忽略；缓存命中（参数完全相同、缓存约 1 小时）不计搜索额度。[Google Shopping API](https://serpapi.com/google-shopping-api)
- 定价页列出 Free $0、250 searches/month、50/hour；Starter 为 $25/月 1,000 次。免费是有额度的试用/免费计划，不是无限永久免费；付费计划可随时升降级/取消。[Pricing](https://serpapi.com/pricing)
- 该 API 是第三方对 Google Shopping 搜索结果的结构化抓取，不提供店铺后台订单、退款、真实成交量；页面列出的价格/评分/商家应标注为搜索快照，不能替代经营数据。[Google Shopping API](https://serpapi.com/google-shopping-api)

## Demo 选择与风险

| 方向 | 数据性质 | 账号/费用 | 可展示 | 主要限制 |
|---|---|---|---|---|
| SerpApi Shopping | 公开搜索市场 | API key；Free 250/月 | 关键词下价格、商家、商品卡片 | 非成交；第三方抓取；额度和 Google 布局变化 |
| eBay Browse | 公开 eBay 在售市场 | Developer account + Sandbox/Production keyset；Production 可能审批/合同 | 搜索、商品详情、价格、配送、剩余可用量 | 无新用户可用的历史成交；Production 门槛 |
| Shopify Admin | 自营经营数据 | 店主授权与 scopes/token | 订单、交易、退款（按 scope/窗口） | 仅获授权店铺；旧订单/客户字段受限 |
| WooCommerce REST | 自营经营数据 | 店主生成 Consumer Key/Secret | 订单、退款、状态 | 仅该站点/WordPress 用户权限；需 HTTPS |

事实与推断：上表“字段/授权/配额/限制”均由链接文档验证；“最适合快速 demo”是基于无现成商家 token、需要公开数据和低外部审批的工程推断。没有本轮 live request，不能声称当前 credentials、marketplace 或具体响应已通过实测。

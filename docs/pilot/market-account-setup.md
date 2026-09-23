# DataForSEO / SerpApi 开通与交接

核对日期：2026-09-20。本轮目标为车辆内饰，美国市场；建议第一条查询 `car seat back organizer`。业务人员只需注册账号、取得 API 凭据并安全交接，接口配置与验收由管理员完成。

2026-09-21 接入更新：两个凭据已安全安装。SerpApi 已返回 10 条真实线索；DataForSEO 账号查询认证成功，但 Amazon 查询返回 HTTP 403 / `40104`，要求账号验证。请登录 [DataForSEO 控制台](https://app.dataforseo.com/)按提示完成邮箱及/或手机验证，完成后告知管理员重新验证一次；目前不需要更换密钥或充值。[官方错误码说明](https://docs.dataforseo.com/v3/appendix-errors/)

## DataForSEO：Amazon 美国站商品线索

1. 打开 [官方注册页](https://app.dataforseo.com/register)，按页面完成注册和邮箱验证。
2. 登录后打开 [API Access](https://app.dataforseo.com/api-access)，取得 **API login** 和 **API password**。API password 不是网页登录密码，也不要把 Base64 编码串当作原始密码。
3. 官方说明新账号有 $1 试用余额；先用试用余额联调，无需为本轮预先大额充值。在 Settings 设置日消费上限，查询后在 Usage 核对请求和费用。API 密码仅注册后最初 24 小时可见，之后可由账号本人点击 Send by e-mail 找回。[官方控制台指南](https://dataforseo.com/help-center/dfs-dashboard-how-to-find-everything)
4. 本轮用 **Merchant API → Amazon → Products → Live Advanced**，不是 Amazon Labs，也不要求先开通亚马逊卖家账号。请求参数为 `keyword=car seat back organizer`、`location_code=2840`、`language_code=en_US`、`depth=10`。[接口文档](https://docs.dataforseo.com/v3/merchant/amazon/products/live/advanced/)
5. 如自行用 API Playground 测试，先只发一条请求；Playground 调用真实接口会消费余额。不要反复点击后再由系统重复查询。Amazon Products Live 当前公开价为每 SERP $0.005，实际以账户和返回 cost 为准，不把“前 10 条商品”误算为 10 次单独请求。[官方价格](https://dataforseo.com/pricing/merchant/amazon-api)

交接内容：一行 `API登录名:API密码`，保存为名叫 `dataforseo` 的私有文本文件。不要带引号、`Basic` 前缀或 Base64 编码。管理员负责配置到 ECS secret 目录，并核对所选账号的团队展示和留存范围。

## SerpApi：Google Shopping 美国市场线索

1. 打开 [官方注册页](https://serpapi.com/users/sign_up)，按页面完成账号和邮箱验证，也可选 Google/GitHub 登录。
2. 登录后打开 [API Key 管理页](https://serpapi.com/manage-api-key)，复制私有 API key。
3. 当前官方 Free 方案列出每月 250 次搜索、每小时 50 次吞吐；先用免费配额联调，账号实际可用额度以控制台为准。[官方套餐页](https://serpapi.com/pricing)
4. 若用 Playground 自测，选择 `engine=google_shopping`，填写 `q=car seat back organizer`、`gl=us`、`hl=en`。只测一次即可；应用最多展示/保存前 10 条候选，不自动翻页。Google Shopping 是 Google 收录的商家线索，不等于某独立站的订单和销售后台。[接口文档](https://serpapi.com/google-shopping-api)
5. 记录该次搜索的状态和 search ID，回到账号页查看剩余配额；管理员也可用不消耗搜索配额的 [Account API](https://serpapi.com/account-api) 核验剩余量。

交接内容：单独一行 API key，保存为名叫 `serpapi` 的私有文本文件，不添加 `Bearer`、字段名或引号。

## 怎样交给管理员

最省事的方式：将两个文件放在本机你选择的私有目录，权限设为 `0600`，只告知文件路径。管理员将文件安全安装到 ECS `/opt/product-res-pilot/secrets/`，设置 UID/GID `10001:10001`、权限 `0600`。无需在聊天、仓库或表格中粘贴任何密钥。

管理员接到文件后会：

1. 核对凭据格式、余额/配额，以及账号许可的团队使用和原文留存范围。
2. 首轮每个来源按工作区只放行一次查询、最多前 10 条，不自动翻页、不自动重试计费请求。
3. 通过产品页面保存真实查询批次、请求定位、时间、费用或未知标记；由团队显式选中候选后纳入。
4. 按 [车辆内饰试点指南](vehicle-interior-pilot.md) 补供应报价、人工核验和后续结果。两个市场 API 不提供团队采购价、MOQ 或真实经营订单。

若免费账号不允许目标接口或返回授权/余额错误，先保留错误回执再处理账号配置，不用 Sandbox、示例结果或其他数据源冒充本轮真实接入。

后续复核：用户完成验证后，Amazon Live 查询成功，原费用 0.0033 USD；应用 30 秒超时后已通过官方免费接口取回原结果，无需更换密钥或充值。详见 [DataForSEO 复核记录](dataforseo-verification-2026-09-21.md)。

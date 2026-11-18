# product-analytics Specification

## Purpose

让站点运营者在上线 24 小时内能回答流量来自哪里、用户卡在哪一步、付款用户的首触来源，并保持每个站点的分析数据相互隔离。

## Requirements

### Requirement: 统一事件字典与属性
前后端 SHALL 使用同一事件字典：`page_view`、`sign_up`、`upload`、`generate_start`、`generate_success`、`generate_fail`、`paywall_view`、`checkout_start`、`payment_success`。每个事件 MUST 携带 `source`、`landing_path`、`locale`、`plan`、`device`，无值时 MUST 为显式缺省值 `(none)`。

#### Scenario: 属性缺省
- **WHEN** 未选择套餐的访客浏览页面
- **THEN** 事件的 `plan` 为 `(none)`，其余属性有值则填

### Requirement: 服务端权威事件
`sign_up` 与 `payment_success` SHALL 只由服务端上报，浏览器入口 MUST NOT 接受这两个事件。`payment_success` MUST 只在支付事件验签并提交后产生，同一笔付款 MUST 只计一次。

#### Scenario: 重复的支付回调
- **WHEN** 同一笔付款的多个回调先后到达
- **THEN** Plausible 只收到一次 `payment_success`

#### Scenario: 后台重放后入账
- **WHEN** 首次处理失败的付款经后台重放成功入账
- **THEN** 产生一次 `payment_success`

#### Scenario: 分析服务暂时不可用
- **WHEN** 发送事件失败
- **THEN** 事件按队列策略重试，且付款结果不受影响

### Requirement: 首触归因绑定用户
用户首次进站时 SHALL 记录来源（UTM、来源主机名）、落地路径与设备，并在注册时持久化到该用户，之后 MUST NOT 被后续来访覆盖。来源 MUST 优先取 `utm_source`，其次外站主机名，否则为 `direct`。

#### Scenario: ChatGPT 流量没有 referrer
- **WHEN** 访客经 `?utm_source=chatgpt` 的链接到达 `/guides/x` 且没有 referrer，之后注册
- **THEN** 该用户的来源为 `chatgpt`，落地路径为 `/guides/x`

#### Scenario: 再次来访
- **WHEN** 已有首触记录的访客从另一渠道再次到达
- **THEN** 首触来源不变

#### Scenario: 后台代建账号
- **WHEN** 管理员在后台创建用户
- **THEN** 不记录归因，也不产生 `sign_up`

#### Scenario: Cookie 被篡改
- **WHEN** 注册请求携带结构非法的归因 Cookie
- **THEN** 注册成功且不写入归因

#### Scenario: 付款归因
- **WHEN** 空间产生一笔成功付款
- **THEN** `payment_success` 携带该空间所有者的首触来源与落地路径

### Requirement: 分析隐私边界
发送到分析系统的 URL MUST 只保留 UTM 查询参数，空间 slug 与资源 ID MUST 被替换。后台与接口路径 MUST NOT 上报。设置 Do Not Track 或 Global Privacy Control 的访客 MUST NOT 被写入归因 Cookie 或上报事件。账号删除时 MUST 清除归因记录。

#### Scenario: 含令牌的页面
- **WHEN** 访客打开 `/reset-password?token=x`
- **THEN** 上报的 URL 不含 token

#### Scenario: 开启 DNT
- **WHEN** 设置了 DNT 的访客浏览公开页
- **THEN** 不写 Cookie 也不上报事件

#### Scenario: 删除账号
- **WHEN** 用户删除账号
- **THEN** 其归因记录被删除

### Requirement: 一站一 Plausible site
每个环境 SHALL 使用自己的 Plausible site 与实例地址，由环境配置决定。一个部署按访问域名服务多个站点时，SHALL 能为每个访问域名配置各自的 site：页面事件按当前访问域名选择，未登记的域名退回环境默认 site，没有默认 site 时不统计。站点或实例未配置时 MUST NOT 注入脚本或发送服务端事件，首触归因仍 MUST 写库。

#### Scenario: staging 使用自己的 site
- **WHEN** staging 配置 `acme-staging`，生产配置 `acme`
- **THEN** staging 页面只注入 `acme-staging` 的脚本

#### Scenario: 未配置
- **WHEN** `PLAUSIBLE_DOMAIN` 为空且没有站点映射
- **THEN** 页面没有 Plausible 脚本

#### Scenario: 多站按访问域名上报
- **WHEN** 生产映射 `ganjiday.com` → `ganjiday.com`、`arcanumber.com` → `arcanumber.com`，访客打开 `https://arcanumber.com/` 的预渲染首页
- **THEN** 该页的页面事件只上报到 site `arcanumber.com`

#### Scenario: 未登记的访问域名
- **WHEN** 配置了站点映射但 `PLAUSIBLE_DOMAIN` 为空，访客经 workers.dev 预览地址访问
- **THEN** 页面不加载 Plausible 脚本，也不发送页面事件

#### Scenario: 单站项目不受影响
- **WHEN** 只配置 `PLAUSIBLE_DOMAIN=acme`，没有站点映射
- **THEN** 任何访问域名的页面都上报到 `acme`，行为与引入映射前一致

### Requirement: 分析工具单选
模板配置 SHALL 用单一开关选择产品分析工具，取值为 `plausible`、`posthog` 或关闭，默认 `plausible`。关闭后 MUST NOT 写归因 Cookie、记录归因或上报事件。

#### Scenario: 长期词站关闭
- **WHEN** `features.analytics` 为 `false`
- **THEN** 不注入脚本、不写 Cookie、不上报事件

### Requirement: 可选热力图默认关闭
Clarity SHALL 仅在配置项目 ID 后加载，默认关闭，且 MUST 只在公开页面加载，遵守 DNT 与 GPC，MUST NOT 作为转化事件来源。

#### Scenario: 默认不加载
- **WHEN** 未配置 Clarity 项目 ID
- **THEN** 任何页面都不请求 Clarity

#### Scenario: 应用区不加载
- **WHEN** 已配置 Clarity 且用户位于 `/app`
- **THEN** 不加载 Clarity

### Requirement: 每日赠送指标
既有运营指标 SHALL 展示每日实际赠送次数和积分总数，来源 MUST 为已提交的 daily 账本，不包含邮箱正文。并发重试、缓存命中与未发放的访问 MUST 不增加指标。

#### Scenario: 权威汇总
- **WHEN** 多个请求只产生一次实际赠送并运行现有汇总
- **THEN** 当日次数为 1，积分总数为该次实际赠送量

### Requirement: 服务端事件的站点归属
配置了站点映射时，`sign_up` SHALL 上报到注册请求访问域名对应的 site，付款事件 SHALL 上报到付款归属用户注册时访问域名对应的 site。事件 URL SHALL 使用该访问域名。注册域名未登记或没有记录时退回环境默认 site，没有默认 site 时 MUST NOT 发送，付款真相仍在数据库。

#### Scenario: 在西方站注册
- **WHEN** 用户经 `arcanumber.com` 完成注册
- **THEN** `sign_up` 上报到 site `arcanumber.com`，事件 URL 的主机名为 `arcanumber.com`

#### Scenario: 东方站用户付款
- **WHEN** 经 `ganjiday.com` 注册的用户完成一笔付款
- **THEN** `payment_success` 上报到 site `ganjiday.com`

#### Scenario: 注册域名缺失且无默认 site
- **WHEN** 付款归属用户没有注册域名记录，且 `PLAUSIBLE_DOMAIN` 为空
- **THEN** 不发送 `payment_success`，付款记录不受影响

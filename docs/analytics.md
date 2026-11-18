# 埋点、首触归因与发布串扰门禁

本文记录实现约定。

## 1. 分工

| 系统 | 职责 |
|---|---|
| 自建 Plausible | 多站日更漏斗与产品事件，默认真相源 |
| 数据库 `payment` + `user_attribution` | 付款与归因的最终记录；Plausible 不可用时仍可查询 |
| GSC / Bing | 收录与查询词 |
| Sentry | 错误与性能，不被 Plausible 替代 |

`features.analytics` 是单选（`'plausible' | 'posthog' | false`），不存在多套并行。不做会话录制和广告追踪。

## 2. 事件字典

事件名与属性定义在 `packages/shared/src/analytics.ts`，前后端共用。

| 事件 | 上报方 | 触发点 |
|---|---|---|
| `page_view` | 浏览器 | 路由变化（Plausible 中显示为 `pageview`） |
| `sign_up` | **服务端** | Better Auth `user.create.after`，后台代建账号除外 |
| `upload` | 浏览器 | 媒体文件上传完成 |
| `generate_start` | 浏览器 | 提交对话或媒体任务 |
| `generate_success` / `generate_fail` | 浏览器 | 对话结束；媒体任务在详情页观察到状态转换 |
| `paywall_view` | 浏览器 | 定价页、账单页、额度或套餐不足的错误 |
| `checkout_start` | 浏览器 | 发起结账 |
| `payment_success` | **服务端** | 验签并提交后的支付事件（含后台重放） |

每个事件都带 `source`、`landing_path`、`locale`、`plan`、`device`，无值时为 `(none)`。

浏览器统一调用 `trackEvent`（`apps/web/src/features/analytics/track.ts`），类型上不接受 `sign_up` 与 `payment_success`。

媒体任务的终态只在用户停留在详情页时才记录，离开页面后结束的任务不计入 `generate_success` / `generate_fail`。

服务端事件经 `EVENTS_QUEUE` 交给 jobs（`apps/jobs/src/notifications/analytics.ts`）：消息只带身份标识，消费者从数据库读取归因与套餐，发送前在 `analytics_delivery` 用主键占位，并发或重复的 Webhook 只发送一次，发送失败时释放占位并重试。占位后进程崩溃会少计一次，不会多计。实例长时间不可用时，事件重试到上限后丢弃并记日志 `analytics.dropped`，不进死信、不触发运营告警。`sign_up` 消息带 IP 与 UA，用于串联同一访客。

`payment_success` 没有用户的 IP 和 UA，Plausible 不会把它与同一访客的页面浏览串联，每次还会多算一个来源为 Direct / None 的访客。按渠道看付款请用事件属性 `source`，或用第 3 节的 SQL。实例丢弃事件时响应头带 `x-plausible-dropped`，记日志 `analytics.event_dropped`。

路径中的空间 slug 与 UUID 替换为 `:slug` / `:id`，URL 查询参数只保留 UTM。

## 3. 首触归因

1. 首次进站时，浏览器写第一方 Cookie `product_res_ft`（180 天，已存在则不覆盖）：UTM、来源主机名、落地路径、设备。公开页可能是静态预渲染，所以由客户端写入。
2. 注册时，服务端读取并校验 Cookie，写入 `user_attribution`，之后不再更新。
3. 付款归因到空间所有者：个人空间即付款人，团队空间由最早的所有者代表。

设置了 DNT 或 GPC 的访客不写 Cookie、不上报事件，注册时服务端同样检查 `DNT` / `Sec-GPC` 请求头。`features.analytics=false` 时同样关闭。隐私政策模板已说明这个 Cookie；面向欧盟等要求事先同意的地区上线前，请确认是否需要同意流程。

**GEO 流量必须带 UTM**：AI 助手常常不传 referrer，发布到这些渠道的链接统一带 `utm_source=chatgpt`（或对应渠道名）与 `utm_medium=geo`。来源优先取 `utm_source`，其次是外站主机名，最后是 `direct`。

回答「谁付」的查询：

```sql
select a.source, a.medium, a.campaign, a.landing_path, count(*) as payments, sum(p.amount) as amount, p.currency
from payment p
join member m on m.organization_id = p.workspace_id and m.role = 'owner'
join user_attribution a on a.user_id = m.user_id
where p.status = 'succeeded'
group by 1, 2, 3, 4, p.currency
order by payments desc;
```

团队空间有多个所有者时，这个查询会重复计数；需要精确时按 `member.created_at` 取最早的所有者。

## 4. Plausible 接入

共用一个自建实例，默认一站一 site；一个部署按访问域名服务多个站点时见下文「多站」。

社区版（实测 v3.2.1）的限制：

- **没有漏斗和收入目标**。`payment_success` 的 `revenue` 字段会被静默丢弃，事件本身和自定义属性正常保存。收入看第 3 节的 SQL；看流失时对比各目标的转化数，可按属性 `source` 筛选。
- 不按数据中心 IP 过滤，Webhook 来源的事件不会因此被丢弃。

| 变量（公开，非密钥） | 含义 |
|---|---|
| `PLAUSIBLE_DOMAIN` | 本环境的 site_id：生产 `<项目名>`，staging `<项目名>-staging` |
| `PLAUSIBLE_HOST` | 自建实例地址，如 `https://plausible.example` |

- Cloudflare：写在 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 对应环境的 `vars`，两者须一致；jobs 还需要 `APP_URL`。
- selfhost：写在 `.env`。预渲染页面在镜像构建时生成，读不到运行时环境，取自 `template.config.ts` 的 `analytics.plausibleDomain/plausibleHost`（生成器写入），与 `APP_URL` 的预渲染行为一致；同一镜像跑多个环境时公开页会带构建时的 site，会被门禁拦下。

两个变量任一为空时不注入脚本，也不发送服务端事件。首触归因不依赖它们，仍然写库。

模板仓库自身的 staging 已接入 `https://stats.ganjiday.com`（site `product-res-staging`），production 两个变量为空，不启用。

### 多站（按访问域名选择 site）

一个部署（同一 Worker 或同一 selfhost 实例）按访问域名服务多个站点、且要分开统计时，额外配置可选变量 `PLAUSIBLE_SITES`。未配置时行为与单站完全相同。

| 变量 | 含义 |
|---|---|
| `PLAUSIBLE_SITES` | 访问域名到 site_id 的映射，格式 `host=site,host=site`，如 `ganjiday.com=ganjiday.com,arcanumber.com=arcanumber.com` |
| `PLAUSIBLE_DOMAIN` | 多站时只作未登记域名的兜底，可留空；留空表示 workers.dev 预览等未登记地址不统计 |

- 映射的域名比较时转小写，并去掉端口、结尾的点和开头的 `www.`；任一项缺少 `=`、域名或 site 为空、同一域名出现两次都视为格式错误，运行时整体不启用，`pnpm check` 会拒绝。
- 写法与单站变量相同：Cloudflare 写在 web 与 jobs 对应环境的 `vars`（两者须一致）；selfhost 写在 `.env`，预渲染取 `template.config.ts` 的 `analytics.plausibleSites`（默认空串）。生成器不提供参数，也不继承映射，需要时手工配置。
- 所有站点共用一个 `PLAUSIBLE_HOST` 实例，CSP 不变。

**页面事件与预渲染**：预渲染 HTML 被所有访问域名共用，构建时不知道访客从哪个域名进来。多站时 head 不再输出带 `data-domain` 的脚本，而是输出一段不执行的内联配置 `<script type="application/json" id="product-res-plausible">`，内容为 `{ sites, fallback, scriptUrl }`。首次 `trackEvent` 前，浏览器按 `location.hostname` 解析出 site，再插入一次 `script.manual.js` 并带上对应的 `data-domain`；脚本加载前的事件留在 `window.plausible` 队列中，加载后补发。解析不出 site 时不插入脚本，并清空队列。

**服务端事件的站点归属**：

- 注册钩子按上面的规则规范化请求的 `Host`，写入 `user_attribution.signup_host`，同时放进 `sign_up` 队列消息的 `host`。没有首触 Cookie 时不写归因行，但消息仍带 `host`。
- jobs 发送时，`sign_up` 取消息中的 `host`，`payment_success` 取空间所有者归因行的 `signup_host`。该域名在映射中登记过时，site 用映射值，事件 URL 用 `https://<该域名><路径>`；未登记或缺失时退回 `PLAUSIBLE_DOMAIN` 与 `APP_URL`，兜底也为空时不发送。`Host` 可以伪造，所以只认映射中登记过的域名，影响仅限统计口径。
- `signup_host` 的口径：只有带首触 Cookie 注册的用户才有归因行，所以清过 Cookie 的用户以及引入该列之前注册的老用户都没有它，他们的付款会退回兜底 site（兜底为空时不进 Plausible）。为了不扩大隐私面，不另外记录，也不回填。按站点看付款的准确数字用 SQL：

```sql
select coalesce(a.signup_host, '(unknown)') as site_host, count(*) as payments, sum(p.amount) as amount, p.currency
from payment p
join member m on m.organization_id = p.workspace_id and m.role = 'owner'
left join user_attribution a on a.user_id = m.user_id
where p.status = 'succeeded'
group by 1, p.currency
order by payments desc;
```

团队空间有多个所有者时同样会重复计数，处理方式同第 3 节。

回滚：删除 `PLAUSIBLE_SITES` 即退回单站行为，`signup_host` 列可以保留不用。

新站开通：

1. 在实例中添加两个 site（生产、staging）。
2. 添加目标（Goals）：`sign_up`、`upload`、`generate_start`、`generate_success`、`generate_fail`、`paywall_view`、`checkout_start`、`payment_success`。未添加的事件不会显示在仪表盘。
3. 在 Site settings 启用自定义属性：`source`、`landing_path`、`locale`、`plan`、`device`。

### 开关

| 站类型 | 配置 |
|---|---|
| 新词站（默认） | `features.analytics: 'plausible'`，生成时默认 `--analytics plausible` |
| 长期词站（可关） | `features.analytics: false`，或生成时 `--analytics off`；改配置后需重新部署 |

## 5. 串扰门禁

| 检查 | 时机 | 内容 |
|---|---|---|
| `scripts/production/check-wrangler-envs.mjs` | `pnpm check` | staging 与生产不得共用 `APP_URL` / `PLAUSIBLE_DOMAIN`，也不得共用 `PLAUSIBLE_SITES` 映射中的任一 site（含对方的兜底）；映射必须能解析；web 与 jobs 的站点变量（含 `PLAUSIBLE_SITES`）一致 |
| `scripts/staging/check-site-isolation.mjs <环境> <URL>` | 部署后，失败则阻断发布 | sitemap（含子地图）、robots、canonical、hreflang、`og:url`、favicon 都属于本环境 `APP_URL` 且可访问；期望的 site 按被检查 URL 的域名在映射中查找，未登记时取 `PLAUSIBLE_DOMAIN`。单站页面比较脚本的 `data-domain`；多站页面读取内联配置 `#product-res-plausible`，校验它为本域名解析出的 site 与 `scriptUrl` 的实例地址。期望为空时页面不得出现脚本或内联配置 |

新项目的 staging `APP_URL` 默认是 `https://staging.<域名>`，部署前改成实际地址，否则门禁会失败。selfhost 的部署流程尚未接入这个脚本（它从 `wrangler.jsonc` 读取期望值）。

## 6. llms.txt、IndexNow 与答案页

- `/llms.txt`：由公开页面清单生成，只列默认语言，门禁校验其中链接属于本站。关闭营销站时不存在。
- IndexNow：`INDEXNOW_KEY` 配置在 web 运行环境（Cloudflare 用 `wrangler secret put`，selfhost 写 `.env`）和生产部署的 GitHub secret，两处相同。协议要求密钥可公开访问，站点从 `/indexnow.txt` 返回；不要写进仓库。
- 提交时机：生产发布成功后，`scripts/production/submit-indexnow.mjs` 提交站点地图中的本站地址，未配置时跳过，失败只告警。staging 不提交。重要页面单独更新后，可手动运行 `INDEXNOW_KEY=... node scripts/production/submit-indexnow.mjs <站点地址>`。selfhost 发布流程未接入，请手动运行。
- 答案页：`features.guides` 开启后，`apps/web/content/guides/<locale>/<slug>.mdx` 自动预渲染并进入站点地图和 `llms.txt`。frontmatter 必填 `title`、`answer_summary`（置顶结论）、`faq[]`（`q`、`a`，同时生成 FAQ JSON-LD）、`kind`（`how-to` / `is-it-free` / `trends`）、`updatedAt`。示例都是占位文案，上线前替换。

## 7. Clarity（默认关闭）

在 `template.config.ts` 设置 `analytics.clarityProjectId` 后才加载，只在公开页面运行，遵守 DNT / GPC；站内导航进入应用区时整页刷新以卸载脚本。Clarity 会录制会话，启用前须更新隐私政策；它不产生漏斗事件，不作为转化真相源。

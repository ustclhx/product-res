# 公开页面 SEO

公开页面通过 `pageHead` 输出标题、描述、canonical、Open Graph、Twitter 与 hreflang。
根布局从 Worker 的 `APP_URL` 下发站点地址；`/app`、`/account`、`/admin`、`/api` 禁止索引。
站点地图与 OG 接口共用 `publicPages`，只收录功能开关已开启的页面、已发布的文章，排除草稿与未来文章。
默认语言无前缀，其他语言使用 `/<locale>`，缺少译文时沿用内容模块已有的默认语言回退。

## 构建与部署

预渲染 HTML 中的绝对地址在构建时固化，每个环境需要分别构建。直接运行 Web 包构建，确保 `APP_URL`
传入 Vite（根目录 Turbo 默认使用严格环境过滤，不能仅在根目录命令前设置该变量）。

```sh
# staging：替换为已配置的 staging 域名
APP_URL=https://staging.example.com CLOUDFLARE_ENV=staging pnpm --filter @product-res/web build
# production：替换为生产域名
APP_URL=https://product.ezarouter.cc pnpm --filter @product-res/web build
```

构建时该值同时覆盖 Cloudflare 产物中的公开变量与本地预渲染 preview 的 `APP_URL`，不修改密钥。
部署必须使用该环境的构建产物，运行时 `APP_URL` 与构建地址保持一致；切换域名后重新构建预渲染页面。
数据库不可达时公告/会话装饰降级，套餐沿用现有构建快照与运行时缓存；不存在的套餐不虚构 Product 或 Offer。

## 分享图片

使用 `cf-workers-og@3.0.1` 的 Node 入口（satori + resvg-wasm）在构建期为每个公开页面、各语言版本生成
1200×630 PNG，包含定价、候补名单和通讯等未预渲染路由。图片输出到 `dist/client/og/`，
页面 `og:image` 指向静态资源；`_headers` 配置一天的公共缓存，不需要 Worker 运行时生成与 Cache API。
草稿与未到发布时间的文章不生成图片，定时文章到期后需要重新部署以更新预渲染列表、分享图与内容。
本地开发使用同一生成器，仅对清单中的公开页面响应图片。

运行时分享卡片（项目注册的结果卡片、通用分享页 `/s/<类型>/<令牌>`、到期、失效与缓存）见
[分享卡片与分享页](../../../../../docs/share-cards.md)。构建期分享图的版式与运行时分享卡片共用 `features/share-cards/layout.tsx` 的默认版式（设计稿
`docs/design-system/prototypes/share-cards/Card.dc.html` 的 `default` 变体，浅色主题 token），
渲染经 `src/node/share-card-renderer.ts`。

字体保存在 `apps/web/public/fonts/share-card/`，作为静态资源发布（`_headers` 长期缓存与 `noindex`）：

- CJK：Noto Sans SC Regular 的完整简体中文子集 OTF，仅一个字重，原始体积 8,331,336 字节。构建期与 Node 从本地文件读取；
  Workers 只在待渲染文本含 CJK 时经 `ASSETS.fetch` 读取，不进入 Worker 包。
  源文件：https://github.com/notofonts/noto-cjk/blob/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf ，
  许可证 `NOTO-LICENSE`（SIL OFL 1.1）。
- 西文：Inter Latin 400/600 woff（`@fontsource/inter@5.2.8`，satori 不支持 woff2），扩展名为 `.woff.bin`，
  以便 Workers 作为 Data 模块随渲染器打包；许可证 `INTER-LICENSE`（SIL OFL 1.1）。

文字支持范围（分享卡片与构建期分享图共用，`features/share-cards/text.ts`）：

- 文本含 Inter Latin 子集之外的字符时才加载 Noto Sans SC：中日文、基本西里尔与基本希腊字母、拼音声调字母。
- emoji（含 ZWJ 序列、变体选择符、肤色修饰与旗帜）在渲染前去除，没有 emoji 字体。
- 两种字体都缺字的带附加符号字母降级为基本字母（如 `Ą`→`A`、`ά`→`α`）。
- **模板字体不支持**：谚文（韩文）、泰文、老挝文、高棉文、缅甸文，以及 Noto 简体子集之外的扩展西里尔字母（如乌克兰文 `і`、`ї`）。
  这些字符显示为方框；项目在 `features/share-cards/share-cards.fonts.ts` 登记回退字体后正常显示，构建期分享图同样生效，见 [分享卡片 §7.1](../../../../../docs/share-cards.md#71-项目回退字体)。
- 副标题为「应用名 · 首页 SEO 标题」（按页面语言），多站点项目可按站点覆盖，见 [分享卡片 §6.1](../../../../../docs/share-cards.md#61-多站点)。

## 验证

```sh
pnpm --filter @product-res/web test --project unit src/features/seo
pnpm --filter @product-res/web test:e2e seo.spec.ts
pnpm --filter @product-res/web build
cd apps/web
pnpm exec wrangler deploy --dry-run --outdir /tmp/seo-worker
```

离线单元测试解析 JSON-LD，检查 Organization、WebSite、BlogPosting、Product、Offer 的关键字段与套餐价格、货币。
页面测试检查实际各语言路由的唯一标题/canonical、客户端导航、发布过滤以及 静态 PNG 格式和尺寸。

人工复核：部署后打开 https://search.google.com/test/rich-results ，分别输入首页、博客文章与定价页地址。
也可粘贴预渲染 HTML；检查解析出的 BlogPosting、Product/Offer 与页面文案和价格一致。
Organization/WebSite 不一定获得富媒体展示资格，可同时用 https://validator.schema.org/ 检查其结构。
空套餐目录不输出产品，人工复核定价页应使用已有真实套餐数据的环境。

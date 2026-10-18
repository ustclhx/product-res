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

字体为 Noto Sans SC Regular 的完整简体中文子集 OTF，仅使用一个字重，原始体积 8,331,336 字节。
完整字形支持后续新增中文文章标题；字体保存在 `apps/web/scripts/seo/`，只供 Node 构建工具读取，
不会进入 Worker 或客户端静态资源包；WASM 同样仅留在构建阶段。
源文件：https://github.com/notofonts/noto-cjk/blob/main/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf 。
再分发许可证见 `apps/web/scripts/seo/FONT-LICENSE`（SIL OFL 1.1）。

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

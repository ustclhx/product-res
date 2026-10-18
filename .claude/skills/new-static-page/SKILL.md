---
name: new-static-page
description: 在本模板新增或修改公开静态页、法律页、博客与文档内容，联动语言、SEO 和预渲染；适用于无需登录或业务写入的页面。
---

# 新增静态页

从含 `package.json` 与 `template.config.ts` 的项目根执行命令。下列路径均相对项目根；生成后的项目包 scope 可能改变，执行包命令前从 `apps/web/package.json` 读取真实包名，将示例的 `@product-res/web` 替换。先读 `AGENTS.md`、`docs/02-project-structure.md` 和 `apps/web/src/features/seo/README.md`。

## 1. 确定内容入口

确认用户给出的 URL、集合、slug、启用语言、标题/描述、正文和上线时间。检查 `template.config.ts` 的 `marketing.enabled`、`i18n.enabled`、`i18n.locales`、默认语言，以及博客/文档功能开关。

- 法律、博客、文档优先增加 `apps/web/content/<集合>/<locale>/<slug>.mdx`；集合目录是 `legal`、`blog`、`docs`。语言和 slug 从路径解析，不写重复 frontmatter 字段。
- 法律页由 `apps/web/src/routes/legal/$slug.tsx` 自动承接；博客和文档也已有动态路由。已有集合新增内容无需逐页创建 TSX 路由。
- 独立页面才在 `apps/web/src/routes/` 添加文件路由，参考法律页的 `MarketingShell`、`loader`、`head`。登录后页面使用 `new-page` 技能。

完成标准：确定一个现有内容集合或一个确需新增的路由；明确哪些启用语言提供译文，哪些按现有默认语言规则回退。

## 2. 写内容与文案

以 `apps/web/content-collections.ts` 的实际 Zod schema 为准：

| 集合 | frontmatter |
|---|---|
| legal | `title`、`description`、`updatedAt`（ISO 日期） |
| blog | `title`、`summary`、`date`；可选 `cover`、`tags`、`draft` |
| docs | `title`、`description`、`section`；可选 `order`、`requires: publicApi` |

可从 `apps/web/content/legal/en/privacy.mdx` 复制结构；法律与文档可复用 `{{appName}}`、`{{appUrl}}`、`{{supportEmail}}`、`{{refundWindowDays}}` 占位符。保留用户提供的条款与授权范围，法律内容审核和发布仍由用户决定。

MDX 在 Node 构建期渲染 HTML，Worker 页面读取静态结果。正文仅接受可信仓库作者内容；不要把用户提交的 MDX 或 HTML直接交给此链路。博客草稿生产构建排除，未来日期到期前不可见；到期后需要重新构建才能更新预渲染、地图和图片。

UI 文案写入 `apps/web/messages/<locale>/<feature>.json`，沿用现有键名和 `m` 调用。单语言只要求默认语言；多语言覆盖启用语言。`apps/web/src/features/marketing/content.ts` 定义缺译文的回退，沿用它而非自建回退。内容目录中的占位路径是约定，创建实际文件时替换集合、语言与 slug。

完成标准：frontmatter 满足现有 schema，文案没有硬编码到共享页面，译文或回退策略可逐项核验。

## 3. 联动 SEO、发现与裁剪

内容动态路由沿用 `apps/web/src/features/seo/metadata.ts` 的 `pageHead` 和 `originFromMatches`，得到标题、描述、canonical、hreflang、OG/Twitter。独立路由也使用此入口，避免重复写元标签。

`apps/web/src/features/seo/pages.ts` 的 `publicPages` 是 sitemap 与 OG 的共同清单：现有集合自动收录；新增独立页面须在清单及 `metadata.ts` 的 `staticPage` 中补齐语言元数据。核对 `apps/web/src/routes/sitemap[.]xml.ts` 与 `apps/web/src/features/seo/og-card.ts`，地图和图片不能出现草稿、未来内容或关闭功能的路由。新语言的标题/描述也应补入元数据，当前 `staticPage` 内置文案只区分 zh 与其他语言。

`apps/web/src/features/marketing/prerender.ts` 默认预渲染首页、`/blog`、`/legal`、`/docs`；其他页面根据需求加入匹配范围并提供可爬取链接，入口由各语言首页开始。`/pricing` 有自己的数据策略，保留现有处理。

新增营销路由时同步检查 `apps/web/src/router.tsx` 的营销关闭裁剪规则，以及 `apps/web/vite.config.ts` 的预渲染配置。关闭营销时页面、地图、预渲染都应按现有开关消失；公开页读取失败时维持降级，数据库不可达不应阻止静态构建。导航入口放到现有营销布局的适当位置，使新页可被发现。

完成标准：路由 head、公开清单、可爬取链接、预渲染和功能关闭行为一致。

## 4. 验证与交付

```sh
pnpm check
pnpm --filter @product-res/web typecheck
pnpm --filter @product-res/web test --project unit src/features/marketing/content.test.ts src/features/marketing/prerender.test.ts src/features/seo
APP_URL=https://product.ezarouter.cc pnpm --filter @product-res/web build
git diff --check
```

构建地址换成用户的目标公开域名。直接调用 web 包构建可将 `APP_URL` 送入 Vite；预渲染地址构建时固化，部署域名变化需重建。Node 目标沿用 `apps/web/package.json` 的 `build:node` 和现有 Node 构建入口，不把 Worker 产物当作 Node 产物。

类型检查/构建生成 `apps/web/src/routeTree.gen.ts`、`apps/web/src/paraglide/`、`apps/web/.content-collections/generated/`；均按仓库忽略规则处理，不手工编辑生成文件。仅对新增分支或真实回归扩展现有测试。通过本地 dev/preview 检查目标 URL、启用语言、缺译文回退、canonical/hreflang、地图条目和 OG 图片；构建输出中的页面 HTML 应含正文且不依赖数据库。只停止自己启动的进程。

交付修改文件、真实执行的命令/结果、内容与语言检查结果，以及尚未完成的发布或法律审核。没有部署就只声明本地验证。

## 常见故障

- 内容缺失：检查路径、schema、集合开关、草稿/日期及构建是否重新执行；`CONTENT_DRAFTS=1` 只用于明确的草稿预览。
- 路由或文案类型缺失：运行 web 的 typecheck，它包含路由、文案和内容生成；修正源文件后重跑，不修生成文件。
- 新页有 HTML 但无地图/OG：核对 `publicPages` 与新页链接；有错误域名则核对构建时 `APP_URL` 并重建。
- 关闭营销仍能访问：补齐 `router.tsx` 裁剪及公开清单/预渲染开关，再按关闭配置验证。

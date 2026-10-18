# Lighthouse 验收（add-marketing-i18n-seo 5.2）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-11 |
| 环境 | `https://web-staging.product-res-jobs.workers.dev`，版本 `2463722cbb63692329d90582039671f9534714a0` |
| 工具 | `npx lighthouse@12.8.2 --only-categories=seo,accessibility`，Chrome headless，默认移动端模拟 |

| 页面 | SEO | 可访问性 |
|---|---|---|
| `/` | 100 | 100 |
| `/pricing` | 100 | 100 |
| `/blog/welcome` | 100 | 100 |
| `/zh` | 100 | 100 |
| `/zh/pricing` | 100 | 100 |
| `/zh/blog/welcome` | 100 | 100 |

结论：全部不低于 90，5.2 通过。

# release-site-isolation Specification

## Purpose

防止环境之间或衍生站之间的配置串扰：发布前后校验公开 SEO 地址与分析脚本都属于当前环境，发现问题即阻断发布。

## Requirements

### Requirement: 部署后站点归属门禁
staging 与生产部署后 SHALL 校验 sitemap（含子地图）、robots、`llms.txt`、canonical、hreflang、`og:url`、favicon 的地址都属于当前环境 APP_URL 且可访问；任一不符 MUST 使部署流程失败。

#### Scenario: sitemap 指向他站
- **WHEN** `sitemap.xml` 的 `<loc>` 指向 `https://arcanumber.com/sitemap/en.xml`
- **THEN** 门禁失败并指出该地址

#### Scenario: 子地图 404
- **WHEN** 站点地图索引列出的子地图返回 404
- **THEN** 门禁失败

#### Scenario: favicon 缺失
- **WHEN** `/favicon.ico` 返回 404
- **THEN** 门禁失败

#### Scenario: 部署地址与配置不一致
- **WHEN** 被检查的地址与该环境配置的 APP_URL 不同源
- **THEN** 门禁失败

### Requirement: 分析脚本归属门禁
门禁 SHALL 校验页面中的分析脚本 site 与实例地址等于当前环境配置；配置了站点映射时，期望的 site 按被检查地址的访问域名在映射中查找，未登记时取环境默认 site。期望的 site 为空时页面 MUST NOT 出现分析脚本或站点映射。

#### Scenario: 生产脚本进入 staging
- **WHEN** staging 页面注入了生产 site 的脚本
- **THEN** 门禁失败

#### Scenario: 多站页面带了他站映射
- **WHEN** 检查 `https://arcanumber.com/`，页面给出的站点映射把 `arcanumber.com` 指向 `ganjiday.com`
- **THEN** 门禁失败

### Requirement: 静态配置检查
`pnpm check` SHALL 拒绝 staging 与生产共用 `APP_URL`、`PLAUSIBLE_DOMAIN` 或站点映射中任一 site 的配置，并拒绝同一环境的 web 与 jobs 站点变量（含站点映射）不一致的配置，以及无法解析的站点映射。

#### Scenario: staging 复用生产域名
- **WHEN** `env.staging.vars.APP_URL` 等于 `env.production.vars.APP_URL`
- **THEN** 检查失败

#### Scenario: staging 映射到生产 site
- **WHEN** staging 的站点映射中有一个 site 与生产的映射或默认 site 相同
- **THEN** 检查失败

#### Scenario: 映射格式错误
- **WHEN** 站点映射中某一项缺少 `=` 或域名为空
- **THEN** 检查失败

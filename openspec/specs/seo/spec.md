# seo Specification

## Purpose

让公开页面能被搜索引擎正确抓取与索引、在社交平台上有正确的分享预览，同时避免应用区与后台被索引。
统一页面元数据、多语言关联、站点地图、结构化数据与默认分享图，使公开内容的搜索发现与分享展示保持一致。

## Requirements

### Requirement: 页面元数据
每个公开页面 SHALL 具有唯一的标题与描述、规范链接（canonical）以及社交分享所需的 Open Graph 与 Twitter 卡片信息。

#### Scenario: 分享博客文章
- **WHEN** 有人在社交平台分享一篇博客文章链接
- **THEN** 预览显示该文章的标题、摘要与封面图

### Requirement: 多语言关联
存在多语言版本的公开页面 SHALL 声明各语言版本之间的 hreflang 关联，并包含 x-default。

#### Scenario: 定价页的语言版本
- **WHEN** 搜索引擎抓取英文定价页
- **THEN** 页面声明了中文版本地址与 x-default

### Requirement: 站点地图与抓取规则
站点 SHALL 提供包含所有公开、已发布页面（含各语言版本）的站点地图，以及 robots 规则；应用区（`/app`）、后台（`/admin`）与接口路径 MUST 被禁止抓取，且这些页面 SHALL 带 noindex。

#### Scenario: 站点地图内容
- **WHEN** 搜索引擎读取站点地图
- **THEN** 其中包含首页、定价、已发布博客文章与法律页的各语言地址，不包含 `/app` 与 `/admin`

### Requirement: 结构化数据
首页 SHALL 提供组织与网站的结构化数据，博客文章 SHALL 提供文章结构化数据，定价页 SHALL 提供产品与价格的结构化数据。

#### Scenario: 博客文章结构化数据
- **WHEN** 搜索引擎抓取一篇博客文章
- **THEN** 页面中包含作者、发布日期与标题的文章结构化数据

### Requirement: 动态分享图
没有指定封面的公开页面 SHALL 自动生成包含站点名称与页面标题的分享图片。

#### Scenario: 法律页分享
- **WHEN** 分享没有封面图的服务条款页面
- **THEN** 预览图显示站点名称与「服务条款」标题

### Requirement: llms.txt
启用营销站时站点 SHALL 提供 `/llms.txt`，列出站点名称与公开、已发布页面，地址 MUST 属于当前环境 APP_URL。

#### Scenario: 读取 llms.txt
- **WHEN** 请求 `/llms.txt`
- **THEN** 返回 200 的纯文本，其中的链接都指向本站

#### Scenario: 不含私有路径
- **WHEN** 读取 `/llms.txt`
- **THEN** 不包含 `/app`、`/admin` 与 `/api`

### Requirement: IndexNow 提交
配置 IndexNow 密钥后，站点 SHALL 在 `/indexnow.txt` 公开该密钥，生产发布后 SHALL 提交站点地图中的本站地址；提交失败 MUST NOT 使发布失败。未配置时 `/indexnow.txt` MUST 返回 404，MUST NOT 提交。密钥 MUST NOT 写入仓库。

#### Scenario: 未配置密钥
- **WHEN** 没有配置 `INDEXNOW_KEY`
- **THEN** `/indexnow.txt` 返回 404，发布步骤跳过提交

#### Scenario: 提交失败
- **WHEN** IndexNow 服务返回错误
- **THEN** 记录警告，发布继续

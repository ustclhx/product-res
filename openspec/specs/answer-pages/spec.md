# answer-pages Specification

## Purpose

提供可复制的“结论置顶 + FAQ”指南页骨架，让新站无需写代码即可发布便于搜索与 AI 引用的答案页。

## Requirements

### Requirement: 答案页内容约定
答案页 SHALL 由内容文件定义，frontmatter MUST 至少包含 `title`、`answer_summary`、`faq[]`，缺失时构建 MUST 失败。模板 SHALL 提供“怎么做”“免费吗”“趋势是什么”三类示例。

#### Scenario: 缺少结论摘要
- **WHEN** 内容文件没有 `answer_summary`
- **THEN** 构建失败并指出该文件

### Requirement: 结论置顶与 FAQ 结构化数据
答案页 SHALL 把 `answer_summary` 显示在正文之前，并在页面源码中输出与 `faq[]` 一致的 FAQ JSON-LD。

#### Scenario: 查看页面源码
- **WHEN** 抓取一篇答案页的 HTML
- **THEN** 结论在正文之前，且包含 `FAQPage` 结构化数据

### Requirement: 答案页开关与收录
答案页 SHALL 由 `features.guides` 控制。开启时 MUST 预渲染并进入站点地图与 `llms.txt`；关闭时路由 MUST 返回 404，内容 MUST NOT 进入构建产物。

#### Scenario: 关闭答案页
- **WHEN** `features.guides` 为 `false`
- **THEN** `/guides` 返回 404，站点地图不含 `/guides`

---
version: 0.2.0
previous: v0.1.3
date: YYYY-MM-DD
breaking: false
---

<!--
机器可读约定（template-release.mjs check 按此校验）：
- 文件名为 <version>.md。version 为无前缀 SemVer；previous 为上一模板版本的无前缀版本号，
  首个版本固定写 v0.1.3；date 为真实的 YYYY-MM-DD 日期；breaking 为 true 或 false。
- 可选 frontmatter requiresDeployed 为无前缀 SemVer，表示必须先部署的已发布模板版本。
  收缩迁移必须声明该字段，并在部署顺序中解释先扩展后收缩的步骤。
- 以下八个二级标题必须保持原名与顺序，每节无内容时写「无」。
- 「必须执行的动作」使用有序列表；每条末尾可写（适用：key=value; key=value）。
  key 为 .template-base.json 的 params 键，多个条件均需满足；列表型参数表示包含该值，
  不写条件表示适用全部。例如：1. 配置部署绑定。（适用：target=selfhost; ai=text）
- 「数据库变更」每个迁移使用三级标题 ### <迁移 tag>，其下固定四个字段：
  - 类别：扩展|收缩|数据迁移
  - 兼容上一版本代码：是|否
  - 锁表与耗时：具体风险与预计耗时
  - 回滚：具体回滚方式
  四字段后可再写内容摘要段落；迁移清单必须与本版本区间新增 SQL 文件完全一致。
  每个迁移必须兼容上一版本代码；回滚只回退代码，不自动回退数据库结构。
- 必须执行的动作非空或包含收缩迁移时，breaking 必须为 true。
- 只写密钥名称与配置位置，不得包含密钥值、个人邮箱或生产资源 ID。
-->

## 概要

无

## 必须执行的动作

无

## 配置变更

无

## 数据库变更

无

## 部署顺序

无

## 验证

无

## 回滚

无

## 已知问题

无

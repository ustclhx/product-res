# template-release Specification

## Purpose
让模板以带版本号的发布交付更新：每个版本附带面向衍生项目的升级说明，写明必须执行的动作、配置变化和数据库变更；模板迁移与上一版本的代码保持兼容，使衍生项目可以按版本逐个采纳并安全部署。

## Requirements

### Requirement: 模板版本号与发布 tag
模板 SHALL 使用 SemVer `MAJOR.MINOR.PATCH` 版本号，以 annotated tag `template-v<版本号>` 发布。被打 tag 的提交 MUST 在 main 历史上，且已通过 CI、成功发布到 staging。模板版本 MUST NOT 使用 `v*` tag，`v*` 保留给模板自身演示站和衍生项目的生产发布。版本号 SHALL 只以 tag 为准，不写入任何 `package.json`。

#### Scenario: 推送模板版本 tag
- **WHEN** 协调者对一个 CI 与 staging 发布均成功的 main 提交推送 `template-v0.3.0`
- **THEN** 发布流水线创建 GitHub Release，不触发生产部署，也不获取任何部署凭据

#### Scenario: tag 指向未验证的提交
- **WHEN** `template-v*` tag 指向不在 main 上、或没有成功 staging 发布的提交
- **THEN** 发布流水线失败，不创建 GitHub Release

### Requirement: 版本级别
版本级别 SHALL 按衍生项目是否需要手动动作来决定。以下变更属于不兼容变更：
- 需要衍生项目手动修改配置或代码；
- 新增必填的密钥、环境变量或部署绑定；
- 删除或重命名已有能力、配置项、表或列；
- 包含收缩（contract）类迁移。

1.0 之前，不兼容变更 MUST 提升 MINOR，其它变更提升 PATCH。1.0 之后，不兼容变更 MUST 提升 MAJOR，新功能提升 MINOR，纯修复提升 PATCH。发版没有固定周期，SHALL 由协调者按需发布；安全修复 SHOULD 尽快以 PATCH 发布。

#### Scenario: 新增必填密钥
- **WHEN** 一个 0.x 版本新增了衍生项目必须配置的 secret
- **THEN** 该版本提升 MINOR，升级说明标记为不兼容并在「必须执行的动作」中列出该 secret 名称

### Requirement: 每个版本的升级说明
每个模板版本 SHALL 附带 `docs/upgrades/<版本号>.md`，说明从上一个模板版本升级到本版本的变化；跨多个版本升级时，按版本顺序依次阅读。说明 MUST 包含 frontmatter：`version`、`previous`、`date`、`breaking`，可选 `requiresDeployed`。正文 MUST 包含以下固定章节，没有内容的章节写「无」：
- 概要；
- 必须执行的动作：按顺序列出，每条注明适用条件，例如部署目标或功能开关；
- 配置变更：`template.config.ts`、部署绑定、环境变量与密钥名称、运行时设置；
- 数据库变更；
- 部署顺序；
- 验证；
- 回滚；
- 已知问题。

`docs/upgrades/README.md` SHALL 按版本倒序列出全部版本、日期、级别与是否不兼容。升级说明 MUST NOT 包含密钥值、个人邮箱或生产资源 ID。

#### Scenario: 跨两个版本升级
- **WHEN** 衍生项目从 0.2.0 升级到 0.4.0
- **THEN** 依次阅读 `0.3.0.md` 与 `0.4.0.md` 即可得到全部必须执行的动作与数据库变更

### Requirement: 数据库变更说明
升级说明的「数据库变更」章节 MUST 逐个列出本版本新增的每个模板迁移，每个迁移写明：
- tag 与内容摘要；
- 类别：扩展（expand）、收缩（contract）或数据迁移；
- 是否与上一版本的代码兼容；
- 预计的锁表与耗时风险；
- 回滚方式。

迁移清单 MUST 与版本区间内实际新增的迁移文件一致。

#### Scenario: 遗漏迁移
- **WHEN** 版本区间新增了 `0019_x`，但升级说明没有列出它
- **THEN** 发版校验失败，不能发布该版本

### Requirement: 迁移与上一版本代码兼容
因为部署先执行迁移、再部署新代码，回滚时只回退代码，所以每个模板版本的迁移 MUST 与上一版本的代码兼容：
- 扩展类迁移可以直接发布，例如新建表、新增可空或带默认值的列、新建索引。
- 删除、重命名、修改列类型、新增非空约束等收缩类变更 MUST 拆成两个版本：前一版本停止使用旧结构并完成扩展，后一版本或更晚的版本再执行收缩。收缩版本的升级说明 MUST 用 `requiresDeployed` 声明必须先部署的版本。
- 数据迁移 MUST 可重复执行；大表回填 SHOULD 交给后台任务完成。
- 新增迁移中的收缩类语句 MUST 带 `-- template-contract:` 注释，说明理由与依赖的版本。没有该注释时，CI MUST 失败。

#### Scenario: 删除一列
- **WHEN** 模板要删除一张表中仍被上一版本代码读取的列
- **THEN** 当前版本只移除代码中的使用，删除该列的迁移在之后的版本中发布，其升级说明声明 `requiresDeployed` 为前一版本

#### Scenario: 未标注的收缩语句
- **WHEN** 一个 PR 新增的迁移包含 `DROP COLUMN` 但没有 `-- template-contract:` 注释
- **THEN** CI 失败并指出该迁移与语句

### Requirement: 发版草稿与校验
模板 SHALL 提供发版工具，用来起草和校验升级说明：
- **草稿**：从上一个 `template-v*` tag 到当前提交，列出提交、新增迁移及其语句分类、配置与部署绑定差异、环境变量与密钥名称差异、依赖主版本变化，并给出建议的版本级别。
- **校验**：检查 frontmatter 与 tag 区间一致、迁移清单完整、收缩迁移都有兼容说明与 `requiresDeployed`、不兼容变更的版本级别正确，并检查版本索引已更新。

发布流水线 MUST 先通过校验，再创建 GitHub Release；GitHub Release 的正文取自该版本的升级说明。

#### Scenario: 起草首个版本
- **WHEN** 仓库中还没有任何 `template-v*` tag
- **THEN** 草稿以最后一次演示站生产发布 `v0.1.3` 为起点

# project-bootstrap Specification

## Purpose

把模板复制成一个新项目时，自动完成改名与配置生成，并给出需要手动创建的基础设施与密钥清单，减少遗漏。

## Requirements

### Requirement: 生成新项目
创建脚本 SHALL 根据输入的项目名称、域名、默认语言与功能开关，生成改名后的项目副本：包名、Worker 名、模板配置与站点文案中的品牌占位符都被替换；生成的项目 SHALL 能直接通过类型检查与单元测试。

#### Scenario: 创建新项目
- **WHEN** 运行脚本并输入名称 `acme`、域名 `acme.example`
- **THEN** 生成的项目中不再出现模板原名称，`pnpm typecheck` 与 `pnpm test` 通过

### Requirement: 基础设施与密钥清单
脚本 SHALL 根据所选功能输出需要创建的 Cloudflare 资源、外部服务账号与密钥列表，并为本地开发生成根目录 `.env.example` 与 app 认证用 `.dev.vars.example`；这些模板 SHALL 只包含键名、占位符或非敏感默认值，不包含模板仓库本地配置的真实值。

#### Scenario: 关闭视频功能
- **WHEN** 创建时关闭图片与视频功能
- **THEN** 输出的清单中不包含媒体服务商密钥与 Workflow 相关资源

### Requirement: 不复制敏感与运行时数据
生成的项目 MUST NOT 包含模板仓库中的密钥、根目录或任意子目录的 `.env.local`、`.env.worktree`、`.dev.vars` 真值文件、git 历史或 OpenSpec 的进行中变更；配置模板 MUST NOT 从这些本地真值文件生成。

#### Scenario: 模板含本地真值与 worktree 配置
- **WHEN** 模板根目录或子目录中存在 `.env.local`、`.env.worktree` 或 `.dev.vars`
- **THEN** 生成的项目中没有这些文件及其真值，生成的根目录 `.env.example` 与 app `.dev.vars.example` 只包含键名、占位符或非敏感默认值

### Requirement: 显式部署目标与输出路径
create-project SHALL 接受 `--target cloudflare|selfhost`，省略时默认 Cloudflare；输出目录 SHALL 使用 `--output`。旧 `--target <path>` MUST 明确提示迁移，非法目标 MUST 拒绝，现有防覆盖与源树边界保护 MUST 保留。（P5）

#### Scenario: 生成自托管项目
- **WHEN** 使用 `--target selfhost --output <new-directory>` 和合法项目参数
- **THEN** 生成自身 namespace 的镜像发布配置、Compose、部署/初始化/恢复材料及启用功能对应的无真值清单

#### Scenario: 旧路径参数或非法目标
- **WHEN** 使用旧 `--target ../acme` 或不存在的目标名
- **THEN** 不创建项目，明确提示支持的部署目标与 `--output` 用法

#### Scenario: 默认 Cloudflare
- **WHEN** 不传 target
- **THEN** 默认生成 Cloudflare 项目，原有测试、构建和 staging 路径保持可用

### Requirement: 自托管功能裁剪可运行
生成器 SHALL 支持关闭 billing、credits、营销和 i18n，自托管产物 SHALL 仍能构建运行。不启用的模块 MUST 不要求其密钥/seed 或注册对应入口/后台任务；认证、空间、邮件与成功 heartbeat SHALL 仍可用。启用功能的既有业务语义 MUST 保留。（P5）

#### Scenario: 团队工具全关组合
- **WHEN** 创建 selfhost 项目并关闭 billing、credits、营销和 i18n
- **THEN** Node 构建和容器启动通过，可登录进入空间、使用所选单语言应用入口，health 为正确 SHA，不依赖支付或积分 seed

#### Scenario: 生成副本再次创建项目
- **WHEN** 使用已生成的 selfhost 副本作为源创建另一项目
- **THEN** 新品牌、namespace、目标及功能配置正确，前一个项目的配置真值不进入新项目

### Requirement: 自托管运行文件排除
生成项目 MUST 排除源树的 selfhost secret/证书目录、无扩展名密码、私钥、备份、ownership 及运行 release 状态，不读取这些真值来生成模板。无真值 example 和运维脚本 SHALL 保留。

#### Scenario: 已初始化源项目
- **WHEN** 源项目有 `secrets/auth_secret`、数据库密码文件、证书、owner 记录与备份文件
- **THEN** 这些文件及真值均不出现在新项目，`.env.example`、`secrets.example` 与交付脚本仍存在

### Requirement: 记录模板基准
生成的项目 SHALL 在根目录包含 `.template-base.json`，记录：
- 模板仓库地址与生成所用的完整提交 SHA；
- 该提交恰好是模板发布版本时的版本号，否则为空；
- 规范化后的全部生成参数（含默认值）；
- 已包含的模板迁移清单。

模板工作区有未提交改动时，记录 MUST 标明来源不干净。记录 MUST NOT 包含密钥、本地路径、主机名或个人邮箱。

#### Scenario: 从干净提交生成
- **WHEN** 在没有未提交改动的模板上生成 `acme`
- **THEN** 副本的 `.template-base.json` 含该提交 SHA、全部参数和当前模板迁移清单，不含输出目录的绝对路径

#### Scenario: 从有改动的工作区生成
- **WHEN** 模板工作区存在未提交改动时生成项目
- **THEN** 基准记录标明来源不干净，同步工具不把它当作可信基准

### Requirement: 生成结果确定
对同一模板源和同一组参数，生成器 SHALL 产出逐字节相同的文件集合，包括文件内容、路径和权限位。生成结果 MUST NOT 依赖生成时间、随机值、输出目录、执行机器或环境变量。

#### Scenario: 两次生成对比
- **WHEN** 用同一提交和同一参数分别生成到两个不同目录
- **THEN** 两份副本的文件列表、内容和权限完全一致

### Requirement: 分析站点注入
生成器 SHALL 接受 `--analytics plausible|off`（默认 `plausible`）、`--plausible-domain`（默认项目名）与 `--plausible-host`。生产 site MUST 为该值，staging MUST 加 `-staging` 后缀。清单 MUST 写明 site、目标、自定义属性的开通步骤和开关方式。

#### Scenario: 新词站默认
- **WHEN** 以 `--name acme --plausible-host https://p.example` 生成
- **THEN** 生产 site 为 `acme`，staging 为 `acme-staging`

#### Scenario: 长期词站关闭
- **WHEN** 以 `--analytics off` 生成
- **THEN** `features.analytics` 为 `false`，环境变量为空，清单不含 Plausible 步骤

### Requirement: staging 地址不沿用生产域名
生成器 MUST NOT 把生产域名写入 staging 的 APP_URL，默认 SHALL 写入 `https://staging.<域名>` 并由清单提示替换。

#### Scenario: 生成后的 staging 地址
- **WHEN** 以 `--domain acme.example` 生成
- **THEN** staging 的 APP_URL 为 `https://staging.acme.example`，生产为 `https://acme.example`

### Requirement: 搜索站长验证清单
`PROJECT_SETUP.md` SHALL 写明 Google Search Console 与 Bing Webmaster 的站点验证和提交 sitemap 步骤，以及发布前替换法律页模板声明与支持邮箱的提示。

#### Scenario: 读取清单
- **WHEN** 打开生成的 `PROJECT_SETUP.md`
- **THEN** 其中包含这两个平台的步骤和本站 sitemap 地址

### Requirement: 可选答案页
生成器 SHALL 接受 `--features guides` 开启答案页，默认关闭；开启时副本 MUST 包含可修改的示例页。

#### Scenario: 开启答案页
- **WHEN** 以 `--features blog,guides` 生成
- **THEN** `features.guides` 为 `true`，副本含示例内容

### Requirement: 主题预设选择
生成器 SHALL 接受 `--theme <预设名>`，省略时使用中性基线；非法预设名 MUST 被拒绝并列出可用预设。所选预设 SHALL 写入生成项目的模板配置与基准记录参数，生成项目 SHALL 包含项目自有的品牌 token 文件，供后续调整品牌而不修改基线 token。

#### Scenario: 指定主题预设
- **WHEN** 使用者以 `--theme blue` 生成项目
- **THEN** 生成项目的模板配置选择 blue 预设，`.template-base.json` 记录该参数，项目包含品牌 token 文件且能通过类型检查与单元测试

#### Scenario: 非法预设
- **WHEN** 使用者传入不存在的预设名
- **THEN** 生成器退出并列出可用预设，不写入输出目录

### Requirement: 衍生项目的端到端检查按项目配置运行
模板提供的端到端用例与 Nightly 任务 SHALL 按项目的模板配置、运行时绑定与页面声明决定运行或跳过，MUST NOT 只在模板默认配置下成立；跳过时 SHALL 给出原因。
用例结果 MUST NOT 依赖执行顺序：共享状态（价格目录缓存、夹具套餐）SHALL 在全局准备阶段写入或在用例结束时还原。

#### Scenario: 项目关闭了某项功能
- **WHEN** 衍生项目关闭注册赠送积分、答案页或 Workers AI 媒体服务商
- **THEN** 对应用例跳过并在报告中写明原因，其余用例照常运行

#### Scenario: 项目没有浮动控件
- **WHEN** 页面未声明浮动语言与主题控件
- **THEN** 浮动控件用例跳过

#### Scenario: 用例顺序变化
- **WHEN** 首个访问定价页的用例先于其他用例运行
- **THEN** 定价页读到完整的价格目录，后续用例不受影响

#### Scenario: 多租户关闭的衍生项目跑 Nightly
- **WHEN** 衍生项目未开启 `multiTenant`
- **THEN** Nightly 的多空间任务跳过并说明原因；模板仓库中照常运行

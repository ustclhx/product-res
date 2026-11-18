---
name: template-sync
description: 在由本模板生成的衍生项目中采纳模板更新：只读预检基准、版本区间与升级说明，在本地同步分支上三方合并、移植模板迁移并验证；推送、开 PR、线上迁移与外部配置前先列动作清单并确认。
---

# 采纳模板更新

在衍生项目根执行（含 `.template-base.json` 与 `template.config.ts`）。技能接受 `--to <template-v版本|分支|SHA>`，
默认取最新的 `template-v*` 发布；这是技能输入，不是新 shell CLI。第 1 节克隆目标模板后，完整阅读
克隆中的 `$TEMPLATE_DIR/docs/create-project.md`「采纳模板更新」与 `$TEMPLATE_DIR/docs/upgrades/README.md`；
迁移约定见 `$TEMPLATE_DIR/docs/02-project-structure.md` §4。项目里的同名文档停留在基准版本，不以它为准。
同步脚本同样始终取自**目标版本**的模板克隆，不运行项目里的旧副本。

## 1. 只读预检

1. 工作区：`git status --porcelain --untracked-files=all` 必须为空；记录当前分支与完整 SHA。有改动时停止，
   请使用者先提交或清理，不代为 stash 或丢弃。
2. 基准：读取 `.template-base.json`。文件不存在、校验失败或 `clean=false` 时转到第 6 节「基准推断」。
3. 克隆目标模板到临时目录，用该克隆查版本区间（不修改项目）：

```sh
TEMPLATE_DIR=$(mktemp -d)
git clone --filter=blob:none <repository> "$TEMPLATE_DIR"
git -C "$TEMPLATE_DIR" tag --list 'template-v*' --sort=-v:refname | head
git -C "$TEMPLATE_DIR" log --oneline <基准 commit>..<目标>
```

4. 升级说明：区间内每个版本读目标树的 `docs/upgrades/<版本>.md`，整理：
   - 按基准 `params` 过滤后的「必须执行的动作」，标明哪些涉及外部系统（新 secret、部署绑定或资源、
     GitHub variables/environment、线上迁移）；
   - `requiresDeployed` 边界：边界版本未在线上部署时，本次目标改为边界版本；
   - 「数据库变更」中的迁移、类别与锁表风险；项目若删除过模板迁移依赖的表，列出需要 `--skip-migration` 的 tag。
5. 输出预检报告：基准与目标（版本或 SHA）、提交数、待办动作、边界、待移植与拟跳过的迁移。
   默认停在这里，等使用者确认目标与跳过清单。

## 2. 在本地分支同步

使用者确认后执行；工具只在新分支 `template-sync/<目标短 SHA>` 上提交，不推送、不合并：

```sh
node "$TEMPLATE_DIR/scripts/template-sync.mjs" sync --project . --to <目标> \
  [--skip-migration <tag>]... [--confirm-deployed <版本>]... [--verify-db <空的隔离库 URL>] \
  [--trailer "Co-Authored-By: …"]...
```

- 项目约定提交尾注（如 `Co-Authored-By`）时用 `--trailer` 传入，两个同步提交都会带上，不必事后 amend。

- `--verify-db` 只能指向使用者提供的空的隔离库，绝不使用 staging/production 或开发主库。
  未提供时报告中数据库验证为跳过，需在交付中说明。
- `--confirm-deployed` 只在使用者核实线上健康接口返回的版本后才加；不得凭推测越过边界。
- 退出码：0 为已是最新或同步完成；1 为冲突或验证失败；2 为预检失败（未改动项目）。

## 3. 读报告与处理冲突

报告路径打印在终端（`<git 目录>/template-sync/<短 SHA>.md`）。逐项核对：已应用变更、冲突文件、模板已删除的保留文件、
`PROJECT_SETUP.md` 变化、锁文件版本变化、移植与跳过的迁移、升级说明待办与迁移核对告警、验证结果。

冲突逐个处理：先比较模板侧（`git diff refs/template-sync/base refs/template-sync/target -- <文件>`）
与项目侧改动，向使用者说明取舍后再改；不得整体采用任一方，不得删除冲突文件了事。
报告「模板已删除、项目中保留的文件」不会被自动删除：逐个检查项目是否仍引用，列出拟删清单，
经使用者确认后再 `git rm` 并提交；验证因这些文件失败时，提交后按下文重跑。全部解决并提交后，在同步分支上用相同参数重跑第 2 节，
工具会跳过文件合并、继续迁移移植与验证。`PROJECT_SETUP.md` 的新增清单项按需手动吸收。

## 4. 迁移核对与验证

- 移植的模板迁移在 `packages/db/migrations` 末尾，文件名带 `tpl_`；核对其在项目自有迁移之后、
  journal `when` 递增，且报告中 `drizzle-kit generate` 无变化。
- 验证失败时修复并提交后重跑；基准记录只在无冲突且验证全部通过时更新到目标。
- 升级说明里的数据库风险（锁表、全表更新、不可逆数据迁移）写入交付说明，供上线时安排窗口与备份。

## 5. UI 截图对比（同步涉及 `packages/ui` 或基线 token 时）

先判断本次区间是否改动共享组件或基线 token：

```sh
git diff --stat refs/template-sync/base refs/template-sync/target -- packages/ui apps/web/src/styles
```

有输出时，合并前做截图对比，结果写入同步报告：

1. 列出页面：组件预览页 `/dev/ui`（staging 需开启 `UI_PREVIEW`）与项目关键页（首页、定价、登录、app 主页、
   项目视觉规范中列出的页面）。`/dev/ui` 返回 404（模板版本尚无预览页或未开启）时跳过该页，报告中记为未验收。
2. 基线截图取项目 staging（当前版本）；对比截图取同步分支：本地启动 web（`pnpm dev`），或使用者确认后部署到 staging 预览环境。
   每页在 390 与 1440 宽、浅色与深色下截图，写入 `EVIDENCE_DIR`（未设置时用已忽略的 `test-results/evidence/`）：

```sh
WEB_PACKAGE=$(node -p "JSON.parse(require('fs').readFileSync('apps/web/package.json','utf8')).name")
OUT=${EVIDENCE_DIR:-$PWD/test-results/evidence}/template-sync && mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=390,844 --full-page --color-scheme=dark "<页面地址>" "$OUT/<页面>-390-dark.png"
```

3. 核对项目复制过的模板组件：列出本次区间内变化的模板组件，与 `docs/design/forks.md` 登记的来源文件取交集，
   逐个列入报告，并对照上游改动手动合并到 `packages/ui/src/project/` 中的副本：

```sh
git diff --name-only refs/template-sync/base refs/template-sync/target -- packages/ui/src/components
test -f docs/design/forks.md && cat docs/design/forks.md
```

4. 逐页对照项目视觉规范（`docs/design/visual-system.md` 与 `docs/design/prototypes/` 中的副本）。偏差在项目层修正：
   品牌 token 写入 `apps/web/src/styles/brand.css`，结构差异写进 `packages/ui/src/project/` 的包装或副本；
   **不修改模板组件与基线 token**。修正提交到同步分支后重跑第 2 节。
5. 报告列出每页差异、forks 交集与处理方式、修正方式、仍待使用者确认的视觉变化；未能截图的页面记为未验收。

## 6. 基准推断（无记录或记录不可信）

```sh
node "$TEMPLATE_DIR/scripts/template-sync.mjs" infer-base --project . [--since YYYY-MM-DD --until YYYY-MM-DD] [--param key=value]...
```

展示还原的参数（及来源）、前 5 个候选、最佳候选的差异摘要；超过阈值时不写入。使用者选定后
`--write <sha>` 写入 `.template-base.json`，审阅并由使用者确认后再提交，然后回到第 1 节。

## 7. 交付与授权边界

完成条件：同步分支无冲突、验证全部通过、基准记录指向目标；报告与待办清单交给使用者。
以下动作必须先列出具体清单并获得明确确认，确认范围变化需再次确认：推送同步分支、开 PR、合并；
任何环境的数据库迁移；升级说明中的外部动作（创建队列等资源、写 secret、GitHub variables/environment）。
secret 只列名称与配置位置，不读取、不输出、不写入其值；报告中的邮箱与本机路径不进入公开 PR。
外部动作可交给 `deploy-cloudflare` 或 `deploy-selfhost` 技能按其流程执行。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| 预检报基准 clean=false 或缺失 | 运行第 6 节基准推断 |
| 旧生成器拒绝参数 | 基准过旧或参数被手改；核对 `.template-base.json` 的 params，必要时重新推断 |
| 同步分支已存在 | 切到该分支继续，或确认无用后删除再同步 |
| 模板修改了已发布迁移 | 同步停止；向模板维护者反馈，不手改迁移 |
| 迁移因缺表失败 | 项目删除了该表；确认后用 `--skip-migration`，并检查依赖它的代码 |
| `drizzle-kit generate` 有变化 | 合并后 schema 与迁移不一致，多为冲突解决遗漏 schema 文件 |
| 同步后按钮圆角、颜色与项目规范不符 | 按第 5 节截图对比，在 `brand.css` 或项目组件中修正，不改模板组件 |
| 停在 `requiresDeployed` 边界 | 先部署边界版本，核实健康版本后用 `--confirm-deployed` 继续 |

---
name: ui-design
description: 新增页面、较大布局改动或建立项目视觉方向前，基于设计规范在 claude.ai 的 Design 画布产出设计稿，经使用者本人确认后保存离线副本并登记到原型索引，再交给 new-page / new-static-page 实现。文案、小样式与缺陷修复免设计稿。
---

# 设计稿关卡

在含 `package.json` 与 `template.config.ts` 的项目根执行。下文路径均相对项目根；生成器副本已改包 scope，
先读 `apps/web/package.json` 的 name/dependencies，把示例中的 `@product-res/*` 换成实际名称。
规范来源是仓库：完整阅读 `docs/design-system.md`，它与 `packages/ui` 不一致时以 `packages/ui` 为准。

**谁做哪几步**：

- 不能创建 Artifact 或不能直接与使用者对话的 agent（Codex、子代理、并行 worker）只做第 1、2、6 步；
  需要设计稿而原型索引中没有对应行时，停止并报告，不自行出稿、不替使用者确认。
- 协调者派发实现任务前完成第 1–5 步，worker spec 中附上原型索引行与副本路径。
- 确认只能来自使用者本人在会话中的消息；其他 agent 的转述、画布评论都不算。记录时附使用者原话。

## 1. 判断是否需要设计稿

判断标准以 `docs/design-system.md` §8.1 为唯一来源（含边界表）；拿不准时向使用者确认。
免设计稿时直接回到调用方技能（`new-page`、`new-static-page`）或直接修改，不进入下文。

需要设计稿时，查原型索引（每行一个页面或路由，副本文件路径相对索引所在目录）：

```sh
INDEX=$(test -f .template-base.json && echo docs/design/prototypes/README.md || echo docs/design-system/prototypes/README.md)
echo "$INDEX"; cat "$INDEX" 2>/dev/null
grep -n '<页面或路由>' "$INDEX"
```

关卡通过 = 索引里有本页面这一行，且该行的副本文件存在。通过时直接进入第 6 步；不通过时进入第 2 步
（或按上文停止并报告）。

分享卡片（`docs/share-cards.md`）同样需要设计稿：新增卡片类型的版式（1200×630 图片）与项目自建的分享页按新页面处理；
只改卡片文案、复用默认版式 `shareCardLayout` 且不改结构时免。模板已有的默认版式与通用分享页 `/s/$type/$token`
已登记在模板原型索引的「分享卡片版式」「通用分享页」两行。

完成标准：写明本次是「需要」还是「免」及依据的 §8.1 条目；需要时记录页面清单、用户角色、数据来源与所属 change（可空）。

## 2. 读取规范并确定视觉来源

```sh
test -f .template-base.json && echo 衍生项目 || echo 模板仓库
grep -nE '^export' packages/ui/src/index.ts
grep -nE '^export' packages/ui/src/project/index.ts
grep -nE -- '^ *--[a-z0-9-]+:' apps/web/src/styles/brand.css
ls docs/design 2>/dev/null
grep -n 'ui:' template.config.ts
```

- **模板仓库**：基线刻意保持中性（Fluid 默认视觉 + `ui.preset`），**不向使用者索取视觉参考**，设计稿只用现有 token 与组件。
  规范只读仓库（`docs/design-system.md` §1）；Design System 镜像是按账号私有的可选缓存，打不开时不申请共享，
  需要对照时在当前账号按仓库重建（见该节），落后时以仓库 token 为准。
- **衍生项目，已有视觉方向**（`docs/design/visual-system.md` 存在、`brand.css` 有覆盖）：以它与 `brand.css` 为准（项目镜像同为可选缓存），
  不索取参考。
- **衍生项目，尚无视觉方向，或本次要改变方向**：先执行第 3 步。

完成标准：列出本次可用的组件、token 来源（基线 / 预设 / 品牌）与视觉方向文件；缺少的组件记为待补，不在页面里临时写。

## 3. 衍生项目建立视觉方向（仅需要时）

1. **索取参考**：请使用者提供 1–3 个参考网站或截图，并说明想借鉴的方面（配色、字体气质、密度、圆角、插画）。
   没有参考时停止本步，继续用模板基线，不自行发明配色。
2. **提出方向**：在模板基线上只改品牌层可覆盖的变量（`--primary`、`--fluid-accent`、`--focus-ring`、`--radius`、表面与文字色等），
   用 claude.ai 的 Design System Artifact 发布项目镜像（Claude Code 中 Artifact 工具 `action: quickstart`、`intent: other`，
   按返回结果从 Design System 类型创建），内容包括浅 / 深色板、字号阶梯、按钮 / 输入 / 卡片样例。
3. **多站点**：一个项目多个站点时，每个站点给出一组覆盖，写成 `:root[data-site="<站点>"]` 与
   `:root[data-site="<站点>"].dark`。`data-site` 由项目自有的 `apps/web/src/features/theme/html-attributes.ts` 返回，不修改模板根布局。
4. **对比度**：正文与背景 ≥ 4.5:1；焦点环与背景、与主按钮 ≥ 3:1；浅色与深色都要满足。
5. **使用者确认后写入项目自有文件**：
   - `apps/web/src/styles/brand.css`：只写变量，浅色与 `.dark` 成对，`.dark` 规则在 `:root` 之后；
   - `docs/design/visual-system.md`（目录用途见生成器创建的 `docs/design/README.md`）：参考来源（链接或截图文件）、借鉴点、变量取值、多站点表（镜像链接不写入，镜像只是个人缓存）；
   - 参考截图放 `docs/design/references/`。
   不修改 `packages/ui/src/styles/` 与 `packages/ui/src/components/`（模板拥有）。

完成标准：使用者确认视觉方向并记录原话；`pnpm check:ui` 通过；brand.css 与视觉规范文档已提交到项目分支。

## 4. 产出设计稿

用 claude.ai 的 **Design** Artifact 类型产出画布（Claude Code 中 Artifact 工具 `action: quickstart`、`intent: design`，
按返回的类型说明创建）。

- **状态矩阵**：正常态做桌面（1440）/ 移动（390）× 浅色 / 深色 4 块；空、加载、错误各 1 块（移动 + 浅色）。
  画布支持 tweak 切换时可用切换代替单独画板。不适用的状态（如纯静态页没有加载态）在画布中写明原因。
- **套用现有页面模式的新页面**同样需要画布稿，可只画正常态与一个异常态。
- **只用规范内的元素**：颜色、圆角、字号、阴影取第 2 步确定的 token；组件取 `@product-res/ui` 与 `@product-res/ui/project` 已有组件。
- **规范外需求**：需要新颜色、新字号或新组件时，在画布旁单列「token / 组件变更提议」，等使用者确认；
  模板 token 变更进模板基线，项目 token 变更进 `brand.css`，都不写死在页面里。
- **示例数据**：用中性领域的示例数据，不放真实用户信息与密钥。
- **分享卡片版式**：画布按 1200×630 出图，至少包括中文标题、英文标题、超长标题（截断加省略号）各一张，浅色为准；
  只用 `ShareCardTheme` 提供的颜色、圆角与字号（与 `packages/ui/src/share-card-theme.ts` 对应），布局限于 flex，
  不用远程图片、图表与 emoji；含中文的标题只有常规体（400），层级靠字号区分。项目品牌色写入
  `share-cards.theme.ts` 并与 `brand.css` 对应。验收用 `/dev/ui` 或卡片地址的 PNG 与副本对照，而不是第 6 步的页面截图。

完成标准：画布链接可打开，矩阵完整，变更提议单列。

## 5. 请使用者确认并登记

把画布链接发给使用者，请其查看后在会话中答复；按意见修改后再次请求确认。只有使用者本人在会话中明确表示确认才算通过，
画布评论、沉默、只提意见都不算。确认后画布再改动，须重新确认并同步更新副本与索引。

1. **保存副本**：先用 Artifact 工具 `action: list`、`scope: "files"` 列出画布文件，再用 `action: read` 的 `paths`
   一次取回 `project/` 下的全部 `*.dc.html` 与 `project/canvas.json`，原样复制到副本目录下以画布命名的子目录，
   每个页面的索引行指向对应画板文件。画板源码依赖画布运行时，不能断网渲染，但包含布局、token、文案与状态分支，
   实现与验收按源码对照；需要图片时请使用者从画布导出 PNG 放在同目录。
   - 衍生项目：`docs/design/prototypes/<画布>/<画板>.dc.html`
   - 模板仓库：`docs/design-system/prototypes/<画布>/<画板>.dc.html`
2. **登记原型索引**（衍生项目 `docs/design/prototypes/README.md`，模板 `docs/design-system/prototypes/README.md`；
   不存在时按下表创建），每个页面一行，无 OpenSpec change 的小任务也登记：

```md
| 页面 / 路由 | 画布链接 | 确认日期 | 使用者确认原话 | 副本文件 | 所属 change |
|---|---|---|---|---|---|
| /app/$slug/reports | <画布链接> | YYYY-MM-DD | 「<原话>」 | reports.html | add-reports |
```

3. **OpenSpec**：有所属 change 时，在其 `design.md` 引用索引行（索引路径与页面名），不重复写链接与原话；
   已确认的 token / 组件变更提议写入该 design.md。

完成标准：副本文件与索引行已提交；后续实现与验收以副本为准，链接失效不影响开发。

## 6. 实现交接

回到调用方技能（`new-page`、`new-static-page`、`new-module`）实现，约束如下：

- 只从 `@product-res/ui` 与 `@product-res/ui/project` 导入组件；不直接导入 `radix-ui`、`motion`、`lucide-react`。
- 缺组件先补组件：模板仓库在 `packages/ui/src/components` 按 `packages/ui/UPSTREAM.md` 接入；
  衍生项目在 `packages/ui/src/project/` 新增并从 `packages/ui/src/project/index.ts` 导出，页面经 `@product-res/ui/project` 使用。项目需要修改模板组件时，
  按 `docs/design-system.md` §9.2 的顺序处理（token → ui 配置 → project 包装 → 复制到 project 并在 forks 登记）。
- 不写死颜色、任意值尺寸、原生 `<select>`、`confirm()` / `alert()`；组件默认英文文案由应用层传入 `m.*()`。
- 设计稿中的各状态都要实现；在 390px 宽无横向滚动，浅色与深色与副本一致。

验收（`<页面地址>` 换成实际路由；`EVIDENCE_DIR` 未设置时用已忽略的 `test-results/evidence/`）：

```sh
WEB_PACKAGE=$(node -p "JSON.parse(require('fs').readFileSync('apps/web/package.json','utf8')).name")
pnpm check
pnpm check:deps
pnpm typecheck
OUT=${EVIDENCE_DIR:-$PWD/test-results/evidence}/ui-design && mkdir -p "$OUT" && OUT=$(cd "$OUT" && pwd)
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=390,844 --full-page "<页面地址>" "$OUT/mobile-light.png"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=390,844 --full-page --color-scheme=dark "<页面地址>" "$OUT/mobile-dark.png"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=1440,900 --full-page "<页面地址>" "$OUT/desktop-light.png"
pnpm --filter "$WEB_PACKAGE" exec playwright screenshot --viewport-size=1440,900 --full-page --color-scheme=dark "<页面地址>" "$OUT/desktop-dark.png"
```

截图与副本逐画板对照，差异逐项修正或记录为使用者确认过的偏离。需要登录的页面用 e2e 夹具或
`--load-storage` 加载会话；缺少条件时在交付中记为未验收。

## 常见故障

| 现象 | 处理 |
|---|---|
| 无法创建或打开 Design Artifact | 当前 agent 不支持时停止并报告，由协调者完成第 3–5 步；链接失效或属于其他账号时读取仓库副本继续，不申请共享 |
| 原型索引没有本页面 | 需要设计稿：回到第 2 步；worker 停止并报告 |
| 设计稿需要规范外颜色或字体 | 回到第 4 步单列变更提议，确认后改 token，不在页面写死 |
| `pnpm check:ui` 报颜色字面量或任意值 | 改用 token 工具类；确需例外（插画、第三方品牌图标）时在项目的 `scripts/check-ui.allow.local.json` 逐文件登记原因 |
| `pnpm check:deps` 报页面导入了 `radix-ui` / `motion` | 把交互封装进 `packages/ui`（模板）或 `packages/ui/src/project/`（项目）后经导出入口使用 |
| 深色下文字看不清 | brand.css 只覆盖了 `:root`；在 `.dark` 中补齐对应变量并重新核对对比度 |
| 模板组件指纹校验失败 | 衍生项目：改了模板组件，还原后按 `docs/design-system.md` §9.2 的定制顺序处理；模板仓库：改组件后运行 `pnpm ui:lock` 并提交 `packages/ui/components.lock.json` |
| 截图全白或停在登录页 | 页面需要会话或数据；用 e2e 夹具登录、本地数据库种子数据后重截 |

交付：判断结论、视觉方向文件（如有）、画布链接、副本与索引行、变更提议与使用者原话、截图对照结果、未验收项。
维护本技能时复制 `.agents/skills/ui-design/SKILL.md` 到 `.claude/skills/ui-design/SKILL.md`，用 `cmp` 保证字节一致。

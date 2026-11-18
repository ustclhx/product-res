# 项目设计记录

此目录归项目所有。模板设计规范见 `docs/design-system.md`。

- `visual-system.md`：项目视觉方向、品牌 token 与多站点规则。
- `references/`：采用的参考网站说明、截图与素材来源。
- `prototypes/`：经使用者确认、可离线打开的设计稿副本；`prototypes/README.md` 为原型索引，每页一行（页面/路由、画布链接、确认日期、使用者确认原话、副本文件、所属 change），需求的 OpenSpec 设计文档只引用索引行。流程见 `ui-design` 技能与 `docs/design-system.md` §8.2。
- `forks.md`：复制到 `packages/ui/src/project/` 的模板组件、来源版本与定制原因。

品牌 token 写入 `apps/web/src/styles/brand.css`，项目组件经 `@product-res/ui/project` 导出；复制的模板组件仍受 UI 规范检查；如需保留上游的 `arbitrary-class`、颜色字面量等写法，须在 `scripts/check-ui.allow.local.json` 按文件登记所需规则与原因，不能只登记 `forks.md`。

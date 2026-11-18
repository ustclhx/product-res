# 设计规范

模板与衍生项目的 UI 分层、设计 token、组件用法、动效、页面模式与设计关卡。规范以仓库为准：
token 在 `packages/ui/src/styles/`，组件在 `packages/ui/src/components/`，本文说明如何使用它们。
claude.ai 的 Design System Artifact 只是可选的可视化镜像，属于某个账号的私有缓存，不是规范来源，二者不一致时以仓库为准。

决策来源：OpenSpec change `add-ui-design-system`（design D1–D11）。组件来源与上游月份见
[`packages/ui/UPSTREAM.md`](../packages/ui/UPSTREAM.md)。

## 1. 规范来源与镜像

**唯一规范来源是本仓库**：`packages/ui`（token 与组件）、本文、原型副本（`docs/design-system/prototypes/`）。
claude.ai 的 Artifact（Design System 镜像、Design 画布）都是私有、按账号归属的，换账号或换开发者就看不到；
因此任何开发、评审与验收都不得依赖 Artifact 链接，只读仓库。

镜像是可选的个人缓存，供出设计稿时在 claude.ai 里对照：

- 打不开（换了账号、新开发者、链接失效）时，**不申请共享**，在当前账号用 Design System Artifact 类型按仓库重建一份
  （来源：`packages/ui/src/styles/` 的 token、`packages/ui/src/index.ts` 与 `chat.ts` 的公开组件、本文的用法与对比度说明）。
  重建的镜像只给自己用，链接不写回仓库。
- 镜像内的 README 记录它对应的仓库提交；判断是否落后（退出码 0 表示不落后）：

```sh
git merge-base --is-ancestor "$(git log -1 --format=%H -- packages/ui/src)" <镜像记录的提交> && echo 镜像为最新
```

- 落后时以本文与 `packages/ui` 为准；需要时按仓库差异增量同步或直接重建，不必随每次发版同步。
- 设计画布同理：确认后的画布以副本文件为准（§8、`ui-design` 技能），原型索引里的画布链接只是确认时的记录，可能只对确认者的账号可见。

衍生项目同样以自己仓库的 `docs/design/visual-system.md`、`brand.css` 与原型副本为准，项目镜像也是可选缓存。

## 2. 分层

自下而上，每层只依赖下一层：

| 层 | 位置 | 说明 |
|---|---|---|
| 框架 | TanStack Start + Tailwind CSS v4 | 路由、SSR 与工具类生成 |
| 底层交互 | `radix-ui` 统一包 | 焦点管理、键盘与无障碍语义；不使用拆分的 `@radix-ui/react-*`。Base UI 以后再评估 |
| 组件层 | `packages/ui`（`@product-res/ui`） | 以 Fluid Functionalism 的 Radix 版为主、shadcn 补缺，逐个组件接入并适配（`UPSTREAM.md`）|
| 设计 token | `packages/ui/src/styles/globals.css` → `presets/*.css` → `apps/web/src/styles/brand.css` | 三层：基线 → 预设 → 项目品牌，见第 3 节 |
| 页面模式 | 工作台、列表、表单、营销区块等 | 由组件组合而成的固定版式，见第 6 节 |
| 业务页面 | `apps/web/src/routes`、`apps/web/src/features` | 只组合 `@product-res/ui` 与 `@product-res/ui/project`，不写死颜色与尺寸 |

边界由检查脚本落地，不只靠约定：

- `pnpm check:deps`：`radix-ui`、`motion`、`lucide-react`、`class-variance-authority` 等只允许 `@product-res/ui`
  依赖与导入，`@radix-ui/*` 在任何包中都禁止。规则在 `scripts/check-deps.rules.json`。
- `pnpm check:ui`（并入 `pnpm check`）：扫描 `apps/**/src/**/*.tsx`，禁止颜色字面量（hex / rgb / hsl / oklch）、
  className 任意值（`-[...]`）、原生 `<select>` 与 `confirm()` / `alert()`。例外逐文件登记在
  `scripts/check-ui.allow.json`（模板）与 `scripts/check-ui.allow.local.json`（项目），每条写明规则与原因。

## 3. 设计 token

### 3.1 三层归属

| 层 | 文件 | 归属 | 内容 |
|---|---|---|---|
| 基线 | `packages/ui/src/styles/globals.css` | 模板 | Fluid 默认视觉（中性灰阶）：语义色、表面阶梯、阴影、交互态、层级、字号阶梯；`@layer base` |
| 预设 | `packages/ui/src/styles/presets/{neutral,blue,violet,green}.css` | 模板 | 只覆盖强调色与焦点环，挂在 `<html data-preset="…">`，同为 `@layer base` |
| 品牌 | `apps/web/src/styles/brand.css` | 项目 | 项目品牌值；不分层，普通 `:root` / `.dark` 选择器即可覆盖前两层 |

模板基线刻意保持中性，不按任何具体产品的参考调整；视觉方向由衍生项目提供参考后写在品牌层。
`apps/web/src/styles/app.css` 已把 `brand.css` 作为最后一个导入，项目不需要改 `app.css`。

### 3.2 token 清单

数值会随上游与预设调整，本表只列名称与用途；当前取值直接从源文件读取：

```sh
# 基线（浅色在前，.dark 在后）
grep -nE -- '^ +--[a-z0-9-]+:' packages/ui/src/styles/globals.css
# 各预设覆盖的变量
grep -nE -- '--[a-z0-9-]+:' packages/ui/src/styles/presets/*.css
# 项目品牌层实际生效的覆盖（模板版本只有注释，无输出）
grep -nE -- '^ *--[a-z0-9-]+:' apps/web/src/styles/brand.css
```

| 类别 | 变量 | 工具类 | 用途 |
|---|---|---|---|
| 页面与容器 | `--background` `--foreground` `--card(-foreground)` `--popover(-foreground)` | `bg-background` `text-foreground` `bg-card` `bg-popover` | 页面底色取 `--surface-1`，卡片与弹层取 `--surface-3` |
| 强调 | `--primary` `--primary-foreground` `--primary-text` | `bg-primary` `text-primary-foreground` `text-primary-text` | 主按钮等实心强调；预设与品牌层改这里换色。强调色作文字（链接）用 `--primary-text`，深色预设下为更亮的同色系以满足 4.5:1 |
| 次级 | `--secondary(-foreground)` `--muted` `--muted-foreground` | `bg-secondary` `bg-muted` `text-muted-foreground` | 次要底色、说明文字（在 muted 与高层表面上满足 4.5:1） |
| 较重强调底 | `--accent` `--accent-foreground` | `bg-accent` | Fluid 原值，较重；普通悬停与当前项改用 `bg-hover` / `bg-active` |
| 中性填充 | `--neutral-fill` | `bg-neutral-fill` | 灰色实心 Badge 等中性底（与 `--accent` 默认同值但独立）；品牌层改 `--accent` 不影响它，一般不需要覆盖 |
| 状态 | `--destructive` `--destructive-light` `--success` `--warning` | `text-destructive` `bg-destructive-light` `text-success` `text-warning` | 危险、成功与提醒（对话「未完成」，浅 `#8a5a00` / 深 `#fcd34d`）；作文字时（含自身 10%–15% 淡底上）满足 4.5:1 |
| 边框与输入 | `--border` `--input` | `border-border` `border-input` | 边框由前景色混出，随明暗自动变化 |
| 对话填充 | `--chat-fill` | `bg-chat-fill` | 前景色 6% 半透明：用户气泡、中性状态徽标、不可用的输入框。叠在所处表面上，卡片上同样可见（深色下 `--secondary` 与卡片同色） |
| 交互态 | `--hover` `--active` `--selected` `--tint` `--tint-hover` | `bg-hover` `bg-active` `bg-selected` `bg-tint` | 悬停、按下、选中与按钮底色层 |
| 焦点与品牌强调 | `--fluid-accent` `--fluid-accent-text` `--focus-ring` `--ring` | `bg-fluid-accent` `text-fluid-accent-text` `ring-ring` | 唯一的品牌强调色：开关、选区与焦点环；焦点环与背景、与主按钮 ≥ 3:1。`--fluid-accent-text` 为强调色作小字（强调色 72% 与正文色混合，默认浅约 `#3362b1` / 深约 `#7da7f9`，浅色更深、深色更亮，随预设换色） |
| 表面阶梯 | `--surface-1` … `--surface-8` | `bg-surface-1` … `bg-surface-8` | 浅色靠阴影分层，深色层级越高越亮 |
| 阴影 | `--shadow-1` … `--shadow-8` | `shadow-surface-1` … `shadow-surface-8` | 与表面层级配对使用 |
| 圆角 | `--radius` | `rounded-sm/md/lg/xl` | 基准值；控件 `rounded-lg`、容器 `rounded-xl`；按钮、选择器与弹窗的形状另由 `ui.shape` 控制 |
| 字号阶梯 | `--fs-*` / `--lh-*`（display、title、subtitle、body、caption、micro，各含 `-compact`） | `text-display` `text-title` `text-subtitle` `text-body` `text-caption` `text-micro` | 页面只用这六个角色，不写任意字号 |
| 容器查询 | `--container-chat-message`（23rem） | `@chat-message:` | ChatMessage 助手消息的版式阈值，见 §6.1 |
| 层级 | `--z-sticky` `--z-overlay` `--z-modal` `--z-popover` `--z-tooltip` `--z-toast` | — | 离开组件流的浮层只用这些值；Toast 在模态与提示之上 |
| 控件 | `--control-border` `--field-border` `--switch-thumb-on` `--switch-thumb-off` | — | 复选框边框与开关关闭轨道、输入类边框、开关滑块 |
| 字体 | `--font-sans` | `font-sans` | 自托管 Inter 可变字体（opsz），中文回退系统字体 |

新增 token 先改基线（模板）或品牌层（项目），再用工具类引用；页面中不出现原始颜色值。

**字体预加载**（add-marketing-critical-path）：根布局对 `apps/web/src/features/theme/fonts.project.ts` 的
`projectFontPreloads(defaults)` 返回的每一项输出 `<link rel="preload" as="font">`，默认是模板的 Inter 拉丁子集（约 71KB）。
预加载在首帧前占用带宽，只预加载首屏正文确实使用的字体：品牌层用 `--font-sans` 换掉 Inter 时返回 `[]`；
要预加载自己的字体，在该文件 `import url from './brand.woff2?url'` 后返回 `[{ href: url, type: 'font/woff2' }]`（追加用 `[...defaults, …]`）。
该文件归项目所有，模板同步不覆盖。`brand.css` 覆盖了 `--font-sans` 而首页仍预加载 Inter 时，`pnpm build` 会打印警告。

**度量匹配回退字体**：字体栈中 Inter 之后是 `"Inter Fallback"`（`globals.css`，本地 Arial / Liberation Sans 按 Inter 的宽度与纵向度量缩放）
与 `"Inter Fallback Roboto"`（没有 Arial 的 Android 上用系统 Roboto，按同样方法缩放），
慢网下 Inter 晚于首帧到达时换字不再改变换行，避免版面跳动（CLS）。它只覆盖 Inter 拉丁子集的字符，加载完成后的外观不变。
项目换掉 Inter 时新字体栈不含它，规则自然不生效；若自己的字体也以 `font-display: swap` 加载，可按同样方法定义回退字体。

### 3.3 主题预设与 ui 配置

`template.config.ts` 的 `ui` 段：

| 键 | 取值 | 作用 |
|---|---|---|
| `preset` | `neutral`（默认）`blue` `violet` `green` | 强调色与焦点环；根布局在 SSR 时写入 `<html data-preset>`，首屏无闪烁 |
| `shape` | `sharp` `rounded`（默认）`pill` | 按钮、选择器与弹窗的圆角形状，经 `UiRoot` 下发 |
| `density` | `default`（默认，控件 36px）`compact`（28px） | 控件尺寸与字号阶梯 |

省略的键取默认值，未知取值在构建期报错。新建项目时可用生成器参数选预设，写入 `template.config.ts` 与
`.template-base.json`：`pnpm create-project --name acme --domain acme.example --theme violet`（可选值见 `pnpm create-project --help`）。每个预设同时定义浅色与 `.dark`，对比度由
`packages/ui/test/presets.test.ts` 断言：正文 ≥ 4.5:1，焦点环与背景、与主按钮 ≥ 3:1。
明暗主题由 `themeInitScript` 在首屏前设置 `<html class="dark">`，`ThemeToggle` 提供浅色、深色与跟随系统。

## 4. 组件用法

页面只从 `@product-res/ui`（模板组件）与 `@product-res/ui/project`（项目组件）导入，不直接导入 Radix、motion、lucide-react
等底层库（`pnpm check:deps` 会失败）。当前可用的公开组件以 `packages/ui/src/index.ts` 为准：

```sh
grep -nE '^export' packages/ui/src/index.ts
```

规则：

- **根组件**：根布局用 `UiRoot` 包裹一次，传入 `template.config.ts` 的 `shape`、`density`；上下文 hooks 与 Provider
  不导出（随上游月度改名），只经 `UiRoot` 配置。
- **按钮**：`Button` 保留 shadcn 变体（`default` `destructive` `outline` `secondary` `ghost` `link`）与尺寸；
  需要加载态时用 `loading`，图标用 `leadingIcon` / `trailingIcon`，不要在按钮里手写转圈。
- **选择**：用 `Select` 系列，不用原生 `<select>`。`SelectItem` 需要显式 `index`（从 0 起，与渲染顺序一致），
  它同时驱动悬停高亮注册与渲染期的高亮判断。
- **确认**：删除等危险操作用确认对话框，不用 `confirm()`；取消后焦点回到触发按钮。确认对话框用
  `AlertDialog`（受控用法替换 `confirm()`，关闭后焦点回到打开前的元素，退场期间按钮不可再次触发）。替换步骤见 [4.1](#41-替换原生控件)。
- **列表与表单**：后台列表用 `DataTable` 与 `apps/web/src/features/admin/list.ts`；表单用 `useAppForm` / `TextField`。
- **多语言文案**：组件不带英文默认文案，类型上要求调用方传入（`apps/web` 中传 `m.*()`）：

  | 组件 | 属性 | 说明 |
  |---|---|---|
  | `DialogContent` | `closeLabel` | 关闭按钮的可读名称；`showCloseButton={false}` 时不需要 |
  | `SelectTrigger` | `placeholder` | 未选择时显示的文字 |
  | `AlertDialogAction` / `AlertDialogCancel` | `children` | 按钮文字；标题与说明同样由调用方传入 |
  | `Switch` | `label` 或 `aria-label` | 不显示标签时传 `aria-label` |
  | `Tooltip` | `content` | 提示文字 |
  | `ThemeToggle` | `labels` | 由调用方传入 |
  | `DataTable` | `labels` | 全部文案必填（4.2 去掉英文默认值）；`apps/web` 用 `dataTableLabels()`（`features/i18n/table-labels.ts`）或后台的 `adminTableLabels()` |
  | `Tabs` / `TabsItem` | `aria-label` / `label` | `label` 在仅图标（`activeLabel`）时兼作可读名称；`Tabs` 的 `aria-label` 建议传 |
  | `DropdownSearch` / `DropdownEmpty` | `placeholder` / `children` | 搜索框占位文字（兼作可读名称）与无结果文字；`MenuItem`、`DropdownSubTrigger` 的 `label` 必填 |
  | `ComboboxInput` / `ComboboxChips` | `placeholder`；`clearable` 时 `clearLabel` | 占位文字与清除按钮名称 |
  | `ComboboxChips` | `chipsLabel`、`removeLabel(label)` | 已选标签组名称与每个移除按钮名称 |
  | `Combobox` / `ComboboxEmpty` | `onCreate` 时 `createLabel(query)` / `children` | 创建行文字与无匹配文字 |
  | `CommandMenu` | `labels`（`placeholder`、`suggestions`、`tabs`、`selectHint`、`tabsHint`、`closeHint`） | 搜索框占位（兼作可读名称）、建议分组标题、标签栏名称与底部按键提示；键帽字形保留 |
  | `CommandMenuDialog` | `title`（`description` 可选） | 对话框的可读名称 |
  | `SheetContent` | `closeLabel` | 关闭按钮的可读名称；`showCloseButton={false}` 时不需要（内容自带关闭按钮时） |
  | `PopoverTitle` / `SheetTitle` | `children` | 弹层标题；`PopoverContent` 需传 `aria-labelledby` 指向标题 id（Radix Popover 没有 Title） |
  | `Toaster` | `labels`（`region`、`announcement`、`close`） | 通知区域名称（可含 `{hotkey}`）、读屏播报前缀、关闭按钮名称；`toast()` 的内容与 `action.label` 由调用方传入 |
  | `SidebarProvider` | `labels`（`title`、`expand`、`collapse`、`rail`、`railResize`、`railCollapse`；开启 peek 时 `peek`） | 移动抽屉名称、触发按钮与拖拽条的名称和提示；`SidebarMenuButton` 在 `status="unread"` 时必传 `unreadLabel` |
  | `Reader`（`@product-res/ui/reader`） | `labels`（`toc`、`progress`、`exportPdf`、`printPdf`、`serverPdf`、`loading`、`footnotes`、`footnoteBack`）与 `title` | 目录标题、进度条名称、导出按钮与注册服务端导出后的两个菜单项、加载播报、脚注区标题与返回链接名称；`ReaderProgress` 的 `label`、`ReaderExportButton` 的 `labels`（导出三项）；`ReaderEmpty` / `ReaderError` 的标题、说明与 `retryLabel` 由调用方传入 |
  | 业务界面组件（8.6） | `label` / `labels` 等 | 见 [6.1](#61-业务界面组件) 接口表 |

  新组件引入新的可读文字时，同步更新本表与 `packages/ui/UPSTREAM.md`。
  `labels` 对象可以内联传入（`labels={{ … m.*() … }}`）：不会导致重新挂载，Command Menu 内部另按字段稳定引用；
  放在频繁重渲染的组件里时可提到 `useMemo` 中减少子组件渲染。
- **图标**：业务页面从 `@product-res/ui/icons` 按名称导入（如 `import { Folder } from '@product-res/ui/icons'`），传给组件的图标槽位
  （`Button` 的 `leadingIcon`、`SidebarMenuButton` / `TabsItem` / `CommandMenu` 条目的 `icon` 等）；apps 不直接依赖
  lucide-react（`pnpm check:deps`）。入口只登记常用图标，项目需要更多时在 `packages/ui/src/project/` 中再导出。
  组件内部的图标槽位（`UiRoot` 的默认图标表，会进入首页包）目前 9 个；**超过约 15 个或首页 JS 增量超过 5 KB 时**，
  改为各组件自带回退图标、只在 `UiRoot` 传入替换项，不再扩充默认表。
- **通知（Toast）**：`toast()` 来自零依赖的 store（`toast-store.ts`），任何地方都可调用；`<Toaster />` 含动效库
  （约 44 KB gzip），只在 app / admin 布局中用 `React.lazy` 挂载一次，**不放进根布局**，营销页不加载：

  ```tsx
  const Toaster = lazy(() => import('@product-res/ui').then((ui) => ({ default: ui.Toaster })))
  // 布局中：<Suspense fallback={null}><Toaster labels={{ region: m.…(), announcement: m.…(), close: m.…() }} /></Suspense>
  ```
- **侧边栏**：`collapsible="icon"`（收起为图标栏）时每个 `SidebarMenuButton` 都必须传 `icon`，收起后名称由 Tooltip
  显示（`tooltip` 省略时取行内文字）；默认 `offcanvas`。快捷键 `shortcut` 默认关闭，需要时显式传入（如 `"["`）；
  嵌入式预览等区域可加 `data-keyboard-scope` 属性，焦点在其中时外层侧栏的快捷键不响应（受支持的属性）。
  折叠状态由布局在 `onOpenChange` 中写 cookie、服务端读回 `defaultOpen`（tasks 8.3）。
  `SidebarProvider` 的 `widthIcon` 设图标栏宽度（工作台用 4rem）；移动抽屉里点击同页链接后自动关闭，焦点回到打开抽屉的按钮
  （`<Sidebar closeOnNavigate={false}>` 关闭此行为）。收起时才显示 / 隐藏的自定义内容用 `in-data-[collapsible=icon]:` 变体，
  只在抽屉里显示的内容用 `in-data-[mobile=true]:` 变体。
- **命令面板**：键帽按平台显示 ⌘ 或 Ctrl；SSR 首帧无法得知平台，需要时在布局中用
  `<CommandMenuPlatform mac={…}>` 包裹，`mac` 取自请求头 `Sec-CH-UA-Platform` 或 User-Agent，避免水合后键帽变宽。
- **浮层层级**：自定义吸顶、遮罩与弹层用 `--z-*` 变量，不写任意 `z-[…]`。
- **弹层与底部面板**：触发按钮旁的非模态内容（列表、说明、轻量操作）用 `Popover`（`role="dialog"`，Escape / 点击外部关闭，
  焦点回到触发按钮；菜单项里不能再放按钮时不用 Dropdown）；手机上的对应形态用 `Sheet side="bottom"`（模态、锁定焦点，
  触控目标 ≥ 44px）。同一入口按 md 断点在两者之间切换时，打开期间不切换（见通知铃铛 `features/notifications/bell.tsx`）。
- **长文阅读器（tasks 8.4）**：从子路径 `@product-res/ui/reader` 导入（依赖 react-markdown 等，约 56 KB gzip，不在 `@product-res/ui`
  主入口中），页面用 `React.lazy` 按需加载，构建时形成独立分包，不进入首页包（`apps/web` 的 `pnpm build` 末尾由
  `scripts/check-home-bundle.mjs` 检查首页静态依赖闭包）：

  ```tsx
  const Reader = lazy(() => import('@product-res/ui/reader').then((m) => ({ default: m.Reader })))
  ```

  路由文件中不被拆分的部分（`validateSearch`、`loader` 等）不要从导入了阅读器的模块取常量，否则会把阅读器静态带进入口包。
  - 安全：原始 HTML 一律丢弃，元素按白名单渲染；链接只允许 http、https 与站内地址（`javascript:`、`data:` 等渲染为纯文本，
    自动链接与引用式链接同样处理），外链新窗口打开并带 `rel="noopener noreferrer"`；图片按 `images`：`same-origin`
    （默认，只显示站内相对地址）、`all`（另允许 http/https）、`none`。正文开头与 `title` 相同的一级标题会被去掉。
  - 目录取正文的二、三级标题（空标题与脚注不计入，重复标题的 id 依次加后缀）；宽屏左侧吸顶目录，窄屏（< lg）为折叠下拉。
    状态用 `status`（`ready` / `loading` / `empty` / `error`），空与错误内容用 `ReaderEmpty`、`ReaderError`；
    `footer` 是正文后的插槽（嵌入式对话或悬浮提问入口，tasks 8.6）。每种状态恰好一个 h1。
  - **两种顶栏用法**：独立页面用自带顶栏（默认，含标题、导出按钮、阅读进度，`leading` 放面包屑 / 返回按钮，`actions` 放其他操作）；
    放进已有顶栏的外壳（如工作台）时传 `bar={false}`，用同一个控制器把进度条与导出按钮放进外壳顶栏：

    ```tsx
    const reader = useReaderController()
    // 外壳顶栏：<ReaderExportButton controller={reader} labels={…} /> 与
    //           <ReaderProgress controller={reader} label={…} className="absolute inset-x-0 -bottom-px" />
    <Reader controller={reader} bar={false} title={…} markdown={…} labels={…} />
    ```

    `bar={false}` 时阅读器按所在滚动容器（或页面）顶部计算吸顶与当前节，外壳顶栏应位于该滚动容器之外。
  - 导出 PDF 默认调用浏览器打印；服务端生成 PDF 由项目 `registerPdfExporter(({ title, markdown, exportContext }) => …)` 注册
    （`registerPdfExporter` 零依赖，从 `@product-res/ui` 主入口导出），注册后导出按钮变为「浏览器打印 / 服务端生成」菜单，未注册时
    不显示服务端选项；`exportContext` 由 Reader 属性原样传入（如报告 id）。阅读器不改地址栏 hash（TanStack Router 会把
    `history.replaceState` 当作导航并重跑 beforeLoad / loader），需要时在 `onSectionChange(id)` 中按应用的路由方式处理。
  - 打印隐藏阅读器顶栏、目录、进度条、导出按钮与 `footer`，二级标题从新页开始，深色主题在打印期间临时切为浅色；
    **阅读器之外的页面框架（侧边栏、悬浮控件）需自行加 `print:hidden`**，外层滚动容器在打印时应取消固定高度与 `overflow`，
    否则只打印可见部分。

已接入：Button、Input、Textarea、Select、Combobox、Checkbox、Switch、Badge、Tooltip、Tabs、Dropdown（菜单）、
Command Menu、Dialog、AlertDialog、Popover、Sheet、Toast、Sidebar、Card、Alert、Separator、Label、ScrollArea、DataTable、Form；Reader 系列经 `@product-res/ui/reader` 子路径；
业务界面组件（8.6）见 [6.1](#61-业务界面组件)。
`Toaster` 含动效库（约 44 KB gzip），只在需要的页面挂载，不放进根布局；以后全站使用时按需动态加载。缺少的组件先在 `packages/ui` 补齐（模板）或在 `packages/ui/src/project/` 补齐（项目），
再实现页面，不在页面里临时写一个。

### 4.1 替换原生控件

存量的原生 `<select>`、`confirm()` 与 admin 私有控件按本节逐处替换；待替换位置以
`scripts/check-ui.allow.json` 的 `pendingReplacement` 为准（原生 select 在各功能目录，`window.confirm` 只剩
`features/workspace/components.tsx` 两处）。样例：`apps/web/src/routes/admin/models.tsx`（Select 的各种变体）、
`apps/web/src/routes/admin/credits.tsx`（AlertDialog、Textarea），对应 e2e 为 `apps/web/e2e/admin-models.spec.ts`、
`admin-model-params.spec.ts`、`admin-credits.spec.ts`。

每处替换的收尾：

1. 从 `scripts/check-ui.allow.json` 的 `pendingReplacement` 删除该处登记（同一文件的条目全部清除后删掉整个键），
   运行 `pnpm check:ui`。
2. 查找并更新依赖原生控件的测试：
   `git grep -nE "selectOption|on(ce)?\('dialog'|option\[value|tagName" -- apps/web/e2e apps/web/e2e-live`
   （包含 `e2e/staging-acceptance`），以及该组件的单元测试（见下文「测试」）。
3. 只改控件本身与必需的标签结构；页面布局、文案和业务逻辑不顺带调整。

#### Textarea

admin 页面把 `Textarea` 的导入从 `features/admin/ui.tsx` 改为 `@product-res/ui`，属性不变。组件自带高度（3 行起随内容
增高到 10 行后滚动）与字号，去掉 `md:text-sm`、`min-h-*` 等尺寸类，保留 `font-mono` 这类语义类。

#### Select

导入 `Select, SelectContent, SelectItem, SelectTrigger`（分组另加 `SelectGroup, SelectLabel, SelectSeparator`）。

| 原生写法 | 替换为 |
|---|---|
| `<select value={v} onChange={(e) => f(e.target.value)}>` | `<Select value={v} onValueChange={f}>` |
| `value`、`defaultValue`、`disabled`、`required`、`name` | 放在 `Select` 上 |
| `id`、`aria-label`、`aria-describedby`、`aria-invalid`、`onBlur`、宽度类 | 放在 `SelectTrigger` 上；触发器默认最小宽度 160px（compact 128px），放进比它更窄的 grid / flex 列时传 `className="min-w-0"` |
| 展开的属性对象（`{...common}`、`{...field('x')}`） | 拆开：`value`/`disabled`/`required`/`name` 给 `Select`，`id`/`aria-*` 给 `SelectTrigger`，`onChange` 改写为 `onValueChange` |
| `<option value={x}>文字</option>` | `SelectContent` 内的 `<SelectItem index={i} value={x}>文字</SelectItem>` |
| `<option disabled>` | `<SelectItem disabled>`，仍占一个 `index` |
| `<optgroup label="…">` | `<SelectGroup><SelectLabel>…</SelectLabel>…</SelectGroup>`，组间可放 `<SelectSeparator />` |
| 原生 select 上的 `rounded-md border p-2` 等外观类 | 删除 |

基本形态（受控、值总是存在）：

```tsx
<div className="grid gap-2">
  <label className="font-medium text-sm" htmlFor={`${idPrefix}-mode`}>
    {m.admin_pricing_mode()}
  </label>
  <Select disabled={disabled} value={draft.mode} onValueChange={(mode) => set({ mode: mode as Mode })}>
    <SelectTrigger id={`${idPrefix}-mode`} className="w-full" placeholder={m.admin_pricing_mode()} />
    <SelectContent>
      <SelectItem index={0} value="per_call">{m.admin_per_call()}</SelectItem>
      <SelectItem index={1} value="token">{m.admin_per_token()}</SelectItem>
    </SelectContent>
  </Select>
</div>
```

规则：

- **index**：`SelectContent` 内从 0 起按渲染顺序连续编号，跨分组不重置；`SelectLabel`、`SelectSeparator` 不占编号。
  静态列表手写 0、1、2；动态列表先 `filter` 成最终数组，再用 `map((item, index) => …)` 的下标（不要用过滤前数组的
  下标）。条件渲染的选项（`{cond && <option …>}`）先组成数组再 `map`，不要手写会跳号的下标。分组时在渲染函数里
  累计计数，每次渲染从 0 开始：

  ```tsx
  function PlanOptions({ groups }: { groups: PlanGroup[] }) {
    let index = 0
    return (
      <SelectContent>
        {groups.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.items.map((item) => (
              <SelectItem key={item.id} index={index++} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    )
  }
  ```
- **取值必须是非空字符串**：Radix 遇到 `value=""` 的选项会抛错。数字、布尔等非字符串值转成字符串（如枚举用
  `String(i)` 作值、读回时 `enum[Number(v)]`）。原生的空值选项按语义选一种处理：
  - **必填，或选后不需要再清空**（「请选择…」「Choose a payment」）：删除该 `<option>`，文字改作 `SelectTrigger`
    的 `placeholder`；值为 `''` 时触发器显示占位文字。例：models.tsx 的服务商（`m.admin_choose_a_provider()`）。
  - **可选，且需要能选回空值**（「默认 / 全部 / 无」，parameter-form 的非必填参数与文件选择）：保留这一项，值用
    占位值 `'__default__'`，读写时换回 `''`（或 `undefined`）。常量放在页面已导入的 feature 模块里并导出，
    e2e 按值选择时导入同一个常量（路由文件不导出非路由内容）：

    ```tsx
    // features/ai/admin-model-params.ts
    export const DEFAULT_CHARGE_ON = '__default__'
    export const CHARGE_ON_VALUES = ['any_output', 'success'] as const

    // 页面
    <Select
      value={CHARGE_ON_VALUES.some((v) => v === draft.chargeOn) ? draft.chargeOn : DEFAULT_CHARGE_ON}
      onValueChange={(value) => set({ chargeOn: value === DEFAULT_CHARGE_ON ? '' : value })}
    >
      <SelectTrigger id={…} className="w-full" placeholder={m.admin_default()} />
      <SelectContent>
        <SelectItem index={0} value={DEFAULT_CHARGE_ON}>{m.admin_default()}</SelectItem>
        <SelectItem index={1} value="any_output">{m.admin_any_output()}</SelectItem>
        <SelectItem index={2} value="success">{m.admin_success()}</SelectItem>
      </SelectContent>
    </Select>
    ```
- **值必须在选项里**：原生 select 的值不在选项中时显示第一项，Select 的触发器会是空白。动态选项先校验再传值：
  `value={options.some((o) => o.id === v) ? v : ''}`（值为 `''` 时显示 placeholder）。需要特别处理的：
  `routes/app/$slug/billing.tsx` 的 `priceId`（切换支付方式后可能不在新列表里）、`features/ai/model-picker.tsx`
  的 `value ?? models[0]?.id`（`value` 可能是已下架的模型）、`features/ai-media/parameter-form.tsx` 的文件选择
  （文件可能还未就绪）。样例：models.tsx 的服务商
  `value={mediaProviders.includes(draft.provider) ? draft.provider : ''}`。
- **placeholder 必传**：有「请选择…」文案就用它；值总是存在的选择框传字段标签的文案（如 `m.admin_kind()`）。
- **文案来源**：跟随该页面现有方式。页面用 `m.*()` 时复用或新增 `apps/web/messages/{en,zh}/<feature>.json`
  中的键（两种语言同时加）；通用的「取消」用 `m.common_cancel()`。页面仍是英文字面量的（如
  `features/workspace/components.tsx`），沿用同风格字面量，不在替换时顺带国际化。
- **标签与外层元素**：触发器是 `<button>`，不要放进 `<label>` 里。把 `<label …>文字 <select …/></label>` 改为上面的
  「`div` + 兄弟 `label htmlFor` + `SelectTrigger id`」结构：原 label 的布局类（`grid gap-2`）留在 `div`，文字类
  （`font-medium text-sm`）留在 `label`；admin 表单也可用 `features/admin/ui.tsx` 的 `Field`。原来没有 id 的用
  `useId()` 生成；只有 `aria-label`（无可见标签，如语言切换）的把 `aria-label` 放到 `SelectTrigger`。
  `SelectTrigger` 最外层是块级 `<div>`，外层不能是 `<p>`、`<label>`、`<span>`，否则 SSR 水合报错：原来包在
  `<p>` 里的（如 `features/settings/account-sections.tsx`、`features/ai/model-picker.tsx`）改为 `<div>`，包在带
  样式的 `<label>` 里的（如 `features/i18n/language-controls.tsx`）把该 `label` 改为 `div` 并保留其类名。
- **宽度**：触发器默认最小 160px、随内容变宽；与输入框并排或同列的表单字段加 `className="w-full"`。
- **禁用**：外层 `<fieldset disabled>` 不会进入 Select 的状态，fieldset 在水合后仍会禁用的（如请求进行中），
  需要同时给 `Select` 传 `disabled`（样例：models.tsx 把编辑器的 `disabled` 传给每个 Select，并给
  `ParamsSchemaEditor` 加了 `disabled` 属性）。只在水合前禁用的 fieldset（如 `HydratedControls`）不需要传；
  原来直接写在 `<select>` 上的 `disabled={!ready}`、`disabled={pending}` 照搬到 `Select`。
- **选择后触发动作**（切换空间、修改成员角色、切换语言）：在 `onValueChange` 中执行原 `onChange` 的逻辑。`value`
  继续由当前状态或服务端数据驱动，失败时不改它，触发器自然显示原值；进行中用 `disabled` 防止重复触发。
  选后执行但不保留选择的「动作型」选择框固定 `value=""` 并给 `placeholder`（样例：models.tsx 的参考模板）。
- **表单提交**：
  - 受控且提交时从 state 读取（大多数页面）：不需要 `name`，也不写隐藏 input。
  - 依赖 `FormData` 或非受控：`Select` 放在 `<form>` 内并传 `name`（非受控时用 `defaultValue`），Radix 会自动
    渲染一个隐藏的原生 `<select aria-hidden>` 承载 `name`、值与 `required`，`FormData` 能读到；不要再手写
    `<input type="hidden">`，否则同名字段会出现两次。
  - `required`：保留在 `Select` 上（表单内会触发原生校验），但浏览器提示定位在隐藏元素上，提交处理中原有的
    空值检查保留（或在未选择时禁用提交按钮）。
  - TanStack Form（现有代码用 `form.Field`）：值同样受控；下例的空值是「跟随默认」，用占位值常量 `LOCALE_DEFAULT`
    （`'__default__'`）：

    ```tsx
    <form.Field name="locale">
      {(field) => (
        <div className="grid gap-2">
          <Label htmlFor={field.name}>{copy.locale}</Label>
          <Select
            value={field.state.value || LOCALE_DEFAULT}
            onValueChange={(v) => field.handleChange(v === LOCALE_DEFAULT ? '' : v)}
          >
            <SelectTrigger
              id={field.name}
              onBlur={field.handleBlur}
              aria-describedby={`${field.name}-errors`}
              placeholder={copy.localeDefault}
            />
            <SelectContent>…</SelectContent>
          </Select>
          <FieldErrors id={`${field.name}-errors`} errors={field.state.meta.errors} />
        </div>
      )}
    </form.Field>
    ```
- **服务端渲染与 `valueLabel`**：Radix 要到客户端才把选中项文字放进触发器，SSR 与水合前触发器为空（隐藏的原生
  select 也没有选项）。公开或预渲染页面（`routes/pricing.tsx`、`features/i18n/language-controls.tsx`）以及任何
  水合前禁用的选择框（`disabled={!ready}`、`HydratedControls` 内）必须给 `SelectTrigger` 传 `valueLabel`，从渲染
  选项的同一份数组算出，并加 `className="w-full"` 或固定宽度，避免水合后宽度跳动；`disabled={!ready}` 保留在
  `Select` 上。后台与登录后页面的其他选择框可以不传。

  以 `routes/pricing.tsx` 的支付方式为例（该页仍用英文字面量，选项文字与原 `<option>` 一致）：

  ```tsx
  const providerId = useId()
  const current = catalog.providers.find((p) => p.id === provider)
  const providerLabel = (p: (typeof catalog.providers)[number]) =>
    p.available ? p.id : `${p.id} — unavailable`

  <div className="grid gap-2">
    <label htmlFor={providerId}>Payment method</label>
    <Select value={current ? provider : ''} disabled={!ready} onValueChange={setProvider}>
      <SelectTrigger
        id={providerId}
        className="w-full"
        placeholder="Payment method"
        valueLabel={current ? providerLabel(current) : undefined}
      />
      <SelectContent>
        {catalog.providers.map((p, index) => (
          <SelectItem key={p.id} index={index} value={p.id} disabled={!p.available}>
            {providerLabel(p)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  </div>
  ```
- **测试**：
  - e2e：`selectOption` 改用 `apps/web/e2e/select.ts` 的 `chooseOption(trigger, '选项文字')`，触发器按可访问名称
    定位：`form.getByRole('combobox', { name: 'Pricing mode', exact: true })`。水合前点击无效，函数会重试到列表
    展开，原来为等水合而包的 `expect.poll` 可以去掉。只有取值的数据驱动脚本用 `chooseOption(trigger, { value })`
    （按 `SelectItem` 的 `data-value` 匹配，空值传页面导出的占位值常量）。`toHaveValue(x)` 改为
    `toHaveText('选项文字')`；`locator('option[value=…]')` 计数改为判断触发器存在或打开后计 `getByRole('option')`；
    `tagName` 为 `SELECT` 的断言改为 `BUTTON`。
  - `apps/web` 单元测试在 node 环境用 `renderToString`：只能断言 `role="combobox"`、id / `aria-label`、
    占位文字（值为空时）、传了 `valueLabel` 时的选中文字以及表单内隐藏 `<select name>` 的存在；选项列表不在 SSR
    输出里，改为测试生成选项的纯函数，或移到 e2e。
- **已知限制**（后续处理，替换时不用绕开）：触发器上的 `onBlur` 在打开弹层时就会触发（焦点移入列表），校验配在
  `onBlur` 上时会提前显示错误；语言切换替换后外层 `div` 与触发器各有一层边框，后续去掉外层边框。

#### Checkbox

用 `@product-res/ui` 的 `Checkbox` 替换 `CheckboxField`。受控值保持 `checked={value}`，回调改为
`onCheckedChange={setValue}`（参数是 boolean，不再读取 `event.target.checked`）。

```tsx
<Label htmlFor="registration-enabled" className="font-normal text-sm leading-normal">
  <Checkbox id="registration-enabled" checked={enabled} onCheckedChange={setEnabled} />
  {m.admin_registration_enabled()}
</Label>
```

`Label` 的文字保持原可访问名称，`htmlFor` 与 Checkbox 的 `id` 一致；整行标签仍可点击。
重复列表的 id 要包含记录标识。需要禁用时保留原 `disabled` / `fieldset disabled`。

依赖 `FormData` 时，把 Checkbox 放在 `<form>` 内并保留 `name` / `value`（非受控用 `defaultChecked`）。
Radix 会生成携带相同 `name` / `value` 的隐藏 checkbox：未勾选不提交，勾选且未指定 `value` 时提交 `"on"`；
服务端原解析不变，不再手写隐藏 input。提交时从 state 读取的受控表单无需添加 `name`。
e2e 用 `getByRole('checkbox', { name: '原标签文字', exact: true })` 勾选，并验证保存后的业务状态。

#### AlertDialog（替换 `confirm()`）

整页（或整个列表）只放一个受控确认框，不要在每行各放一个：行内按钮只记录目标并打开。`open` 与目标分开保存，
关闭后目标保留到退场动画结束，说明文字不会在淡出时变空。

```tsx
const [revokeOpen, setRevokeOpen] = useState(false)
const [revokeTarget, setRevokeTarget] = useState<Row | null>(null)

// 行内按钮（替换 `if (window.confirm(…)) void run(row)`）
<Button
  type="button"
  variant="outline"
  onClick={() => {
    setRevokeTarget(row)
    setRevokeOpen(true)
  }}
>
  {m.admin_revoke_batch()}
</Button>

<AlertDialog
  open={revokeOpen}
  onOpenChange={(open) => {
    if (!busy) setRevokeOpen(open) // 请求进行中忽略 Escape
  }}
>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{m.admin_revoke_batch_confirm_title()}</AlertDialogTitle>
      <AlertDialogDescription>
        {m.admin_revoke_batch_confirm_description({ batchId: revokeTarget?.id ?? '' })}
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel disabled={busy}>{m.common_cancel()}</AlertDialogCancel>
      <AlertDialogAction
        variant="destructive"
        loading={busy}
        onClick={(event) => {
          event.preventDefault() // 阻止立即关闭，等请求结束再关
          void confirmRevoke()
        }}
      >
        {m.admin_revoke_batch()}
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

按原调用的结果展示方式选一种 `onClick` 写法：

- **结果显示在页面状态行**（原代码 `confirm` 后调用的函数自己设置 message / error，样例 credits.tsx）：
  ```tsx
  async function confirmRevoke() {
    if (!revokeTarget || busy) return
    await submit(/* 原 confirm 之后的调用，参数取自 revokeTarget */)
    setRevokeOpen(false) // 成功失败都关闭，结果由页面原有的 role="status" / 错误区域展示
  }
  ```
- **错误显示在对话框内**（失败后让用户在原处重试）：增加 `const [confirmError, setConfirmError] = useState('')`，
  打开时清空；失败时 `setConfirmError(…)` 且不关闭，成功时 `setRevokeOpen(false)`；在 `AlertDialogHeader` 之后放
  `{confirmError ? <p role="alert" className="text-destructive text-sm">{confirmError}</p> : null}`。
- **不需要等待**（原代码 `confirm` 后同步执行或不关心结果）：`AlertDialogAction` 不调用 `preventDefault()`，
  `onClick={() => run(target)}`，对话框随点击关闭；`busy`、`loading` 不需要。

同一列表有多种需要确认的动作（如成员行的「移除」与「转让所有权」）时，仍只放一个确认框，目标里带上动作，
标题、说明、按钮文字与 `variant` 按动作取；只有危险操作（删除、移除、撤销）用 `destructive`：

```tsx
type Pending = { action: 'remove' | 'transfer'; member: Member }
const [confirmOpen, setConfirmOpen] = useState(false)
const [pending, setPending] = useState<Pending | null>(null)
const copy = pending?.action === 'transfer'
  ? { title: 'Transfer ownership?', body: `${pending.member.name} becomes the owner.`, confirm: 'Transfer', variant: 'default' as const }
  : { title: 'Remove member?', body: `${pending?.member.name ?? ''} loses access to this workspace.`, confirm: 'Remove', variant: 'destructive' as const }
// 行内：onClick={() => { setPending({ action: 'remove', member: m }); setConfirmOpen(true) }}
// AlertDialogTitle/Description/Action 分别用 copy.title、copy.body、copy.confirm，Action 传 variant={copy.variant}
```

规则：

- **文案**：原 `confirm('…?')` 拆为标题（简短的问句，如「撤销剩余积分？」）与说明（对象名称与后果，如批次号、
  「此操作无法撤销」）；确认按钮文字用动作动词（通常与行内按钮相同），取消用 `m.common_cancel()`（英文字面量
  页面用 `'Cancel'`）。删除、撤销、移除等危险操作用 `variant="destructive"`。文案来源规则同 Select。
- **焦点返回**：组件记录打开前获得焦点的元素并在关闭后归还，前提是该元素在对话框打开期间没有被重新挂载。
  `DataTable` 按函数调用渲染单元格（tasks 4.2 已在组件内根治），`columns` 每次渲染新建也不会替换行内按钮，
  不需要为此 `useMemo` 列定义（`packages/ui/test/data-table.test.tsx` 覆盖）。非 DataTable 的列表保持行 `key`
  稳定即可。确认后所在行被删除时焦点落到 `body`，属已知限制。
- **防重复**：组件在退场期间吞掉按钮点击；异步时再用 `busy` 守卫函数入口，并给确认按钮 `loading`、取消按钮
  `disabled`。
- **测试（e2e）**：删除 `page.once('dialog', (d) => d.accept())` / `page.on('dialog', …)`，改为点击触发按钮后
  操作对话框；原 `dialog.dismiss()` 改为点「取消」，并断言没有发生写入：

  ```ts
  await row.getByRole('button', { name: 'Revoke batch' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Revoke the remaining credits?' })
  await dialog.getByRole('button', { name: 'Revoke batch', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  ```

## 5. 动效与减少动态效果

- 动效只在 `@product-res/ui` 组件内部实现，档位取 `packages/ui/src/lib/springs.ts` 的 `spring.fast` / `moderate` / `slow`
  （移动的东西越大越慢），不手写时长；退出用对应档位的 `.exit`。
- `UiRoot` 以 `MotionConfig reducedMotion="user"` 包裹：系统开启「减少动态效果」时去掉位移与布局动画，
  只保留淡入淡出或直接切换。纯 CSS 动画用 Tailwind 的 `motion-reduce:` 变体降级。
- 营销页优先用 CSS 过渡；`motion` 只随交互组件按需加载，不进入营销首屏。新增动效区块须保持营销页
  Lighthouse SEO 与可访问性分数不下降，并在数据库不可用时仍可预渲染。

## 6. 页面模式

| 模式 | 组成 | 状态 |
|---|---|---|
| 工作台 | 侧边栏（分组由项目注册、可折叠、手机抽屉、底部升级与账户入口），与顶部布局经 `ui.appLayout` 二选一 | 现有（tasks 8.3），见下文 |
| 后台列表 | `DataTable` + `adminListSearch` / `adminListPage`，筛选改变回第一页 | 现有 |
| 表单 | `useAppForm` + 字段组件，提交按钮 `SubmitButton`，错误用 `FieldErrors` | 现有 |
| 长文阅读 | `Reader`：安全 Markdown、自动目录、吸顶高亮、阅读进度、打印样式与导出 PDF（`registerPdfExporter` 扩展点），见 §4 | 已提供（tasks 8.4），预览 `/dev/ui#reader` 与整页 `/dev/ui/reader?state=ready\|empty\|loading\|error` |
| 营销区块 | 数据背书（未配置不渲染）、三步流程、编号产品矩阵、悬浮 AI 入口 | `apps/web/src/features/marketing/sections/`（`Stats`、`Steps`、`ProductMatrix`）与 `ai-entry.tsx`，内容来自 `template.config.ts` 的 `marketing` 段；入口叠在浮动主题切换上方，页脚内容盒距页面底部 136px；`/dev/ui#marketing` 预览 |
| 对话 | 对话页 `ChatThread` + `ChatComposer`（消息列 720px 居中、输入区固定底部、生成中上滑出现「回到最新」、状态只在变化时播报）；嵌入式 `SubjectChat` 在 `EmbeddedChat` 中（inline / panel，手机为底部抽屉） | 已提供（add-ai-chat-components），组件预览 `/dev/ui#chat` |
| 业务界面组件 | 推荐追问、消息评分、嵌入式对话、余额不足弹窗、预计消耗、会员锁定、每日领取 | 现有（tasks 8.6），接口见 [6.1](#61-业务界面组件) |

**AI 聊天组件（已确认，2026-11-14，OpenSpec change add-ai-chat-components）**：使用者确认三点——
① 移植 Fluid 的 AI 组件（`ChatMessage`、`ThinkingIndicator`、`ThinkingSteps`、`InputMessage`，Radix 版，MIT）并新增模板自写的
`ToolCall`，全部经 `@product-res/ui/chat` 子路径导出（不进主入口与首页包），纯展示、文案由应用传入、不依赖 `ai` 包；
② 回复 Markdown（`ChatMarkdown`）复用阅读器的安全管线（丢弃原始 HTML、元素与链接协议白名单），不做语法高亮，代码块等宽 + 语言名 +
复制按钮，表格与代码块在块内横向滚动，回复中的图片只显示替代文字，流式时按块增量渲染；
③ 对话页与嵌入式 SubjectChat 都切换到这些组件，只保留 `EmbeddedChat` 一个嵌入式外壳。AI SDK `UIMessage` 的 parts 由
`apps/web/src/features/ai/message-parts.tsx` 分发，项目工具卡片在项目自有的 `message-parts.project.tsx` 中按工具名注册。
设计稿与已确认的偏离见原型索引「对话页」「嵌入式 SubjectChat」两行与该 change 的 design.md；选型对比见归档的 add-ui-design-system
`ai-components.md`。

**工作台（tasks 8.3）**：`template.config.ts` 的 `ui.appLayout` 取 `'sidebar'`（默认）或 `'topbar'`（原顶部布局，
结构不变），构建期决定。侧边栏布局在 `apps/web/src/features/app-shell/`：侧边栏在 surface-1，展开 248px、收起为 64px
图标栏，折叠状态存 cookie `app_sidebar`，服务端首屏按 cookie 渲染；内容区是 `SidebarInset` 的 8px 外边距
surface-2 + shadow-2 圆角面板，768px 以下侧边栏收为抽屉、面板铺满。导航条目用注册表登记，不改布局文件：

```ts
// apps/web/src/features/app-shell/nav.project.ts（项目自有）
export function registerProjectAppNav() {
  registerAppNav({
    group: 'content', // 固定分组 tools / content / settings，按此顺序显示，空分组不渲染
    items: [{ id: 'reports', label: m.reports_title, icon: Folder, to: '/app/$slug/reports', order: 10,
      visible: ({ role, readOnly, isPersonal }) => role !== 'member' }],
  })
}
```

模板条目在 `nav.default.ts` 的 `registerDefaultAppNav()`（可见性与原顶部布局一致）；项目条目写在项目自有的
`nav.project.ts` 的 `registerProjectAppNav()`（模板创建后不再修改），同 id 覆盖模板条目，`unregisterAppNav(id)` 移除；
`registry.ts` 每次加载先清空注册表再按序调用两者（热更新不残留旧条目）。`to` 取生成路由树中 `/app/$slug` 下的路由，
写错路径时类型检查失败。当前项取路径相同或位于条目之下、路径最长的条目（`exact` 只匹配相同路径）。
顶部布局保留原有链接，并在其后渲染项目新增的条目（模板条目 id 之外的）。

顶部条的标题是页面 h1（默认为当前导航项名称），页面正文从 h2 开始，不再重复同名标题。页面需要把面包屑、操作按钮或进度条
放进顶部条时渲染 `<AppShellBar title={…} actions={…} progress={…} />`（`features/app-shell/bar.tsx`）：内容经 portal
挂到顶部条 h1 内的标题插槽、操作插槽与底边进度条位置，**水合后才出现**（服务端首屏与水合前显示默认标题）；标题插槽有内容时
默认标题由 CSS 隐藏，页面卸载后自动恢复，同一页面可渲染多个 AppShellBar。
`useAppShellBarAvailable()` 为 false（顶部布局）时页面自行渲染工具条。打印时侧边栏、打开的抽屉、顶部条与通知入口隐藏，
面板去掉外边距与阴影，正文随文档流完整输出。顶部条与抽屉里的语言选择用 `LanguageControls placement="bare"`（无底色与阴影）；
`SidebarInset as="div"` 让顶部条不落在 `<main>` 地标里；`MenuItem` 的 `render`（如 `<Link to="/account" />`）让菜单项成为真实链接。
升级入口只对免费套餐空间的所有者 / 管理员显示（`getWorkspacePage` 返回 `planKey`）。

**通知铃铛（0.3.1，评审清单 #90，设计稿 `ui-review/Notifications*.dc.html`）**：顶部条（两种布局）右侧的铃铛，桌面为右缘对齐的
384px `Popover`，< md 为底部 `Sheet`；显示最近 5 条（点一条标为已读并跳到服务端校验的链接，行尾的勾只标已读）、全部标为已读、
正常 / 空 / 加载 / 错误（重试）四态。角标为未读数（> 99 显示 99+，0、加载中、出错时不显示）。铃铛与首页通知区共用
`NotificationsProvider`（`features/notifications/store.tsx`，在 `/app/$slug` 布局路由中按空间挂载一次，30 秒轮询一份数据）。
「查看全部通知」跳到工作台首页 `#notifications`，首页的通知折叠块读取锚点后展开并滚动到可见位置；侧边栏布局下还没有任何
通知时不渲染这个折叠块，其他页面的内容区不再有通知块。

每个页面都要设计并实现四种状态：正常、空、加载、错误；在 390px 宽无横向滚动，浅色与深色均正确。
根布局与公开页面的数据读取失败时降级，不让整页报错。

### 6.1 业务界面组件

tasks 8.6 提供，设计稿为 `docs/design-system/prototypes/ui-review/` 的 Chat、ReaderMobile、Reader（内嵌卡片）、
Billing（`showInsufficient`、会员锁定卡片）与 Workbench（每日领取条）画板。全部为纯展示组件：属性进、回调出，
不请求数据、不判断权益，文案无默认值（`apps/web` 传 `m.*()`），浅色与深色均用 token 工具类。`/dev/ui` 的
「SuggestionChips · MessageFeedback · EmbeddedChat」与「InsufficientCreditsDialog · CreditEstimate · LockedFeature ·
DailyClaimNotice」两节用中性示例数据展示全部状态。

| 组件 | 主要属性 | 回调 | 行为 |
|---|---|---|---|
| `SuggestionChips` | `suggestions: readonly string[]`、`label`、`showLabel?`、`disabled?` | `onSelect(text)` | 为空不渲染；长问题换行，不撑出横向滚动 |
| `MessageFeedback` | `value: { rating: 'up' \| 'down'; comment: string \| null; reason?; shareConversation? } \| null`（按字段比较）、`labels`、`reasons?: { value; label }[]`、`shareLabels?: { label; description }`、`disabled?`、`actions?`、`meta?`、`commentMaxLength?` | `onChange(next \| null): Promise<void>` | 再次点击同一评分以 `null` 回调（撤销）；点踩展开文字反馈，提交后可「修改反馈」；传入 `shareLabels` 时表单中有「共享对话」Checkbox（默认不勾选，说明文字经 `aria-describedby` 关联，随表单提交，修改时带出、取消勾选再提交即撤回）；切到点赞时文字、原因与共享同意清空；乐观更新，reject 时回滚（表单开合一并复位，提交失败焦点回到文字框）并以 `role="alert"` 播报 `labels.failed`；反馈表单带 `data-escape-scope`，其中的 Esc 只收起表单 |
| `EmbeddedChat` | `variant?: 'inline' \| 'panel'`（默认 panel）、`labels`、`children`（消息、推荐问题等）、`footer?`（输入框）、`badge?`、`headerAction?`、`open?` / `defaultOpen?`、`showTrigger?` | `onOpenChange(open)` | `inline`（Reader 画板，8.4 使用）：≥ 768px 为正文流中的卡片，始终显示；`panel`：≥ 768px 为悬浮按钮 + 右侧非模态面板，页面仍可操作，Esc 只在焦点位于面板内时关闭，关闭时焦点原在面板内才还给悬浮按钮（或打开前的元素）。< 768px 两者都是悬浮按钮 + 模态底部抽屉（含 safe-area）。**面板 / 抽屉关闭时卸载 children**，对话状态（草稿、已加载消息）由调用方保存；打开期间断点变化不切换模态，关闭后再按新断点。`[data-escape-scope]` 内的 Esc 不关闭面板 |
| `InsufficientCreditsDialog` | `open`、`estimatedCredits`、`availableCredits`、`labels`、`fallbackFocus?` | `onOpenChange`、`onBuyPacks()`、`onSubscribe?()` | 显示预计消耗、当前余额（危险色）与差额；不传 `onSubscribe` 时只显示购买积分包；关闭后焦点回到打开前的元素，打开前焦点在 body 时交给 `fallbackFocus()` |
| `CreditEstimate` | `estimate: string \| null`、`balance?`、`insufficient?`、`hideIcon?`、`pendingLabel?` | — | `null` 显示估算中占位（`pendingLabel` 给读屏）；`insufficient` 用危险色并换成提示图标，带 `data-insufficient` |
| `LockedFeature` | `title`、`description`、`actionLabel`、`badge?`、`children?`（被锁功能预览） | `onUpgrade()` | 预览 `inert` 且点击被拦下，任何点击只触发 `onUpgrade`，不执行功能 |
| `DailyClaimNotice` | `status: 'available' \| 'pending' \| 'claimed' \| 'error'`、`title`、`description`、`labels`、`error?`、`compact?` | `onClaim?()`、`onDismiss?()` | 自动发放的项目不传 `onClaim`；`claimed` 显示徽标；`pending` 按钮忙碌；只有标题、说明与错误在 `role="status"` 内；< 640px 自动紧凑、按钮放不下时换行，`compact` 为强制紧凑 |
| `ChatMessage`（`@product-res/ui/chat`） | `from: 'user' \| 'assistant'`、`status?: 'streaming' \| 'aborted' \| 'failed' \| 'incomplete' \| 'retrying'`、`statusLabel`（结束状态必填）、`statusDetail?`、`actions?`、`leading?`（头像旁，如推理按钮）、`avatar?`（`false` 不显示）、`entrance?`、`children` | — | 用户消息为右侧 `--chat-fill` 气泡（最宽 80%，消息列窄于 23rem 时 85%）；助手消息按自身宽度切换版式（容器查询，阈值 `--container-chat-message` = 23rem）：窄时头像与 `leading` 同一行、正文与操作区通栏在下，宽时为头像列 + 内容列；子元素（工具调用、正文）依次竖排；`streaming` 时正文末尾闪烁光标并 `aria-busy`，其余状态在正文下方显示徽标与说明，正文保留；操作区始终可见；长词与长链接换行 |
| `ThinkingIndicator`（`@product-res/ui/chat`） | `label`、`showIcon?` | — | 等待首个输出时的三点 + 文字；不是实时区域（页面另有状态播报）；减少动态效果时三点静止 |
| `ThinkingSteps` / `ThinkingStepsHeader` / `ThinkingStepsContent` / `ThinkingStep`（`@product-res/ui/chat`） | 根：`defaultOpen?`（默认折叠）/ `open?`；标题：`children`、`busy?`；步骤：`label?`、`children`、`status?` | `onOpenChange(open)` | radix-ui `Collapsible`，按钮带 `aria-expanded`；推理文本作为单步传入，原样换行 |
| `ToolCall`（`@product-res/ui/chat`） | `name`、`state: 'pending' \| 'running' \| 'done' \| 'error'`、`labels`、`children?`（详情）、`defaultOpen?` / `open?` | `onOpenChange(open)` | 默认不显示参数与结果；有 `children` 时头部才是展开按钮；`running` 转圈在减少动态效果时静止 |
| `InputMessage`（`@product-res/ui/chat`） | `value`、`placeholder`、`labels`、`busy?`、`disabled?`、`sendDisabled?`、`leading?`、`trailing?` | `onValueChange(value)`、`onSend(trimmed)`、`onStop?()` | Enter 发送、Shift+Enter 换行、输入法组字不发送；空内容、`disabled`、`sendDisabled` 与 `busy` 不发送；`busy` 时发送换成停止，焦点在按钮上时移到输入框；`textareaRef` 取输入框元素；内边距按输入区宽度（容器查询）；高度随内容增长，约 8 行后框内滚动；没有附件 |

接线现状：对话页（`features/ai/chat-page.tsx`）与嵌入式 `SubjectChat`（`features/ai/subject-chat.tsx`）共用 `ChatThread` / `ChatComposer`
（`@product-res/ui/chat` 组件 + 适配层 `message-parts.tsx`）；**SubjectChat 使用 EmbeddedChat**（inline / panel，手机底部抽屉），对话状态按会话
保存在外壳之外（`chat-session.ts`）。二者经 `features/ai/chat-extras.tsx` 接入推荐追问、
消息评分（`setMessageFeedback`；点踩原因为画板的四个选项，取值 `FEEDBACK_REASONS` 与服务端校验、`ai_message_feedback.reason` 的约束一致，刷新后还原，后台 `/admin/feedback` 可按原因筛选；共享对话勾选项写入 `ai_message_feedback.share_conversation`，只有同意的反馈后台才能查看被评回复与之前最近 3 条消息）与余额不足弹窗（`INSUFFICIENT_CREDITS` 的数值，入口跳到账单页 `#credit-packs` /
`#subscriptions`，构建时套餐快照中明确没有订阅时不显示订阅入口；`CREDIT_DEBT` 等仍为账单链接）。`CreditEstimate`、`LockedFeature`、
`DailyClaimNotice` 暂只在 `/dev/ui` 展示，由后续页面（账单页 8.7、长文阅读器 8.4 等）按需接入。

## 7. 组件预览页

`/dev/ui`（`apps/web/src/routes/dev/ui.tsx`，页面在 `features/ui-preview/`）按组件分节展示 `@product-res/ui` 全部共享组件的
变体与状态，顶部可运行时切换预设、明暗、shape、density；示例数据为中性领域，文案在
`messages/<locale>/ui-preview.json`。路由的 `beforeLoad` 经 server function 在服务端读取非密钥变量 `UI_PREVIEW`，
只有 `true` 时开放：`wrangler.jsonc` 的顶层（开发）与 `env.staging` 设为 `true`，`env.production` 不设
（`scripts/production/check-wrangler-envs.mjs` 拦截）；自托管未传入该变量即关闭。该页不在预渲染范围与 sitemap 中，
并输出 `noindex`。新增组件或变体时同步在预览页补一节。

## 8. 设计关卡

### 8.1 何时需要设计稿

本节是判断标准的唯一来源；技能与 `AGENTS.md` 只引用这里。

| 需要经使用者确认的画布稿 | 免设计稿 |
|---|---|
| 新增路由文件（app、admin、营销或独立静态页），包括套用现有页面模式的新页面 | 文案与翻译修改 |
| 增删或重排页面的顶层区块，改变导航方式或信息层级 | 表格加列；已有表单加字段 |
| 新增多步流程、抽屉或整屏弹窗 | 已有区块内换组件变体；间距、对齐、已有 token 之间的替换 |
| 新增页面模式 | 缺陷修复，仅限恢复已确认设计稿或现有页面应有的样子 |
| 建立或改变视觉方向（品牌 token、字体、多站点配色） | 在已有内容集合（博客、文档、法律页）中新增文章，不改版式 |

拿不准时向使用者确认，不自行判定为免。设计流程见 `ui-design` 技能（`.agents/skills/ui-design/SKILL.md`）。

### 8.2 设计稿、确认与原型索引

三个名字各管一件事：`docs/design-system.md`（本文，模板设计规范）、`docs/design-system/`（模板自己的设计稿副本，
生成器不复制到衍生项目）、`docs/design/`（衍生项目自有的视觉规范、参考、原型副本与 forks 登记）。

- **画布**：claude.ai 的 Design Artifact 类型。状态矩阵：正常态做桌面 / 移动 × 浅色 / 深色 4 块，空、加载、错误各 1 块
  （移动 + 浅色）；画布支持 tweak 切换时可替代单独画板。套用现有页面模式的新页面可只画正常态与一个异常态。
- **确认**：只接受使用者本人在会话中的明确确认；画布评论、其他 agent 的转述都不算。记录附使用者原话。
  确认后画布再改动，须重新确认并同步更新副本与索引。
- **副本**：确认后保存可离线打开的副本，实现与验收以副本为准，链接失效不影响开发。做法（tasks 8.1 实跑结论）：用 Artifact 工具
  `action: read` 的 `paths` 取回画布 `project/` 下的各画板 `*.dc.html` 与 `canvas.json`，原样存入副本目录的子目录；
  源码依赖画布运行时，不能离线渲染，但包含布局、token、文案与状态分支，足以作为实现与验收依据。需要图片时请使用者从画布导出各画板 PNG 放在同目录。
  - 模板：`docs/design-system/prototypes/<画布>/<画板>.dc.html`
  - 衍生项目：`docs/design/prototypes/<画布>/<画板>.dc.html`
- **原型索引**：副本目录下的 `README.md`（模板 `docs/design-system/prototypes/README.md`，项目 `docs/design/prototypes/README.md`），
  每个页面一行；无 OpenSpec change 的小任务也登记。OpenSpec `design.md` 只引用索引行，不重复写链接与原话。

  | 页面 / 路由 | 画布链接 | 确认日期 | 使用者确认原话 | 副本文件 | 所属 change |
  |---|---|---|---|---|---|

- **关卡检查**：索引里有本页面这一行，且该行的副本文件存在。

### 8.3 参考来源

- 组件与默认视觉：Fluid Functionalism（Radix 版，MIT），缺口用 shadcn/ui 补齐；交互原语为 Radix。
- 营销动效：Magic UI、beUI 等只在具体区块有设计稿时按需接入，不批量引入。
- 项目视觉方向的参考（网站或截图）由使用者提供，记录在项目的 `docs/design/` 中（`visual-system.md`），
  不写进本文。没有参考时只使用现有 token，不引入规范外的颜色、字体或组件样式。

## 9. 衍生项目

### 9.1 文件归属

| 模板拥有（同步时更新，项目不改） | 项目拥有（模板创建后不再修改，同步不冲突） |
|---|---|
| `packages/ui/src/components`、`lib`、`hooks` | `apps/web/src/styles/brand.css` |
| `packages/ui/src/styles/globals.css` 与 `presets/` | `packages/ui/src/project/`（经 `@product-res/ui/project` 导出） |
| `packages/ui/package.json`（含 `./project` 导出声明） | `scripts/check-ui.allow.local.json` |
| `apps/web/src/styles/app.css`（已在最后导入 brand.css） | `docs/design/`（视觉规范、参考、原型副本与索引、forks 登记） |
| 根布局 `apps/web/src/routes/__root.tsx` 与 `apps/web/src/features/theme/root-document.tsx`（项目经站点/主题属性扩展点定制） | `apps/web/src/features/ai/subject-providers.ts` |
| `scripts/check-ui.mjs`、`scripts/check-ui.allow.json` | `template.config.ts` 中 `ui` 段的取值 |
| 组件指纹清单 `packages/ui/components.lock.json` | |
| 预览页、技能、本文、`template.config.ts` 中 `ui` 段的结构 | |

- `packages/ui/src/project/index.ts` 是项目组件入口，模板只初始化一次（`export {}`），经 `@product-res/ui/project` 导出；
  该目录同样受 `pnpm check:ui` 与 `pnpm check:deps` 约束。
- `packages/ui/components.lock.json` 记录模板组件文件的内容哈希。模板修改组件后运行 `pnpm ui:lock` 重新生成并提交；
  衍生项目（存在 `.template-base.json`）中 `pnpm check:ui` 对比哈希，不一致即失败并提示下文的定制顺序。
- 生成器在副本中创建空的 `scripts/check-ui.allow.local.json` 与 `docs/design/README.md`（说明本目录各文件的用途），
  并且不复制 `docs/design-system/prototypes/`。
- `apps/web/src/features/theme/html-attributes.ts`（项目自有，模板创建后不再修改）：返回加到 `<html>` 的额外属性（如 `data-site`），根布局在服务端首屏合并；`lang`、`data-preset` 由模板写，不可覆盖。
- `apps/web/src/features/ai/message-parts.project.tsx`（项目自有，模板创建后不再修改）：按工具名注册工具卡片的显示名与详情渲染；
  未注册的工具只显示通用标签与状态。对话外观的定制按 [§9.2](#92-定制顺序) 的顺序进行（token → ui 配置 → project 包装），不改模板组件。
- `apps/web/src/features/app-shell/nav.project.ts`（项目自有，模板创建后不再修改）：登记项目的工作台侧边栏条目，
  或按 id 覆盖 / 移除模板条目（见 [§6](#6-页面模式)）。

### 9.2 定制顺序

项目不得直接修改模板组件文件（`components.lock.json` 校验会失败）。需要不同外观或行为时按顺序尝试，
前一步能解决就不进入下一步：

1. **token**：在 `brand.css` 覆盖变量（浅色与 `.dark` 成对给出，改色后核对对比度）。
2. **ui 配置**：调整 `template.config.ts` 的 `ui.preset` / `shape` / `density`。
3. **project 包装**：在 `packages/ui/src/project/` 写组合或包装组件，经 `@product-res/ui/project` 导出。
4. **复制到 project 并登记**：把模板组件复制到 `packages/ui/src/project/` 后修改，并在 `docs/design/forks.md`
   登记来源文件、复制时的模板版本与原因；同步模板后对照上游改动手动合并。复制的组件仍受 UI 规范检查，
   需保留上游的任意值或颜色字面量时，在 `scripts/check-ui.allow.local.json` 按文件登记规则与原因，只登记 forks.md 不够。

项目中写出的通用组件按惯例回流模板；模板发布后，项目同步并删除自己的副本。

### 9.3 多站点

一个项目服务多个站点时，在 `brand.css` 用 `:root[data-site="<站点>"]` 与 `:root[data-site="<站点>"].dark`
分别覆盖品牌变量。`data-site` 在项目自有的 `apps/web/src/features/theme/html-attributes.ts` 中按 host / locale / pathname
返回（只在服务端首屏计算，客户端导航不重算），不修改模板根布局；各站点的视觉规范写在项目的 `docs/design/visual-system.md`。
运行时 `locale` 总有值（缺省为默认语言），只能描述页面语言，不能推断站点：SSR 请求按 `host` 判断站点，
`locale` / `pathname` 只用于预渲染（构建请求的 host 固定）时按语言或路径划分的站点；分享卡片的站点解析规则相同
（[分享卡片 §6.1](share-cards.md#61-多站点)）。

### 9.4 同步模板

`template-sync` 涉及 `packages/ui` 或基线 token 时，合并前对 staging 的 `/dev/ui` 与项目关键页面截图对比；
`/dev/ui` 返回 404 时跳过并记未验收；本次变化的模板组件与 `docs/design/forks.md` 登记来源的交集逐个列入报告。
偏差在品牌层或项目组件中修正，不改模板组件。

## 10. 常用命令

```sh
pnpm check:ui
pnpm check:deps
pnpm --filter @product-res/ui typecheck
pnpm --filter @product-res/ui test
```

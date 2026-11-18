# 上游组件来源

`packages/ui` 中来自外部 registry 的文件在这里登记，便于按上游 changelog 手动合并（openspec
`add-ui-design-system` design D1）。上游每月发布且常有破坏性改名，因此**复制进仓库、不自动升级**，
每季度对照 changelog 选择性合并，合并后更新下表的「上游月份」。

- Fluid Functionalism：<https://www.fluidfunctionalism.com>，MIT，源码
  <https://github.com/mickadesign/fluid-functionalism>。取 Radix 版：
  `https://www.fluidfunctionalism.com/r/<name>.json`（不带 `base/` 前缀）。
- 拉取方式：`curl` 到临时目录后人工移植，不使用 `shadcn add … --overwrite` 直接写入仓库。

## 统一适配规则

1. `@radix-ui/react-*` 改为 `radix-ui` 统一包的命名导入（`import { Dialog as DialogPrimitive } from 'radix-ui'`）。
2. `@/lib/*`、`@/hooks/*`、`@/components/ui/*` 改为包内相对路径，带 `.ts` / `.tsx` 后缀。
3. 去掉 `"use client"`（TanStack Start 不需要），Biome 格式化。
4. 满足 `exactOptionalPropertyTypes`：可选属性不显式传 `undefined`，改为默认值或条件展开。
5. Biome a11y 规则与上游写法冲突处用 `biome-ignore` 注明原因，不改行为。
6. 每个文件头注明来源与上游月份；上游英文注释保留，模板改动处用中文注释。
7. token 不放在组件里：registry 的 `cssVars` / `css` 并入 `src/styles/globals.css`。
8. 动效按需导入：从 `motion/react` 导入 `m as motion`（JSX 仍写 `<motion.div>`，与上游的差异只在导入行），
   并在组件根节点包 `MotionFeatures`（`src/lib/motion-features.tsx`，LazyMotion + domAnimation）；
   `test/motion-imports.test.ts` 拦截完整 `motion` 导入，`test/motion-features.test.tsx` 不包 UiRoot 实际渲染各组件、断言动画在推进（`m.*` 不在 LazyMotion 之下时静止在 initial 且不报错，静态检查发现不了，如 SelectItem 的勾）。需要 layout / 拖拽动画的组件改用 domMax 前先评估包体积。
9. 焦点环统一为 2px 描边加 2px 间隙（`outline-2 outline-offset-2 outline-(--focus-ring)`），上游多为 1px ring。
10. 组件内不写英文默认文案：可读名称、占位文字等由应用按语言传入（见下文「必须传入的多语言文案」）。

## 文件清单

| 本包文件 | 上游 registry 项 | 上游月份 | 模板改动 |
|---|---|---|---|
| `src/components/button.tsx` | `button` | 2026-11 | 保留模板公开 API（variant `default/destructive/outline/secondary/ghost/link`、size `default/sm/lg/icon`、`asChild`、`buttonVariants`）；新增 Fluid 变体别名 `primary`、`tertiary`，尺寸 `compact`、`icon-compact`、`icon-sm`，`loading`、`leadingIcon`、`trailingIcon`。底色层由内部 span 改为 `::before`，子元素原样输出；强调色由 `--foreground` 改为 `--primary`（预设可换色），悬停 / 按下用 `color-mix` 掺黑加深（上游降不透明度）；焦点环改为 2px 描边加 2px 间隙（上游 1px ring）；destructive 用 `--destructive` 变量而非 Tailwind 红色，底色 /10、悬停 /15（深色 /15、/20）；未移植 `render`、`nativeButton`、`active`；`loading` 时文字用 `opacity-0` 占位（不用 `invisible`，保留按钮的可读名称）；`sm`/`lg` 为模板原有 32px/40px 尺寸；`link` 变体（模板原有）文字色用 `--primary-text` |
| `src/components/alert-dialog.tsx` | 无（Fluid 没有 AlertDialog，shadcn `alert-dialog` 补缺） | 2026-11 | 结构与 API 取 shadcn（Radix AlertDialog：Trigger / Content / Header / Footer / Title / Description / Action / Cancel），外观、开合动效与宽度档沿用 `dialog.tsx`；无关闭按钮、点击遮罩不关闭；退场动画期间面板 `inert` + `pointer-events-none`，Action / Cancel 在已关闭时吞掉点击（防双击重复提交）；Action / Cancel 渲染 `Button`（默认 `default` / `outline`，可传 `variant="destructive"`），文字必须由调用方传入；没有 Trigger 的受控用法关闭后把焦点还给打开前的元素（Radix 只还给 Trigger） |
| `src/components/badge.tsx` | `badge` | 2026-11 | 18 个色值移入 globals.css 的 `--badge-*`（组件不写死颜色），`accent` 取 `--fluid-accent`；圆点加 `aria-hidden`；`size` 只公开 `default` / `compact`（不移植上游 sm/md/lg 兼容别名），`badgeVariants` 不从包入口导出 |
| `src/components/checkbox.tsx` | `checkbox` | 2026-11 | 静止边框 `--control-border`（上游 `--border` 对背景约 1.4:1，未选中方框是唯一状态标识），悬停加深到正文色；焦点环 2px 描边加间隙；勾选图标加 `aria-hidden` |
| `src/components/tabs.tsx` | `tabs` | 2026-11 | 焦点环改为贴合标签的 2px 描边加 2px 间隙（上游为外扩 2px 的 1px 边框），用满列表原有的 4px 内边距；减少动态效果时选中药丸、悬停药丸、焦点环和折叠标签的位置与宽度直接跳到终值，只保留透明度过渡（left/width 动画不受 MotionConfig 控制）；`TabsItem` 的 `label` 在 `activeLabel` 折叠为仅图标时兼作可读名称；`m as motion` + `MotionFeatures` |
| `src/components/command-menu.tsx` | `command-menu` | 2026-11 | 英文默认文案收成根组件必填的 `labels`（placeholder、suggestions、tabs、selectHint / tabsHint / closeHint），键帽字形保留；`CommandMenuDialog` 的 `title` 必填、`description` 可选；搜索框加 `aria-label`（取 `labels.placeholder`）；对话框不显示关闭按钮；没有 Trigger 时关闭后把焦点还给打开前的元素（同 AlertDialog）；`useIsMac` 与快捷键解析等工具函数不从入口导出；`m as motion` + `MotionFeatures` |
| `src/components/dialog.tsx` | `dialog` | 2026-11 | `closeLabel` 必填（显示关闭按钮时；上游写死英文 "Close"），`showCloseButton={false}` 时不需要，传了 `closeLabel` 时 `showCloseButton` 可为布尔变量；退场动画期间面板 `inert` + `pointer-events-none`（上游退场时仍可点击）；DialogTitle 加 `font-semibold`（中文回退字体加粗）；`m as motion` + `MotionFeatures` |
| `src/components/input.tsx` | `input` | 2026-11 | 保留模板公开 API（原生 input 属性与 ref，始终只渲染 `<input>`），新增 `size`（尺寸阶梯，替代原生 `size` 属性）；吸收边框（`--field-border`）、悬停底色、高度 / 内边距 / 字号阶梯（触屏 16px 防缩放）；焦点除边框加深外加 2px 描边加间隙；错误边框用实色 `--destructive`（上游 /50 对背景约 2.5:1）；未移植文件图标与数字步进按钮（需要新图标槽位与多语言的「增加 / 减少」名称），`type="file"` / `"number"` 保持浏览器原生外观 |
| `src/components/select.tsx` | `select` | 2026-11 | 触发器焦点环改为 2px 描边加 2px 间隙；`error` 文字经 `aria-describedby` 关联触发器，错误边框用实色 `--destructive`；边框取 `--field-border`；`placeholder` 必填（上游默认英文 "Select…"）；新增可选 `valueLabel` 作为 `Select.Value` 的 children，SSR 与水合前即显示选中文字（tasks 5.1）；`m as motion` + `MotionFeatures` |
| `src/components/sidebar.tsx` | `sidebar` | 2026-11 | 移动抽屉（radix-ui `Dialog`）没有 Trigger，关闭后把焦点还给打开前的元素；退场动画期间面板 `inert` + `pointer-events-none`；抽屉可读名称取 `labels.title`（上游写死 "Sidebar"）；新增 `collapsible="icon"`（上游不支持，见 sidebar-core）；只转出组件与 Props 类型（`useSidebar`、`useSidebarIconRail`、宽度与快捷键常量、`sidebarMenuButtonVariants`、`SidebarShell` 不导出）；`m as motion` + `MotionFeatures`；tasks 8.3：移动抽屉里点击同页链接后关闭（`closeOnNavigate`，默认开启，带修饰键、新窗口或 `download` 链接时不关），打开的抽屉与遮罩 `print:hidden` |
| `src/components/sidebar-core.tsx` | `sidebar`（附带文件） | 2026-11 | 去掉 `persist` 与 cookie 写入，持久化由布局经 `onOpenChange` 负责（tasks 8.3）；修正非受控时传了 `onOpenChange` 不更新内部状态的问题；**模板新增** `collapsible="icon"`：收起后外壳保留 3rem，分组标题 `invisible` 保留高度，拖拽条可拖出或点击展开，此模式下不提供 peek；英文文案改为 Provider 必传的 `labels`，触发按钮名称随状态取展开 / 收起文案（上游固定 "Toggle Sidebar"）；分组标题、分组操作与 SidebarInput 焦点环改为 2px 描边加间隙，SidebarInput 悬停 `bg-hover`、边框 `--field-border`；拖拽宽度为原生 pointer 事件（非 motion drag）；快捷键默认关闭（`shortcut` 默认 `null`，上游默认 `[` / `]`；WCAG 2.1.4），开启后输入框内、菜单 / 列表框 / 对话框内、按键重复、已被消费（`defaultPrevented`）与带修饰键时不触发，可编辑判定与 Command Menu 共用 `lib/keyboard.ts`；`data-keyboard-scope` 区域保留为受支持属性（区域内焦点时外层快捷键不响应）；触发按钮加 `aria-expanded`，移动端加 `aria-haspopup="dialog"`；tasks 8.3：`SidebarProvider` 新增 `widthIcon`（图标栏宽度，默认 3rem），`variant="inset"` 的面板只在 offcanvas 收走时补侧边距（图标栏收起后仍贴栏），768px 以下面板铺满视口（无外边距、圆角与阴影）；`SidebarInset` 新增 `as`（`main` / `div`，默认 main） |
| `src/components/sidebar-menu.tsx` | `sidebar`（附带文件） | 2026-11 | 键盘焦点环改为 2px、外扩 4px（上游 1px）；`status="unread"` 时必传 `unreadLabel`（上游写死 ", unread"）；新增 `tooltip`：图标栏收起时行宽收为 `w-8`，名称只给读屏，聚焦或悬停用 Tooltip 显示；当前项文字 `font-semibold`（中文回退字体）；骨架屏 `motion-reduce:animate-none`；`MotionFeatures` 包在 SidebarMenu 上；tasks 8.3：收起的行 `mx-auto`，在可配置宽度的图标栏内居中 |
| `src/components/switch.tsx` | `switch` | 2026-11 | 关闭态轨道 `--control-border`（上游 `--accent` 对背景约 1.2:1）；关闭态滑块 `--switch-thumb-off`（上游写死白色）；开启态滑块 `--switch-thumb-on`（默认白色，深色预设的浅强调色上改为深色，保证 ≥ 3:1）；焦点环 2px 描边加间隙；减少动态效果时滑块直接落到终点（命令式 `animate()` 不受 MotionConfig 控制）；受控 `checked` + `onToggle`、整行可点击可拖动保持上游，以下偏离上游：调用方的行处理器与内部处理器合成（上游 props 展开在最后会覆盖内部处理器），`id` / `aria-describedby` / `name` / `value` / `required` 落到 role="switch" 按钮（Radix Root），`label` 放宽为 ReactNode、省略时必须传 `aria-label`，行去掉左右内边距（与其他字段左缘对齐），`touch-none` 改 `touch-pan-y`（允许从开关上开始竖向滚动） |
| `src/components/textarea.tsx` | `textarea` | 2026-11 | 焦点环与 Input 一致（2px 描边加间隙）；边框 `--field-border`、错误边框实色；只在支持 `field-sizing` 时去掉拖拽把手（`resize-y supports-[field-sizing:content]:resize-none`），其余浏览器可纵向拉伸 |
| `src/components/tooltip.tsx` | `tooltip` | 2026-11 | 仅统一适配规则（`m as motion` + `MotionFeatures`）；滑入位移在减少动态效果时由 UiRoot 的 MotionConfig 去掉 |
| `src/components/scroll-area.tsx` | `scroll-area` | 2026-11 | 仅统一适配规则；CSS 并入 `scroll-fade`、`scroll-divider`（4.2 随 Command Menu 并入）与细滚动条（限内部滚动容器，页面根保持系统默认，放在 base 层），未并入 `::-webkit-scrollbar` 规则 |
| `src/components/combobox.tsx` | `combobox` | 2026-11 | `framer-motion` 改为 `m as motion` + `MotionFeatures`（包在根上，Portal 内的 m.* 也在其下）；字段框由 1px ring 改为 1px border（`--field-border`），悬停底色 `bg-hover`（上游 `bg-muted/50`）；焦点环 2px 描边加间隙画在字段框上（`has-[input:focus-visible]:outline-*`），清除与标签移除按钮同样改为 2px；`error` 改为实色 `--destructive` 边框，错误文字经 `aria-describedby` 关联输入框；`placeholder` 必填（上游 "Search…"），`clearable` 时必传 `clearLabel`，`ComboboxChips` 必传 `chipsLabel` 与 `removeLabel(label)`，传 `onCreate` 时必传 `createLabel`，`ComboboxEmpty` 的 `children` 必填；展开按钮（`tabIndex=-1`）去掉英文 aria-label 改为 `aria-hidden`；多选标签去掉 `layout` 动画（domAnimation 不含），移位时直接落位；创建行图标用 `plus` 槽位；`comboboxFieldVariants` 不导出 |
| `src/components/toast.tsx`、`src/components/toast-store.ts` | 无（Fluid 没有 Toast，按 shadcn sonner 结构补缺） | 2026-11 | 命令式 store 拆到零依赖的 `toast-store.ts`（入口的 `toast` 从这里导出，只调用 `toast()` 不会带上 Toaster 与动效库）；超出 `visibleToasts` 时直接关闭最早的一条（sonner 观感，不排队）；error 变体加 `circle-alert` 图标； 结构与 API 取 sonner 形态（`<Toaster />` 挂一次 + 命令式 `toast()` / `toast.success` / `toast.error` / `toast.dismiss(id?)`，同 id 再调用为更新，`action`、`duration`（`Infinity` 常驻）、`onDismiss`、`visibleToasts` 默认 3）；不新增依赖：底层 radix-ui `Toast`（视口区域、F8、滑动关闭、暂停计时、`aria-live`），store 为模块级单例 + `useSyncExternalStore`（服务端快照为空）；外观为弹层表面（所处表面 +2 级、`shadow-surface-3`、`usePopupShape` 圆角），success 用 `--success` 勾图标、error 用 `--destructive` 标题文字（不做大块彩底）；关闭与 action 为 `Button`；`spring.moderate` 进出场，减少动态效果时只淡入淡出；层级 `--z-toast`；未做 sonner 的折叠卡片堆叠（需要 layout 动画），改为 8px 间距竖排；位置限 `top-center`、`top-right`、`bottom-center`、`bottom-right`；Radix 英文默认文案改为 `labels` 必填；`resetToastsForTesting` 只供测试，不从入口导出 |
| `src/components/popover.tsx` | 无（Fluid 没有 Popover，shadcn `popover` 补缺） | 2026-11 | 结构与 API 取 shadcn（Radix Popover：Trigger / Anchor / Close / Content，另有 Header / Title / Description）；外观与动效沿用本包 Dropdown 弹层：所处表面 +2 级、阴影固定 `shadow-surface-5`（通知弹层设计稿）、`usePopupShape` 圆角、`popupMotionClass` + `spring.fast` 淡入位移，`m as motion` + `MotionFeatures`；Root 始终受控以播放退场动画，退场期间面板 `inert` + `pointer-events-none`；默认 `text-body`、`w-72`、`p-4`、`collisionPadding` 8；Radix Popover 没有 Title，`PopoverTitle` 为 h2，调用方给 id 并在 Content 上传 `aria-labelledby`；点击外部空白处关闭后焦点落到 body 时还给打开前的元素（Radix 只在 Escape 时还给 Trigger） |
| `src/components/sheet.tsx` | 无（shadcn `sheet` 补缺；Fluid 只有左侧 `mobile-drawer`） | 2026-11 | 结构与 API 取 shadcn（Radix Dialog：Trigger / Close / Content / Header / Footer / Title / Description，`side` 四个方向，默认 right）；遮罩、滑入与延迟卸载沿用 Fluid `mobile-drawer`（`spring.moderate`，减少动态效果时去掉位移只保留遮罩淡入淡出）；面板为所处表面 +4 级、阴影 `shadow-surface-5`、`usePopupShape` 圆角，贴边一侧不圆角；bottom 时最高 85dvh、留 safe-area，顶部默认有装饰把手（`handle`）；Content 带 `aria-modal`；`closeLabel` 规则同 DialogContent（显示关闭按钮时必填）；没有 Trigger 的受控用法关闭后把焦点还给打开前的元素；退场期间 `inert`。侧边栏内部的移动抽屉（`SidebarSheet`）暂未改用本组件：它依赖面板自身获得初始焦点、`data-sidebar` / `data-mobile` 属性供 `in-data-[mobile=true]:` 样式使用、宽度来自 Provider 与 `closeOnNavigate`，迁移需要给 Sheet 增加这些扩展点并改动已锁定的侧边栏，收益小 |
| `src/components/dropdown.tsx` | `dropdown` | 2026-11 | 内联 `Dropdown` 面板的键盘焦点环改为 2px 描边加 2px 间隙（上游 1px 紧贴），圆角与行背景同心，去掉颜色字面量回退；未传 `render` 的原生触发按钮补统一焦点环（上游无样式）；触发器先调调用方的 pointer 处理器再调内部的；RadioGroup 无选中时传 `""`；不导出 `useDropdown` / `useDropdownMaybe` / `useHoverControl`，去掉 default export；弹出菜单内仍以高亮行表示焦点（同上游与 Select）；`m as motion` + `MotionFeatures` |
| `src/components/menu-item.tsx` | `dropdown`（附带文件） | 2026-11 | 勾的 `AnimatePresence` 外包 `MotionFeatures`，勾 svg 加 `aria-hidden`；去掉未使用的 `useDropdownMaybe`；tasks 8.3：弹出菜单项新增 `render`（如路由链接），菜单项渲染为该元素以获得链接语义 |
| `src/components/dropdown-search.tsx` | `dropdown`（附带文件） | 2026-11 | `placeholder` 必填（上游 "Search…"），默认兼作搜索框 `aria-label`；`DropdownEmpty` 的 `children` 必填；保持 `type="text"` + `role="searchbox"`（避免 Esc 清空与关闭菜单冲突） |
| `src/components/dropdown-sub.tsx` | `dropdown`（附带文件） | 2026-11 | 仅统一适配规则 |
| `src/components/fluid-hover-highlight.tsx` | `use-fluid-hover`（附带文件） | 2026-11 | 仅统一适配规则（`m as motion` + `MotionFeatures`） |
| `src/components/ui-root.tsx` | `fluid-provider` | 2026-11 | 改名 `UiRoot`，参数 `shape`、`density`、`icons`，取值来自 `template.config.ts` 的 `ui` 段；改为受控（上游为初始值），变化即生效 |
| `src/components/suggestion-chips.tsx` | 无（模板新增，tasks 8.6） | — | 推荐追问按钮组，按 Chat 画板 `.chip`（32px 药丸、内描边）实现；`label` 必填，`showLabel` 时显示为分组标题 |
| `src/components/message-feedback.tsx` | 无（模板新增，tasks 8.6） | — | 点赞 / 点踩（再次点击撤销）、点踩展开文字反馈与可选原因、「修改反馈」再次编辑；乐观更新，`onChange` reject 时回滚；文案经 `labels` 传入；图标直接从 lucide-react 导入（不进 UiRoot 默认图标表） |
| `src/components/embedded-chat.tsx` | 无（模板新增，tasks 8.6） | — | `inline`（≥ md 正文卡片）/ `panel`（≥ md 右侧非模态面板）两种变体，< md 均为悬浮按钮 + 模态底部抽屉（radix-ui `Dialog`，`modal` 随视口切换、打开期间冻结；断点经 `useSyncExternalStore` 读取）；`[data-escape-scope]` 内的 Esc 不关闭；`m as motion` + `MotionFeatures`，减少动态效果时只淡入淡出；没有悬浮按钮的受控用法关闭后把焦点还给打开前的元素 |
| `src/components/insufficient-credits-dialog.tsx` | 无（模板新增，tasks 8.6） | — | 基于 `dialog.tsx`；无 Trigger 的受控用法关闭后把焦点还给打开前的元素；数值显示经 `labels.credits(n)` 由调用方格式化 |
| `src/components/credit-estimate.tsx` | 无（模板新增，tasks 8.6） | — | 预计消耗与余额的单行说明，`estimate={null}` 为估算中占位，`insufficient` 时危险色 |
| `src/components/locked-feature.tsx` | 无（模板新增，tasks 8.6） | — | 会员锁定态卡片；被锁预览 `inert`，并在捕获阶段拦下点击只调用 `onUpgrade` |
| `src/components/daily-claim-notice.tsx` | 无（模板新增，tasks 8.6） | — | 每日领取提示（available / pending / claimed / error），`compact` 为手机顶部样式 |
| `src/hooks/use-fluid-hover.ts` | `use-fluid-hover` | 2026-11 | 仅统一适配规则 |
| `src/hooks/use-merge-split.tsx` | `use-merge-split` | 2026-11 | 仅统一适配规则（`SelectionBackgrounds` 包 `MotionFeatures`）；`bridgePair` 为 `noUncheckedIndexedAccess` 补判空 |
| `src/hooks/use-keyboard-nav-gate.ts` | `use-keyboard-nav-gate` | 2026-11 | 仅统一适配规则 |
| `src/hooks/use-touch-primary.tsx` | `use-touch-primary` | 2026-11 | 仅统一适配规则 |
| `src/lib/elevated.tsx` | `elevated` | 2026-11 | 仅统一适配规则 |
| `src/lib/font-weight.ts` | `font-weight` | 2026-11 | 仅统一适配规则 |
| `src/lib/icon-context.tsx` | `icon-context` | 2026-11 | 图标槽位只保留已接入组件用到的 `x`、`chevron-down`、`chevron-right`、`check`、`circle-alert`、`search`、`plus`、`panel-left`、`panel-right`（上游 70 个全部导入，会随 `UiRoot` 进入首屏包）；接入新组件时按上游槽位名补充 |
| `src/components/reader.tsx`、`src/reader.ts` | 无（模板新增，tasks 8.4） | — | 长文阅读器 `Reader` 与组合件 `ReaderProgress`、`ReaderExportButton`、`useReaderController`（进度与文档信息放在外部 store，进度变化只重渲染进度条）；只经 `@product-res/ui/reader` 子路径导出，不进主入口；目录、吸顶高亮、移动端目录下拉、打印样式；外观按 `docs/design-system/prototypes/ui-review/Reader*.dc.html`；目录与进度图标直接取 lucide（不进入 `UiRoot` 默认图标表），折叠箭头与错误图标用 `chevron-down`、`circle-alert` 槽位 |
| `src/components/reader-markdown.tsx` | 无（模板新增，tasks 8.4） | — | react-markdown + remark-gfm 渲染层（`memo`），`skipHtml` + 元素白名单 + 协议白名单 + 图片策略，脚注文案经 `remarkRehypeOptions` 传入 |
| `src/components/chat-markdown.tsx` | 无（模板新增，add-ai-chat-components 3.2–3.3） | — | 对话回复 Markdown（`ChatMarkdown`，只经 `@product-res/ui/chat` 子路径导出）：与阅读器共用 `lib/markdown.ts` 的 `MARKDOWN_SAFE_OPTIONS`；紧凑对话排版（标题统一 subtitle 粗体，无 id）；图片固定不加载，显示替代文字小标签；外链 `rel="noopener noreferrer nofollow ugc"`；脚注 id 按消息 id 加前缀（含写死的 `footnote-label`）；代码块等宽不高亮，头部为语言名与复制按钮（`role="status"` 播报），代码块与表格为可聚焦的横向滚动区域；流式时按顶层块增量渲染（`splitMarkdownBlocks`），有脚注或引用定义时整段渲染；复制图标直接取 lucide |
| `src/components/pdf-exporter.ts` | 无（模板新增，tasks 8.4） | — | 服务端 PDF 导出扩展点 `registerPdfExporter`（主入口导出）：零依赖模块级注册表 + `useSyncExternalStore`，服务端快照恒为未注册；载荷含 `exportContext` |
| `src/lib/markdown.ts` | 无（模板新增，tasks 8.4） | — | Markdown 元素白名单、链接协议白名单 `safeMarkdownUrl`、图片策略、标题提取与 id 写入（跳过脚注区）；阅读器与对话共用的渲染选项 `MARKDOWN_SAFE_OPTIONS` 与流式按块切分 `splitMarkdownBlocks`（add-ai-chat-components 3.1、3.3） |
| `src/lib/keyboard.ts` | 无（模板新增） | — | 单键快捷键共用判定（`isEditable`、`isInsidePopup`），由 Command Menu 原有的 `isEditable` 抽出 |
| `src/icons.ts` | 无（模板新增） | — | `@product-res/ui/icons` 入口：按名称重导出常用 lucide 图标，供 apps 使用 |
| `src/lib/motion-features.tsx` | 无（模板新增） | — | `LazyMotion features={domAnimation}` 的封装，见统一适配规则 8 |
| `src/lib/omit.ts` | `omit` | 2026-11 | 仅统一适配规则 |
| `src/lib/popup.ts` | `popup` | 2026-11 | 仅统一适配规则 |
| `src/lib/shape-context.tsx` | `shape-context` | 2026-11 | `ShapeProvider` 新增受控 `shape`；rounded 时 `--shape-input-radius` 取 `var(--radius)` |
| `src/lib/size-context.tsx` | `size-context` | 2026-11 | 仅统一适配规则 |
| `src/lib/springs.ts` | `springs` | 2026-11 | 仅统一适配规则 |
| `src/lib/surface-classes.ts` | `surface-classes` | 2026-11 | 仅统一适配规则 |
| `src/lib/surface-context.tsx` | `surface-context` | 2026-11 | 仅统一适配规则 |
| `src/lib/type-scale.ts` | `type-scale` | 2026-11 | 正文 default 14px（上游 13px），与 `--fs-body` 一致 |
| `src/lib/utils.ts` | `utils` | 2026-11 | 保留模板 `cn` 签名；登记类型阶梯类名，不含上游站点专用的 `text-site-*` |
| `src/styles/globals.css` | `tokens`、`surfaces`、`type-scale`、`shape-context`、`scroll-area`、`button`（CSS） | 2026-11 | 语义色取 Fluid 站点 `app/globals.css` 的默认值，基线与预设放在 `@layer base`（brand.css 不分层即可覆盖）；改动：新增 `--primary`（浅 `#171717` / 深 `#f5f5f5`）；`--destructive` 浅色取 red-700（上游 red-500 作文字对比度不足 4.5:1）；`--muted-foreground` 浅 `#6b6b6b` / 深 `#b0b0b0`（上游在 muted 与高层表面上不足 4.5:1）；`--fluid-accent` 浅 `#3b82f6` / 深 `#4f86f7`（焦点环对背景与主按钮 ≥ 3:1）；`--fs-body` 14px（上游 13px）；`--success` 沿用模板原值；`--ring` 指向 `--focus-ring`；新增 `tint` 颜色工具类；4.2 新增 `--primary-text`（强调色作文字，深色 blue/violet/green 预设取 400 号色）、`--switch-thumb-off`、`--z-toast`、`scrollbar-hide` 工具类与 `scroll-divider`；4.1 新增 `--control-border`（`--foreground` 浅 52% / 深 48%，复选框边框与开关关闭轨道对页面、卡片、surface-5、悬停底 ≥ 3:1，白色滑块对其 ≥ 3:1）、`--field-border`（Input / Textarea / Select 触发器共用，默认等于 `--border`）、`--switch-thumb-on`、`--badge-*` 色板 |
| `src/components/thinking-indicator.tsx` | `thinking-indicator` | 2026-11 | openspec add-ai-chat-components：外观按设计稿 `chat-components/States.dc.html` 改为三点 + 文字，上游的圆 ⇄ ∞ 变形图标与轮换英文词不移植，`label` 必填；去掉根节点 `role="status"`（对话页另有只在状态变化时写入的播报区，避免重复朗读）；三点为 CSS 关键帧 `animate-chat-dot`，减少动态效果时 `motion-reduce:animate-none` 静止（SSR 即生效）；上游 `shimmer-text` CSS 未并入（不再使用）；三点 `ThinkingDots` 供 ThinkingStepsHeader 共用；不再使用 motion |
| `src/components/thinking-steps.tsx` | `thinking-steps`（Radix 版） | 2026-11 | openspec add-ai-chat-components：触发按钮按设计稿改为 28px 描边小按钮（13px 次要文字 + 右箭头转 90°），去掉悬停滑块与展开加粗，焦点环 2px 描边加间隙；默认折叠（上游默认展开）；标题文字必填（上游 "Thinking"），新增 `busy`（文字前显示三点）；内容区为左侧 2px 竖线 + 12px 次要文字；`ThinkingStep` 保留步骤接口（`label`、`children`、`status`、`delay`），图标列与连接线不移植；`ThinkingStepDetails` / `Sources` / `Image` 不移植（依赖 Badge 与图片）；`CollapsePanel` 内层样式改由调用方传入（ToolCall 共用），测不到高度时展开到 auto，减少动态效果时高度直接跳到终值；`m as motion` + `MotionFeatures` |
| `src/components/chat-message.tsx` | `chat-message` | 2026-11 | openspec add-ai-chat-components：用户消息为 secondary 底 12px 圆角气泡（上游 accent 混色），助手消息加头像（可传 `avatar` 替换或 `false` 去掉），根节点为查询容器：宽度 ≥ `--container-chat-message`（23rem）时为 28px 头像列 + 内容列，更窄时头像（24px）与新增的 `leading`（推理按钮）同一行、正文与操作区通栏在下（设计稿 Mobile / EmbeddedMobile）；新增 `status`（`streaming` 正文末尾光标，`aborted` / `failed` / `incomplete` / `retrying` 在正文下方显示徽标）、`statusLabel`（结束状态必填）、`statusDetail`；`actions` 始终可见（上游悬停显示）；时间戳 `time` 与附件 `files`（file-thumbnail）不移植；去掉 `layout="position"`（需 domMax），保留入场动效，`entrance={false}` 时不播放；用户气泡底色 `--chat-fill`，宽度与内边距同样按容器查询；流式光标约定为内容区 `data-chat-streaming` + 末段 `data-chat-tail`；长词 `overflow-wrap:anywhere`；`m as motion` + `MotionFeatures` |
| `src/components/input-message.tsx` | `input-message` | 2026-11 | openspec add-ai-chat-components：只保留输入框、自适应高度与发送 / 停止按钮，**删减**附件（拖放、文件选择、file-thumbnail）、生成中排队（queue）、历史上下翻（history）、推荐提示与 Tab 补全（placeholderSuggestion / suggestions）；插槽改名 `leading` / `trailing`，不接受函数形式；`placeholder` 与 `labels`（`message`、`send`、`stop`）必填（上游英文默认值）；`busy` 时同一按钮换成停止，切换时焦点在按钮上则移到输入框；新增 `sendDisabled`（输入可编辑但不发送）与 `textareaRef`；`textareaProps` 先展开，不能覆盖受控值、事件与 `aria-label`；内边距按输入区自身宽度（`@chat-message:` 容器查询）而不是视口；输入法组字（含 Safari keyCode 229）不发送；高度优先用 `field-sizing: content`，不支持时回退上游脚本测量，上限 `max-h-44`（约 8 行）；外观按设计稿（12px 圆角、1px 边框、卡片底与小阴影，32px 按钮，不可用时 muted 底），焦点环画在外框上（上游为边框加深）；`m as motion` + `MotionFeatures` |
| `src/components/tool-call.tsx` | 无（模板新增，openspec add-ai-chat-components design D2） | — | Fluid 没有工具调用组件，状态划分参考 Vercel AI Elements 的 Tool：`pending` / `running` / `done` / `error`，文字经 `labels` 传入；默认不显示参数与结果，传 `children` 时头部才是可折叠按钮（详情区与 ThinkingSteps 共用 `CollapsePanel`）；外观按设计稿 `chat-components/States.dc.html` |
| `src/chat.ts` | 无（模板新增，openspec add-ai-chat-components） | — | `@product-res/ui/chat` 子路径入口：对话组件只在对话路由与 SubjectChat 所在页面加载，不进主入口 |
| `src/styles/globals.css`（对话组件） | 无（模板新增，openspec add-ai-chat-components） | — | 新增 `--warning`（浅 `#8a5a00`（设计稿 `#a16207` 在 10% 淡底上不足 4.5:1，略加深）/ 深 `#fcd34d`，「未完成」状态）与 `--fluid-accent-text`（强调色与正文色 72% / 28% 混合，「执行中」徽标文字，随预设换色）及对应工具类；ChatMessage 版式阈值 `--container-chat-message: 23rem`（`@chat-message:` 容器查询变体）；`--chat-fill`（前景色 6% 半透明，用户气泡、中性徽标与不可用输入框的底色；深色下 `--secondary` 与卡片同色，不用它）；思考中三点的 `animate-chat-dot` 关键帧；流式光标 `[data-chat-streaming] [data-chat-tail]::after`（减少动态效果时不闪烁） |

## 公开接口

`@product-res/ui` 只导出组件、`UiRoot` 与类型；`useShape`、`useSize`、`useIcons`、`SizeProvider` 等上下文接口暂不导出
（随上游月度改名），应用经 `UiRoot` 配置。

## 必须传入的多语言文案（tasks 4.6）

组件不带英文默认文案，类型上要求调用方传入（`apps/web` 中传 `m.*()`）。同一清单见 `docs/design-system.md` §4：

| 组件 | 属性 | 说明 |
|---|---|---|
| `DialogContent` | `closeLabel` | 右上角关闭按钮的可读名称；`showCloseButton={false}` 时不需要 |
| `SelectTrigger` | `placeholder` | 未选择时显示的文字 |
| `AlertDialogAction` / `AlertDialogCancel` | `children` | 按钮文字；标题与说明同样由调用方传入 |
| `Switch` | `label` 或 `aria-label` | 可见标签（同时是可读名称）；不显示标签时传 `aria-label` |
| `Tooltip` | `content` | 提示文字 |
| `ThemeToggle` | `labels` | 模板原有，已由调用方传入 |
| `DataTable` | `labels` | 4.2 起全部必填（去掉英文默认值） |
| `Tabs` / `TabsItem` | `aria-label`（建议） / `label` | `label` 在仅图标时兼作可读名称 |
| `DropdownSearch` / `DropdownEmpty` | `placeholder` / `children` | 占位文字兼作搜索框名称；无结果文字 |
| `ComboboxInput` / `ComboboxChips` | `placeholder`；`clearable` 时 `clearLabel` | 占位文字、清除按钮名称 |
| `ComboboxChips` | `chipsLabel`、`removeLabel(label)` | 已选标签组名称、移除按钮名称 |
| `Combobox` / `ComboboxEmpty` | `onCreate` 时 `createLabel(query)` / `children` | 创建行文字、无匹配文字 |
| `CommandMenu` | `labels` | `placeholder`、`suggestions`、`tabs`、`selectHint`、`tabsHint`、`closeHint` |
| `CommandMenuDialog` | `title` | 对话框可读名称；`description` 可选 |
| `SheetContent` | `closeLabel` | 右上角关闭按钮的可读名称；`showCloseButton={false}` 时不需要 |
| `PopoverTitle` / `SheetTitle` | `children` | 弹层标题（PopoverContent 另传 `aria-labelledby` 指向标题 id） |
| `Toaster` | `labels` | `region`（可含 `{hotkey}`）、`announcement`、`close` |
| `SidebarProvider` | `labels` | `title`（移动抽屉名称）、`expand` / `collapse`（触发按钮）、`rail`、`railResize` / `railCollapse`（拖拽条），`peek` 只在开启 peek 时必传 |
| `SidebarMenuButton` | `status="unread"` 时 `unreadLabel` | 追加的读屏文字；`tooltip` 可选（图标栏收起时的名称） |
| `Reader` | `labels`（`toc`、`progress`、`exportPdf`、`printPdf`、`serverPdf`、`loading`、`footnotes`、`footnoteBack`） | 目录标题、进度条名称、导出按钮、注册服务端导出后的菜单项、加载播报、脚注区标题与返回链接 |
| `ReaderProgress` / `ReaderExportButton` | `label` / `labels`（`exportPdf`、`printPdf`、`serverPdf`） | 外壳顶栏中单独使用时 |
| `ReaderEmpty` / `ReaderError` | `title`；`ReaderError` 显示重试时 `retryLabel` | 空状态与错误状态文字 |
| `SuggestionChips` | `label` | 分组名称（`showLabel` 时可见）；问题文字由调用方传入 |
| `MessageFeedback` | `labels` | `group`、`up`、`down`、`question`、`comment`、`submit`、`cancel`、`edit`、`saved`、`failed`；`commentPlaceholder` 可选 |
| `EmbeddedChat` | `labels` | `trigger`（悬浮按钮）、`title`（面板标题兼可读名称）、`close` |
| `InsufficientCreditsDialog` | `labels` | `title`、`description`、`estimated`、`available`、`credits(n)`、`buyPacks`、`subscribe`、`close`；`shortfall(n)` 可选 |
| `CreditEstimate` | `estimate` / `balance` | 已格式化的文字 |
| `LockedFeature` | `title`、`description`、`actionLabel` | `badge` 可选 |
| `DailyClaimNotice` | `title`、`description`、`labels` | `labels.claim`、`labels.claimed`；传 `onDismiss` 时 `labels.dismiss` |
| `ChatMessage` | 结束状态（`aborted` / `failed` / `incomplete` / `retrying`）时 `statusLabel` | 状态徽标文字；`statusDetail` 可选 |
| `ThinkingIndicator` | `label` | 如「正在思考」 |
| `ThinkingStepsHeader` | `children` | 如「已思考 6 秒」「思考中…」 |
| `ToolCall` | `name`、`labels` | 显示名（未登记的工具传通用文案）；`labels.pending` / `running` / `done` / `error` |
| `InputMessage` | `placeholder`、`labels` | `labels.message`（输入框可读名称）、`send`、`stop` |

## SelectItem 的 `index`（tasks 4.5 评估结论：保留显式传入）

`index` 在渲染期决定悬停高亮（`useFluidHoverSelect(activeStore, i => i === index)`），同时用于 fluid-hover 的
注册与 `data-fluid-hover-index`（焦点、键盘导航按它找行）。自动编号只能在挂载后按 DOM 顺序测量：首帧所有行
没有编号，高亮与已选标记会在第二帧跳到正确行；Select 关闭时 Radix 把选项放在脱离文档的 DocumentFragment 中，
测量时机更难确定；分组（`SelectGroup`）与条件渲染也让 `React.Children` 计数不可靠。因此保留显式 `index`
（从 0 起、跨分组连续编号），在 `SelectItemProps` 的注释中说明。上游若改为自动编号再随月度合并跟进。

## 动效包体积（tasks 4.1 评估 LazyMotion）

2026-11-10 用 esbuild（外置 React、minify、gzip -9）打包 Dialog、AlertDialog、Select、Tooltip、Checkbox、Switch：
`motion.*` 约 119.4 KB，改为 `m.*` + `LazyMotion(domAnimation)` 后约 105.1 KB（−14.2 KB）；单独比较 motion 自身，
`motion` + `AnimatePresence` 48.7 KB，`m` + `LazyMotion` + `domAnimation` + `AnimatePresence` 34.2 KB。
`MotionFeatures` 放在各组件根节点而不是 UiRoot，首页 JS 不变（UiRoot 只含 MotionConfig）。

## 尚未接入

tasks 4.2 已接入 Tabs、Dropdown、Sidebar、Combobox、Command Menu 与 Toast（补缺）。其余 Fluid 组件（accordion、
radio-group、slider、date-picker、mobile-drawer、field 等）与 sidebar 的附加 registry 项（workspace-header、user-footer、
search-field、menu-grid）需要时再按同样规则接入；图标库替换（`icons-tabler` 等）与 `use-merge-split` 需要时再接入；Input 的文件图标与数字步进按钮、
`field`（标签 + 说明 + 错误的组合）待需要时接入。

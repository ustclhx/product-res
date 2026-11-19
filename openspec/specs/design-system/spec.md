# design-system Specification

## Purpose
为模板及其衍生项目提供统一的 UI 分层、设计 token、品牌主题落点、组件覆盖与规范检查，使页面由经确认的设计规范驱动，而不是由开发者或 agent 临时发挥。

## Requirements

### Requirement: 底层交互库只在组件包中使用
底层交互原语与动效库 MUST 只被共享组件包导入；应用与其他包 SHALL 只通过共享组件包使用 UI 组件。工程检查 SHALL 在违反时失败并指出文件与依赖。

#### Scenario: 页面直接导入交互原语
- **WHEN** `apps/web` 中的文件直接导入 Radix、Base UI 或 motion
- **THEN** 依赖检查失败，报告该文件与被导入的包

#### Scenario: 组件包导入交互原语
- **WHEN** 共享组件包导入 Radix 或 motion
- **THEN** 依赖检查通过

### Requirement: 单一交互原语来源
共享组件包 SHALL 只依赖统一的 Radix 包；MUST NOT 同时引入拆分的 Radix 子包，关键 UI 依赖 SHALL 在工作区中只有一个实例。

#### Scenario: 接入外部组件时带入 Radix 子包
- **WHEN** 新接入的组件代码导入拆分的 Radix 子包
- **THEN** 依赖或单例检查失败，要求改为统一包后才能合并

### Requirement: 设计 token 是颜色与尺寸的唯一来源
应用页面的颜色、圆角、字号、间距与阴影 SHALL 取自设计 token 或其对应的工具类；应用源码 MUST NOT 写死颜色值或使用任意值尺寸。UI 规范检查 SHALL 在违反时失败并列出位置。

#### Scenario: 页面写死颜色
- **WHEN** `apps/web` 的组件中出现十六进制、rgb 或 oklch 颜色字面量
- **THEN** UI 规范检查失败并报告文件与行号

#### Scenario: 使用 token 工具类
- **WHEN** 页面使用 `bg-primary`、`text-muted-foreground` 等 token 工具类
- **THEN** UI 规范检查通过

### Requirement: 原生控件与浏览器对话框由组件替代
应用页面 MUST NOT 使用原生 `<select>` 或浏览器 `confirm()` / `alert()`；选择与确认 SHALL 使用共享组件包中的 Select 与确认对话框，后者 SHALL 支持键盘操作、焦点返回与多语言文案。

#### Scenario: 删除前确认
- **WHEN** 用户在后台点击删除
- **THEN** 弹出共享确认对话框，取消后焦点回到删除按钮，且不发起删除请求

#### Scenario: 新增原生 select
- **WHEN** 应用源码新增 `<select>` 元素
- **THEN** UI 规范检查失败

### Requirement: 衍生项目品牌层独立
每个项目 SHALL 有一个品牌 token 文件，覆盖基线 token 中的品牌相关值；该文件在项目生成后归项目所有，模板 MUST NOT 在后续版本中修改它，因此模板同步 MUST NOT 在该文件产生冲突或覆盖项目值。

#### Scenario: 同步模板新版本
- **WHEN** 已修改品牌 token 的衍生项目同步包含组件与基线 token 更新的模板版本
- **THEN** 组件与基线更新被采纳，品牌 token 文件保持项目值且不出现冲突

### Requirement: 项目组件目录
共享组件包 SHALL 预留项目组件目录与独立导出入口，供衍生项目放置可复用的项目组件；模板 MUST NOT 在该目录中创建或修改文件，同步 MUST NOT 在其中产生变更。项目组件 SHALL 受与共享组件相同的依赖边界与 UI 规范检查约束。

#### Scenario: 项目新增通用组件
- **WHEN** 衍生项目在项目组件目录新增一个卡片组件并在页面中经独立导出入口使用
- **THEN** 依赖与 UI 规范检查通过，之后同步模板新版本时该文件不出现在变更或冲突中

### Requirement: 项目根文档属性扩展点
模板 SHALL 创建项目自有的 `features/theme/html-attributes.ts`，之后 MUST NOT 修改它，生成器
SHALL 原样保留。函数 SHALL 接收服务端 host、locale、pathname，并返回额外的根文档属性。
SSR 与预渲染 SHALL 合并过滤后的属性，首次客户端水合 SHALL 复用服务端结果；客户端导航
SHALL 从已渲染的 `<html>` 复用白名单属性，不发起服务端请求或重新计算项目扩展。
需要随路由变化的属性 SHALL 由页面组件处理。仅允许字符串值的 `data-*`、`title`、有效的 `dir` 与 `translate`，MUST NOT
覆盖 `lang` 或 `data-preset`；被拒绝的属性 SHALL 被忽略并记录警告。发布检查 SHALL 拒绝该
项目自有文件在创建之后的修改或删除。

#### Scenario: 项目按站点选择品牌
- **WHEN** 项目函数返回 `{ 'data-site': 'east' }`
- **THEN** SSR 和预渲染 HTML 含 `data-site="east"`，水合时属性不变化且无 mismatch

#### Scenario: 项目返回保留或不安全属性
- **WHEN** 项目尝试返回 `data-preset`、`lang` 或事件等非白名单属性
- **THEN** 文档保留模板属性，忽略被拒绝的属性并记录只含属性名的警告

#### Scenario: 客户端导航复用首屏属性
- **WHEN** 用户在首屏含 `data-site="east"` 的页面中进行客户端导航
- **THEN** 根路由复用已有白名单属性，不请求服务端计算属性，也不重新执行项目扩展函数

### Requirement: 衍生项目不修改模板组件
衍生项目 MUST NOT 直接修改模板提供的共享组件文件；UI 规范检查 SHALL 对照模板随包提供的组件指纹清单，发现差异时失败并提示改用 token、ui 配置、项目组件包装或复制到项目组件目录并登记。模板 SHALL 在每次组件变更时更新指纹清单。

#### Scenario: 项目直接修改模板按钮
- **WHEN** 衍生项目修改模板的 Button 组件文件
- **THEN** UI 规范检查失败，指出该文件与可选的定制方式

#### Scenario: 模板更新组件
- **WHEN** 模板修改 Dialog 组件但未更新指纹清单
- **THEN** 模板自身的检查失败

### Requirement: 项目例外清单
UI 规范检查 SHALL 同时读取模板例外清单与项目例外清单；项目例外清单归项目所有，模板 MUST NOT 修改它，每条例外 MUST 写明文件与原因。

#### Scenario: 插画组件需要固定颜色
- **WHEN** 衍生项目在项目例外清单中登记一个插画组件文件及原因
- **THEN** 该文件的颜色字面量不再导致检查失败，其他文件仍受检查

### Requirement: 主题预设
模板 SHALL 提供多个主题预设（至少包含中性基线与若干强调色和圆角组合），通过模板配置选择；切换预设 MUST NOT 需要修改组件代码。预设 SHALL 同时定义浅色与深色取值，并满足正文文字 WCAG AA 对比度。

#### Scenario: 切换预设
- **WHEN** 项目把模板配置中的主题预设从中性改为另一预设并重新构建
- **THEN** 所有组件的强调色、圆角与焦点环随之变化，浅色和深色下正文对比度不低于 4.5:1

### Requirement: 暗色模式与动效偏好
所有共享组件 SHALL 在浅色、深色与跟随系统三种主题下可用；系统开启减少动态效果时，组件动效 SHALL 降级为无位移的过渡或直接切换。

#### Scenario: 系统开启减少动态效果
- **WHEN** 用户系统设置为减少动态效果并打开带动效的菜单
- **THEN** 菜单不执行弹簧位移动画，直接或淡入显示

### Requirement: 组件预览页
系统 SHALL 提供组件预览页，展示全部共享组件与页面模式的各变体，并可切换主题预设与明暗模式；该页面 MUST 仅在开发与 staging 环境可访问，生产环境 SHALL 返回 404 且不出现在 sitemap 中。

#### Scenario: 生产环境访问预览页
- **WHEN** 访客在生产环境请求组件预览页地址
- **THEN** 返回 404，sitemap 不包含该地址

#### Scenario: 开发环境查看组件
- **WHEN** 开发者在本地打开预览页并切换为深色
- **THEN** 所有组件以深色变体渲染

### Requirement: 营销页性能不因组件升级退化
引入新组件或动效后，营销首页、定价页与博客页的 Lighthouse SEO 与可访问性分数 MUST 不低于变更前水平，且营销页 MUST 仍可在数据库不可用时预渲染。

#### Scenario: 营销区块引入动效组件
- **WHEN** Hero 区块改用带动效的组件
- **THEN** staging 首页 Lighthouse SEO 与可访问性仍为 100，构建期预渲染成功

### Requirement: 设计规范文档与镜像一致
仓库 SHALL 包含设计规范文档，说明分层、token、组件用法、动效与页面模式规则；对外的可视化设计系统镜像 SHALL 以仓库为准，每次 token 或组件规范变更后 SHALL 同步更新镜像，且文档 SHALL 记录镜像地址与最近同步的提交。

#### Scenario: 修改 token 后
- **WHEN** 合并一个修改强调色 token 的 PR
- **THEN** 设计规范文档与镜像中的强调色更新为新值，文档记录的同步提交为该合并提交或之后

### Requirement: 中性填充与品牌强调色分离
共享组件中表达「中性」的填充（如灰色实心徽标）SHALL 使用专门的中性填充 token，MUST NOT 使用品牌层可改写的强调色 token；中性填充上的文字与底色对比度 SHALL 不低于 4.5:1。

#### Scenario: 品牌层改写强调色
- **WHEN** 衍生项目在 `brand.css` 把 `--accent` 设为品牌主色
- **THEN** 灰色实心 Badge 的底色仍为中性填充，文字对比度不变

#### Scenario: 默认主题外观不变
- **WHEN** 模板使用默认主题渲染灰色实心 Badge
- **THEN** 底色与改动前相同

### Requirement: 选择框不撑开所在列
Select 触发器及其外层包装 SHALL 允许收缩到所在列宽度以内，长选项文字 SHALL 截断而不撑开 grid 或 flex 列。

#### Scenario: 窄列中的长选项
- **WHEN** 表单列宽小于选中项文字宽度
- **THEN** 触发器不超出列宽，文字截断显示

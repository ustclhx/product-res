import type { SidebarMenuButtonProps } from '@product-res/ui'
import type { FileRoutesByTo } from '../../routeTree.gen.ts'

// 工作台侧边栏的导航注册表（openspec add-ui-design-system D11、tasks 8.3）。
// 模块在自己的文件里调用 registerAppNav 登记条目，不改布局与路由文件；模板默认条目见 nav.default.ts，
// 项目条目写在项目自有的 nav.project.ts。注册表只是数据，可见性与当前项由下面的纯函数计算，便于单元测试。

/** 侧边栏的固定分组，按此顺序显示；没有可见条目的分组不渲染 */
export const APP_NAV_GROUPS = ['tools', 'content', 'settings'] as const
export type AppNavGroupId = (typeof APP_NAV_GROUPS)[number]

/** 条目链接：生成路由树中 `/app/$slug` 下的路由（`$slug` 由当前空间填入），写错路径时类型检查失败 */
export type AppNavPath = Extract<keyof FileRoutesByTo, '/app/$slug' | `/app/$slug/${string}`>

/** 判断条目是否可见时可用的当前空间信息（权限、只读等） */
export interface AppNavContext {
  role: string
  readOnly: boolean
  isPersonal: boolean
}

export interface AppNavItem {
  /** 唯一标识；重复注册同一 id 时后注册的覆盖先注册的（项目可替换模板条目） */
  id: string
  /** 显示名称；渲染时调用，取当前语言的文案 */
  label: () => string
  icon: NonNullable<SidebarMenuButtonProps['icon']>
  to: AppNavPath
  /** 目标路由要求的查询参数（如分页） */
  search?: Record<string, unknown>
  /** 分组内排序，数值小的在前；相同时按注册先后。@default 100 */
  order?: number
  /** 只在路径完全相同时高亮（工作台首页这类父路径用） */
  exact?: boolean
  /** 可见性：模板开关与角色权限；省略时始终可见 */
  visible?: (context: AppNavContext) => boolean
}

export interface AppNavGroup {
  id: AppNavGroupId
  items: AppNavItem[]
}

interface Registered {
  group: AppNavGroupId
  item: AppNavItem
  sequence: number
}

const registry = new Map<string, Registered>()
let sequence = 0

/** 登记一组导航条目到指定分组 */
export function registerAppNav({ group, items }: { group: AppNavGroupId; items: AppNavItem[] }) {
  for (const item of items) {
    const existing = registry.get(item.id)
    // 覆盖时保留首次注册的先后，替换条目不改变它在分组中的位置
    registry.set(item.id, { group, item, sequence: existing?.sequence ?? sequence++ })
  }
}

/** 移除条目（项目不需要的模板条目） */
export function unregisterAppNav(...ids: string[]) {
  for (const id of ids) registry.delete(id)
}

/** 清空注册表：registry.ts 每次加载先清空再按序登记，热更新后不残留旧条目；测试也用它 */
export function resetAppNav() {
  registry.clear()
  sequence = 0
}

/** 按分组顺序与条目排序返回当前空间可见的导航；空分组省略 */
export function resolveAppNav(context: AppNavContext): AppNavGroup[] {
  const entries = [...registry.values()]
    .filter(({ item }) => item.visible?.(context) ?? true)
    .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100) || a.sequence - b.sequence)
  return APP_NAV_GROUPS.map((id) => ({
    id,
    items: entries.filter((entry) => entry.group === id).map((entry) => entry.item),
  })).filter((group) => group.items.length > 0)
}

/** 条目在当前空间的实际路径 */
export function appNavHref(item: Pick<AppNavItem, 'to'>, slug: string) {
  return item.to.replace('$slug', encodeURIComponent(slug))
}

function trimSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** 当前项：路径相同或位于条目路径之下的条目中，取路径最长的一个；都不匹配时返回 null */
export function activeAppNavId(groups: AppNavGroup[], pathname: string, slug: string) {
  const current = trimSlash(pathname)
  let best: { id: string; length: number } | null = null
  for (const item of groups.flatMap((group) => group.items)) {
    const href = trimSlash(appNavHref(item, slug))
    const matches = item.exact
      ? current === href
      : current === href || current.startsWith(`${href}/`)
    if (matches && (!best || href.length > best.length)) best = { id: item.id, length: href.length }
  }
  return best?.id ?? null
}

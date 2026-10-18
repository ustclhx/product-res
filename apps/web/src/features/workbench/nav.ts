/** 工作台一级导航（docs/plan/selection-workbench.md §12）。不提供评审中心、审批或角色切换。 */
export const WORKBENCH_NAV = [
  { key: 'home', label: '工作台', to: '/app/$slug', exact: true },
  { key: 'follow', label: '跟卖选品', to: '/app/$slug/follow', exact: false },
  { key: 'category', label: '品牌选品', to: '/app/$slug/category', exact: false },
  { key: 'archive', label: '选品档案库', to: '/app/$slug/archive', exact: false },
  { key: 'validation', label: '算法验证', to: '/app/$slug/validation', exact: false },
  { key: 'data', label: '数据中心', to: '/app/$slug/data', exact: false },
  { key: 'config', label: '设置', to: '/app/$slug/config', exact: false },
] as const

export type WorkbenchNavKey = (typeof WORKBENCH_NAV)[number]['key']

/** 按当前路径找出高亮的导航项；未匹配任何业务页面（如空间设置）时返回 null */
export function activeNavKey(pathname: string, slug: string): WorkbenchNavKey | null {
  const base = `/app/${slug}`
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/+$/, '') : null
  if (rest === null) return null
  if (rest === '') return 'home'
  for (const item of WORKBENCH_NAV) {
    if (item.exact) continue
    const segment = item.to.slice('/app/$slug'.length)
    if (rest === segment || rest.startsWith(`${segment}/`)) return item.key
  }
  return null
}

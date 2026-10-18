import type { DataTablePage } from '@product-res/ui'

/**
 * 后台列表页的分页与筛选参数（add-admin-console tasks.md 1.3）：状态放在路由 search 中，
 * 与现有后台页面一致用 `offset` 分页、每页 50 条；筛选值为非空字符串，空值不出现在 URL 中。
 * 路由用 `validateSearch: adminListSearch(['q', 'status'])`，页面把结果交给 `DataTable`。
 */

export const ADMIN_PAGE_SIZE = 50
const MAX_OFFSET = 100_000
const MAX_FILTER_LENGTH = 200

export type AdminListSearch<TFilter extends string> = { offset: number } & Partial<
  Record<TFilter, string>
>

export function adminListSearch<const TFilter extends string>(filters: readonly TFilter[]) {
  return (search: Record<string, unknown>): AdminListSearch<TFilter> => {
    const offset = Math.trunc(Number(search.offset) || 0)
    const result = { offset: Math.min(MAX_OFFSET, Math.max(0, offset)) } as AdminListSearch<TFilter>
    for (const key of filters) {
      const value = search[key]
      const text =
        typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
      if (text) (result as Record<string, unknown>)[key] = text.slice(0, MAX_FILTER_LENGTH)
    }
    return result
  }
}

/** `DataTable` 的分页信息：总数未知时用本页是否满页推断是否还有下一页 */
export function adminListPage(
  offset: number,
  result: { readonly rowCount?: number; readonly hasMore?: boolean },
): DataTablePage {
  return {
    pageIndex: Math.floor(offset / ADMIN_PAGE_SIZE),
    pageSize: ADMIN_PAGE_SIZE,
    ...(result.rowCount === undefined
      ? { hasMore: result.hasMore ?? false }
      : { rowCount: result.rowCount }),
  }
}

export const offsetOfPage = (pageIndex: number) => pageIndex * ADMIN_PAGE_SIZE

/** 提交筛选后的 search：只保留本列表声明的筛选键，并回到第一页 */
export function filtersToSearch<TFilter extends string>(
  filters: readonly TFilter[],
  values: Record<string, string>,
): AdminListSearch<TFilter> {
  return adminListSearch(filters)({ ...values, offset: 0 })
}

import type { DataTableLabels } from '@product-res/ui'
import { m } from '../../paraglide/messages.js'

/** DataTable 的通用文案（DataTable 不带英文默认值，调用方必须传入 labels）；后台列表用 admin/ui.ts 的 adminTableLabels */
export function dataTableLabels(): DataTableLabels {
  return {
    previous: m.common_table_previous(),
    next: m.common_table_next(),
    page: (page, pageCount) =>
      pageCount === null
        ? m.common_table_page({ page })
        : m.common_table_page_of({ page, pageCount }),
    empty: m.common_table_empty(),
    applyFilters: m.common_table_apply(),
    resetFilters: m.common_table_reset(),
    filters: m.common_table_filters(),
    pagination: m.common_table_pagination(),
  }
}

import {
  type ColumnDef,
  type PaginationState,
  type RowData,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { type FormEvent, type ReactNode, useId, useMemo } from 'react'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'
import { Input } from './input.tsx'
import { Label } from './label.tsx'

/**
 * 服务端分页与筛选的通用列表（TanStack Table）。
 *
 * 表格只负责列与行的渲染和分页状态；数据由调用方按 `pageIndex` 与筛选值从服务端取回
 * （manualPagination，不在客户端切分或过滤）。分页与筛选通常放在路由的 search 参数中，
 * 调用方在 `onPageChange` / `onFiltersChange` 中导航即可，刷新与分享链接都保留状态。
 *
 * 总数未知的列表（只知道是否还有下一页）传 `hasMore`，此时只显示当前页码。
 */

const features = tableFeatures({ rowPaginationFeature })

export interface DataTableColumn<TRow> {
  readonly id: string
  readonly header: ReactNode
  readonly cell: (row: TRow) => ReactNode
  readonly className?: string
}

export interface DataTableFilter {
  /** 筛选值的键（与 search 参数一致） */
  readonly id: string
  readonly label: string
  readonly type?: 'text' | 'select'
  /** `type: 'select'` 的选项；空值表示「全部」 */
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly placeholder?: string
}

export interface DataTablePage {
  /** 从 0 开始的页码 */
  readonly pageIndex: number
  readonly pageSize: number
  /** 符合筛选条件的总行数；不知道总数时省略并提供 `hasMore` */
  readonly rowCount?: number
  readonly hasMore?: boolean
}

export interface DataTableLabels {
  readonly previous: string
  readonly next: string
  readonly page: (page: number, pageCount: number | null) => string
  readonly empty: string
  readonly applyFilters: string
  readonly resetFilters: string
  readonly filters: string
  readonly pagination: string
}

const defaultLabels: DataTableLabels = {
  previous: 'Previous',
  next: 'Next',
  page: (page, pageCount) => (pageCount === null ? `Page ${page}` : `Page ${page} of ${pageCount}`),
  empty: 'No records found.',
  applyFilters: 'Apply',
  resetFilters: 'Reset',
  filters: 'Filters',
  pagination: 'Pagination',
}

export interface DataTableProps<TRow extends RowData> {
  /** 表格的无障碍名称 */
  readonly label: string
  readonly columns: readonly DataTableColumn<TRow>[]
  readonly rows: readonly TRow[]
  readonly getRowId: (row: TRow) => string
  readonly page: DataTablePage
  readonly onPageChange: (pageIndex: number) => void
  readonly filters?: readonly DataTableFilter[]
  readonly filterValues?: Readonly<Record<string, string | undefined>>
  /** 提交或重置筛选；调用方应同时回到第一页 */
  readonly onFiltersChange?: (values: Record<string, string>) => void
  readonly labels?: Partial<DataTableLabels>
  readonly className?: string
}

/** 总数未知时用「是否还有下一页」推出一个足以启用「下一页」的行数 */
function knownRowCount(page: DataTablePage, rows: number): number {
  if (page.rowCount !== undefined) return page.rowCount
  return page.pageIndex * page.pageSize + rows + (page.hasMore ? 1 : 0)
}

export function DataTable<TRow extends RowData>(props: DataTableProps<TRow>) {
  const labels = { ...defaultLabels, ...props.labels }
  const { columns: specs, getRowId } = props
  const columns = useMemo<ColumnDef<typeof features, TRow>[]>(
    () =>
      specs.map((spec) => ({
        id: spec.id,
        header: () => spec.header,
        cell: ({ row }) => spec.cell(row.original),
      })),
    [specs],
  )
  const data = useMemo(() => [...props.rows], [props.rows])
  const pagination: PaginationState = {
    pageIndex: props.page.pageIndex,
    pageSize: props.page.pageSize,
  }
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => getRowId(row),
    manualPagination: true,
    rowCount: knownRowCount(props.page, props.rows.length),
    state: { pagination },
    onPaginationChange: (updater) => {
      const next = typeof updater === 'function' ? updater(pagination) : updater
      if (next.pageIndex !== pagination.pageIndex) props.onPageChange(next.pageIndex)
    },
  })
  const classNames = new Map(specs.map((spec) => [spec.id, spec.className]))
  const rows = table.getRowModel().rows
  const pageCount = props.page.rowCount === undefined ? null : Math.max(1, table.getPageCount())

  return (
    <div data-slot="data-table" className={cn('flex flex-col gap-3', props.className)}>
      {props.filters?.length ? (
        <DataTableFilters
          // 筛选值变化（导航）后重新挂载，输入框显示新的值
          key={JSON.stringify(props.filterValues ?? {})}
          filters={props.filters}
          values={props.filterValues ?? {}}
          labels={labels}
          onChange={props.onFiltersChange}
        />
      ) : null}
      <div className="overflow-x-auto rounded-md border">
        <table aria-label={props.label} className="w-full caption-bottom text-sm">
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className={cn(
                      'h-10 px-3 text-left align-middle font-medium text-muted-foreground',
                      classNames.get(header.column.id),
                    )}
                  >
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={specs.length} className="h-16 px-3 text-center text-muted-foreground">
                  {labels.empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                  {row.getAllCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn('px-3 py-2 align-middle', classNames.get(cell.column.id))}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <nav aria-label={labels.pagination} className="flex items-center justify-end gap-3 text-sm">
        <span role="status">{labels.page(props.page.pageIndex + 1, pageCount)}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          {labels.previous}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!table.getCanNextPage()}
          onClick={() => table.nextPage()}
        >
          {labels.next}
        </Button>
      </nav>
    </div>
  )
}

function DataTableFilters(props: {
  readonly filters: readonly DataTableFilter[]
  readonly values: Readonly<Record<string, string | undefined>>
  readonly labels: DataTableLabels
  readonly onChange: ((values: Record<string, string>) => void) | undefined
}) {
  const prefix = useId()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const values: Record<string, string> = {}
    for (const filter of props.filters) {
      const value = String(form.get(filter.id) ?? '').trim()
      if (value) values[filter.id] = value
    }
    props.onChange?.(values)
  }
  return (
    <form
      aria-label={props.labels.filters}
      onSubmit={submit}
      className="flex flex-wrap items-end gap-3"
    >
      {props.filters.map((filter) => {
        const id = `${prefix}-${filter.id}`
        const value = props.values[filter.id] ?? ''
        return (
          <div key={filter.id} className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{filter.label}</Label>
            {filter.type === 'select' ? (
              <select
                id={id}
                name={filter.id}
                defaultValue={value}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs dark:bg-input/30"
              >
                {(filter.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={id}
                name={filter.id}
                defaultValue={value}
                placeholder={filter.placeholder}
                className="w-56"
              />
            )}
          </div>
        )
      })}
      <Button type="submit" size="sm">
        {props.labels.applyFilters}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => props.onChange?.({})}>
        {props.labels.resetFilters}
      </Button>
    </form>
  )
}

export interface DetailField {
  readonly label: string
  readonly value: ReactNode
}

/** 详情页的字段列表（label / value 两列，窄屏时上下排列） */
export function DetailList({
  fields,
  className,
}: {
  readonly fields: readonly DetailField[]
  readonly className?: string
}) {
  return (
    <dl
      data-slot="detail-list"
      className={cn('grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]', className)}
    >
      {fields.map((field) => (
        <div key={field.label} className="contents">
          <dt className="font-medium text-muted-foreground">{field.label}</dt>
          <dd className="break-words">{field.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

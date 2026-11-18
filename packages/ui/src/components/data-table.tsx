import {
  type ColumnDef,
  type PaginationState,
  type RowData,
  rowPaginationFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { type FormEvent, type ReactNode, useId, useMemo } from 'react'
import { useSize } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'
import { Input } from './input.tsx'
import { Label } from './label.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger } from './select.tsx'

/**
 * 服务端分页与筛选的通用列表（TanStack Table）。
 *
 * 表格只负责列与行的渲染和分页状态；数据由调用方按 `pageIndex` 与筛选值从服务端取回
 * （manualPagination，不在客户端切分或过滤）。分页与筛选通常放在路由的 search 参数中，
 * 调用方在 `onPageChange` / `onFiltersChange` 中导航即可，刷新与分享链接都保留状态。
 *
 * 总数未知的列表（只知道是否还有下一页）传 `hasMore`，此时只显示当前页码。
 *
 * 外观吸收 Fluid table / input 的样式（openspec add-ui-design-system tasks 4.2）：表头用 `bg-hover` 底、
 * 行悬停 `bg-hover`，字号与单元格高度跟随 density（`UiRoot`），筛选控件与 Input / Select 同一套边框与焦点环。
 * 公开 API 不变。
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
  /** 全部可读文案，必须由应用按语言传入（tasks 4.2：组件不带英文默认值） */
  readonly labels: DataTableLabels
  readonly className?: string
}

/** 总数未知时用「是否还有下一页」推出一个足以启用「下一页」的行数 */
function knownRowCount(page: DataTablePage, rows: number): number {
  if (page.rowCount !== undefined) return page.rowCount
  return page.pageIndex * page.pageSize + rows + (page.hasMore ? 1 : 0)
}

export function DataTable<TRow extends RowData>(props: DataTableProps<TRow>) {
  const labels = props.labels
  const { columns: specs, getRowId } = props
  // 表格模型只用列 id；表头与单元格内容在渲染时直接调用最新的 spec（函数调用而非组件类型），
  // 调用方每次渲染新建 columns 时单元格不会重新挂载，行内按钮的焦点与确认框的焦点返回都得以保留
  const columnKey = specs.map((spec) => spec.id).join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随列 id 变化重建，内容取渲染时的最新 spec
  const columns = useMemo<ColumnDef<typeof features, TRow>[]>(
    () => specs.map((spec) => ({ id: spec.id })),
    [columnKey],
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
  const specById = new Map(specs.map((spec) => [spec.id, spec]))
  const rows = table.getRowModel().rows
  const pageCount = props.page.rowCount === undefined ? null : Math.max(1, table.getPageCount())
  const size = useSize()
  const compact = size.variant === 'compact'
  // 单元格内边距跟随尺寸阶梯：一行 = 正文行高 + 上下内边距，default 约 36px、compact 约 28px（Fluid table）
  const cellPadding = compact ? 'px-2.5 py-1' : 'px-3 py-2'

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
      <div className="overflow-x-auto rounded-xl border">
        <table aria-label={props.label} className={cn('w-full caption-bottom', size.type.body)}>
          {/* 模板改动（tasks 4.4 余项）：表头底色由 bg-muted/50 改为 Fluid 交互 token bg-hover */}
          <thead className="bg-hover">
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className={cn(
                      'text-left align-middle font-medium text-muted-foreground',
                      cellPadding,
                      specById.get(header.column.id)?.className,
                    )}
                  >
                    {header.isPlaceholder ? null : specById.get(header.column.id)?.header}
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
                <tr
                  key={row.id}
                  className="border-b transition-colors duration-80 last:border-0 hover:bg-hover"
                >
                  {row.getAllCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn(
                        'align-middle',
                        cellPadding,
                        specById.get(cell.column.id)?.className,
                      )}
                    >
                      {specById.get(cell.column.id)?.cell(row.original)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <nav
        aria-label={labels.pagination}
        className={cn('flex items-center justify-end gap-3', size.type.body)}
      >
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
      if (value && value !== EMPTY_OPTION) values[filter.id] = value
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
              // 值变化（重置、前进后退）时重新挂载，非受控的 Select 回显新值
              <FilterSelect key={value} id={id} filter={filter} value={value} />
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

/**
 * Select 的选项值不能为空串（Radix 约定），「全部」等空值选项用占位值代替，提交时还原为空（即不筛选）。
 * 隐藏的原生 select 随表单提交 `name` 对应的值（Radix Select 的表单支持）。
 */
// 以 NUL 开头，不可能与 URL / 表单里的真实筛选值冲突（search 参数不会含 NUL）
const EMPTY_OPTION = '\u0000empty'

function FilterSelect(props: {
  readonly id: string
  readonly filter: DataTableFilter
  readonly value: string
}) {
  const { id, filter, value } = props
  const options = filter.options ?? []
  // 与原生 <select> 一致：没有值且没有空值选项时默认第一项
  const initial =
    value || (options.some((option) => !option.value) ? '' : (options[0]?.value ?? ''))
  return (
    <Select name={filter.id} defaultValue={initial || EMPTY_OPTION}>
      <SelectTrigger
        id={id}
        className="w-56"
        placeholder={filter.placeholder ?? filter.label}
        // SSR 与水合前即显示选中项文字（Select valueLabel，tasks 5.1）
        valueLabel={options.find((option) => option.value === initial)?.label}
      />
      <SelectContent>
        {options.map((option, index) => (
          <SelectItem key={option.value} index={index} value={option.value || EMPTY_OPTION}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
      className={cn('grid gap-x-6 gap-y-2 text-body sm:grid-cols-[12rem_1fr]', className)}
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

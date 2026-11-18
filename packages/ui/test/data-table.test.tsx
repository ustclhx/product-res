import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  DataTable,
  type DataTableColumn,
  type DataTableLabels,
  DetailList,
} from '../src/index.ts'

// 筛选下拉为 Radix Select（tasks 4.2），弹层依赖这些浏览器 API
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

afterEach(cleanup)

// DataTable 不带英文默认文案，调用方必须传入全部 labels（tasks 4.2）
const labels: DataTableLabels = {
  previous: 'Previous',
  next: 'Next',
  page: (page, pageCount) => (pageCount === null ? `Page ${page}` : `Page ${page} of ${pageCount}`),
  empty: 'No records found.',
  applyFilters: 'Apply',
  resetFilters: 'Reset',
  filters: 'Filters',
  pagination: 'Pagination',
}

// add-admin-console tasks.md 1.3：服务端分页与筛选的通用列表

interface Person {
  readonly id: string
  readonly name: string
  readonly role: 'admin' | 'user'
}

const everyone: Person[] = Array.from({ length: 7 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `Person ${i + 1}`,
  role: i % 3 === 0 ? 'admin' : 'user',
}))

const columns: DataTableColumn<Person>[] = [
  { id: 'name', header: 'Name', cell: (row) => row.name },
  { id: 'role', header: 'Role', cell: (row) => row.role },
]

const PAGE_SIZE = 3

/** 模拟服务端：按筛选条件过滤后取一页，返回总数或「是否还有下一页」 */
function serverPage(pageIndex: number, filters: Record<string, string>, withTotal: boolean) {
  const matched = everyone.filter(
    (p) =>
      (!filters.q || p.name.toLowerCase().includes(filters.q.toLowerCase())) &&
      (!filters.role || p.role === filters.role),
  )
  const rows = matched.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)
  return withTotal
    ? { rows, rowCount: matched.length }
    : { rows, hasMore: (pageIndex + 1) * PAGE_SIZE < matched.length }
}

/** 与路由 search 参数等价的受控状态；fetches 记录每次向服务端请求的参数 */
function Harness(props: {
  withTotal?: boolean
  fetches: { pageIndex: number; filters: object }[]
}) {
  const [pageIndex, setPageIndex] = useState(0)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const result = serverPage(pageIndex, filters, props.withTotal ?? true)
  props.fetches.push({ pageIndex, filters })
  return (
    <DataTable
      labels={labels}
      label="People"
      columns={columns}
      rows={result.rows}
      getRowId={(row) => row.id}
      page={{
        pageIndex,
        pageSize: PAGE_SIZE,
        ...('rowCount' in result ? { rowCount: result.rowCount } : { hasMore: result.hasMore }),
      }}
      onPageChange={setPageIndex}
      filters={[
        { id: 'q', label: 'Search' },
        {
          id: 'role',
          label: 'Role',
          type: 'select',
          options: [
            { value: '', label: 'All' },
            { value: 'admin', label: 'Admin' },
            { value: 'user', label: 'User' },
          ],
        },
      ]}
      filterValues={filters}
      onFiltersChange={(values) => {
        setFilters(values)
        setPageIndex(0)
      }}
    />
  )
}

const names = () =>
  within(screen.getByRole('table', { name: 'People' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0]?.textContent)

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

describe('DataTable', () => {
  it('只渲染服务端返回的当前页，翻页时向服务端请求对应页码', () => {
    const fetches: { pageIndex: number; filters: object }[] = []
    render(<Harness fetches={fetches} />)
    expect(names()).toEqual(['Person 1', 'Person 2', 'Person 3'])
    expect(screen.getByRole('status').textContent).toBe('Page 1 of 3')
    expect(button('Previous').disabled).toBe(true)

    fireEvent.click(button('Next'))
    expect(names()).toEqual(['Person 4', 'Person 5', 'Person 6'])
    expect(screen.getByRole('status').textContent).toBe('Page 2 of 3')

    fireEvent.click(button('Next'))
    expect(names()).toEqual(['Person 7'])
    expect(button('Next').disabled).toBe(true)

    fireEvent.click(button('Previous'))
    expect(names()).toEqual(['Person 4', 'Person 5', 'Person 6'])
    expect(fetches.map((f) => f.pageIndex)).toContain(2)
  })

  it('总数未知时按「是否还有下一页」启用翻页', () => {
    render(<Harness withTotal={false} fetches={[]} />)
    expect(screen.getByRole('status').textContent).toBe('Page 1')
    fireEvent.click(button('Next'))
    fireEvent.click(button('Next'))
    expect(names()).toEqual(['Person 7'])
    expect(screen.getByRole('status').textContent).toBe('Page 3')
    expect(button('Next').disabled).toBe(true)
  })

  it('提交筛选时把非空值交给服务端并回到第一页，重置清空筛选', async () => {
    const fetches: { pageIndex: number; filters: object }[] = []
    render(<Harness fetches={fetches} />)
    fireEvent.click(button('Next'))

    // 筛选下拉：键盘打开 Select 并选中 Admin
    const role = screen.getByRole('combobox', { name: 'Role' })
    role.focus()
    fireEvent.keyDown(role, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'Admin' }))
    // 弹层退场结束后其余内容才解除 aria-hidden
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Filters' }))
    })
    expect(fetches.at(-1)).toEqual({ pageIndex: 0, filters: { role: 'admin' } })
    expect(names()).toEqual(['Person 1', 'Person 4', 'Person 7'])
    expect(screen.getByRole('status').textContent).toBe('Page 1 of 1')
    // 筛选值回显在表单中
    expect(screen.getByRole('combobox', { name: 'Role' }).textContent).toContain('Admin')

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: ' person 4 ' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Filters' }))
    })
    expect(fetches.at(-1)).toEqual({ pageIndex: 0, filters: { q: 'person 4', role: 'admin' } })
    expect(names()).toEqual(['Person 4'])

    fireEvent.click(button('Reset'))
    expect(fetches.at(-1)).toEqual({ pageIndex: 0, filters: {} })
    expect(names()).toEqual(['Person 1', 'Person 2', 'Person 3'])
    // 重置后下拉回显「全部」，不再显示旧选项
    const reset = screen.getByRole('combobox', { name: 'Role' })
    expect(reset.textContent).toContain('All')
    expect(reset.textContent).not.toContain('Admin')
  })

  it('没有记录时显示空状态', () => {
    const onPageChange = vi.fn()
    render(
      <DataTable
        label="People"
        columns={columns}
        rows={[]}
        getRowId={(row) => row.id}
        page={{ pageIndex: 0, pageSize: PAGE_SIZE, rowCount: 0 }}
        onPageChange={onPageChange}
        labels={{ ...labels, empty: 'Nobody here.' }}
      />,
    )
    expect(screen.getByText('Nobody here.')).toBeTruthy()
    expect(button('Next').disabled).toBe(true)
    expect(screen.queryByRole('form')).toBeNull()
  })
})

describe('DataTable 单元格身份', () => {
  // 调用方每次渲染都新建 columns（未 useMemo）时，行内按钮不得重新挂载：
  // 否则打开确认框后按钮被替换，关闭时焦点无法回到触发按钮
  function Page() {
    const [pending, setPending] = useState<Person | null>(null)
    const [, setTick] = useState(0)
    const columns: DataTableColumn<Person>[] = [
      { id: 'name', header: 'Name', cell: (row) => row.name },
      {
        id: 'actions',
        header: 'Actions',
        cell: (row) => (
          <button
            type="button"
            onClick={() => {
              setPending(row)
              setTick((n) => n + 1)
            }}
          >
            {`Delete ${row.name}`}
          </button>
        ),
      },
    ]
    return (
      <>
        <DataTable
          labels={labels}
          label="People"
          columns={columns}
          rows={everyone.slice(0, 2)}
          getRowId={(row) => row.id}
          page={{ pageIndex: 0, pageSize: PAGE_SIZE, rowCount: 2 }}
          onPageChange={() => {}}
        />
        <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
          <AlertDialogContent>
            <AlertDialogTitle>Delete?</AlertDialogTitle>
            <AlertDialogDescription>{pending?.name}</AlertDialogDescription>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      </>
    )
  }

  it('columns 每次新建时行内按钮不重新挂载，确认框关闭后焦点回到按钮', async () => {
    render(<Page />)
    const trigger = screen.getByRole('button', { name: 'Delete Person 1' })
    act(() => trigger.focus())
    fireEvent.click(trigger)
    await screen.findByRole('alertdialog')
    // 父组件已重新渲染（新的 columns），同一个 DOM 节点仍在文档中
    expect(screen.getByRole('button', { name: 'Delete Person 1', hidden: true })).toBe(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(trigger.isConnected).toBe(true)
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
})

describe('DetailList', () => {
  it('按顺序渲染字段，空值显示占位符', () => {
    render(
      <DetailList
        fields={[
          { label: 'Email', value: 'ada@example.test' },
          { label: 'Banned', value: null },
        ]}
      />,
    )
    const terms = screen.getAllByRole('term').map((el) => el.textContent)
    const values = screen.getAllByRole('definition').map((el) => el.textContent)
    expect(terms).toEqual(['Email', 'Banned'])
    expect(values).toEqual(['ada@example.test', '—'])
  })
})

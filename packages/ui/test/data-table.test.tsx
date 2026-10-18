import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataTable, type DataTableColumn, DetailList } from '../src/index.ts'

afterEach(cleanup)

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

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'admin' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Filters' }))
    })
    expect(fetches.at(-1)).toEqual({ pageIndex: 0, filters: { role: 'admin' } })
    expect(names()).toEqual(['Person 1', 'Person 4', 'Person 7'])
    expect(screen.getByRole('status').textContent).toBe('Page 1 of 1')
    // 筛选值回显在表单中
    expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('admin')

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: ' person 4 ' } })
    await act(async () => {
      fireEvent.submit(screen.getByRole('form', { name: 'Filters' }))
    })
    expect(fetches.at(-1)).toEqual({ pageIndex: 0, filters: { q: 'person 4', role: 'admin' } })
    expect(names()).toEqual(['Person 4'])

    fireEvent.click(button('Reset'))
    expect(fetches.at(-1)).toEqual({ pageIndex: 0, filters: {} })
    expect(names()).toEqual(['Person 1', 'Person 2', 'Person 3'])
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
        labels={{ empty: 'Nobody here.' }}
      />,
    )
    expect(screen.getByText('Nobody here.')).toBeTruthy()
    expect(button('Next').disabled).toBe(true)
    expect(screen.queryByRole('form')).toBeNull()
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

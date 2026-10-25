import type { TransferPreview } from '@product-res/follow/transfer'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { type StoresData, StoresPage } from '../store-tracking/stores-page.tsx'
import { transferAvailability } from './availability.ts'
import {
  PreviewPanel,
  selectionFor,
  TransferBar,
  type TransferSelectionState,
  targetLabel,
} from './transfer-actions.tsx'

// add-workspace-data-transfer tasks 6.2：列表多选按钮的显示条件、选择内容与预览展示。
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => <a href="/app">{children as never}</a>,
  useNavigate: () => () => Promise.resolve(),
}))

const on = { tenancy: { multiTenant: true, dataTransfer: true } }
const ctx = (
  role: string,
  isPersonal = false,
  extra: { readOnly?: boolean; own?: boolean } = {},
) => ({
  user: { id: 'u1' },
  workspace: { id: isPersonal && extra.own !== false ? 'u1' : 'w1', isPersonal },
  member: { role },
  workspaceReadOnly: extra.readOnly ?? false,
})

describe('复制 / 移动的显示条件（D6）', () => {
  it('团队空间：owner 可复制与移动，admin 只能复制，member 都不能', () => {
    expect(transferAvailability(ctx('owner'), on)).toEqual({ copy: true, move: true })
    expect(transferAvailability(ctx('admin'), on)).toEqual({ copy: true, move: false })
    expect(transferAvailability(ctx('member'), on)).toEqual({ copy: false, move: false })
  })

  it('个人空间只能由本人发起；只读、流转中、开关关闭或 multiTenant=false 时都隐藏', () => {
    expect(transferAvailability(ctx('owner', true), on)).toEqual({ copy: true, move: true })
    expect(transferAvailability(ctx('owner', true, { own: false }), on)).toEqual({
      copy: false,
      move: false,
    })
    expect(transferAvailability(ctx('owner', false, { readOnly: true }), on)).toEqual({
      copy: false,
      move: false,
    })
    expect(
      transferAvailability(ctx('owner'), { tenancy: { multiTenant: true, dataTransfer: false } }),
    ).toEqual({ copy: false, move: false })
    expect(
      transferAvailability(ctx('owner'), { tenancy: { multiTenant: false, dataTransfer: true } }),
    ).toEqual({ copy: false, move: false })
  })
})

const fakeSelection = (ids: string[]): TransferSelectionState => ({
  selected: new Set(ids),
  has: (id) => ids.includes(id),
  toggle: () => {},
  setAll: () => {},
  clear: () => {},
  allSelected: false,
})

describe('操作条与选择内容', () => {
  it('没有选中时不显示；选中后只显示可用的操作', () => {
    const none = renderToStaticMarkup(
      <TransferBar
        slug="s"
        root="direction"
        availability={{ copy: true, move: true }}
        selection={fakeSelection([])}
      />,
    )
    expect(none).toBe('')
    const admin = renderToStaticMarkup(
      <TransferBar
        slug="s"
        root="direction"
        availability={{ copy: true, move: false }}
        selection={fakeSelection(['a', 'b'])}
      />,
    )
    expect(admin).toContain('已选 2 项')
    expect(admin).toContain('复制到空间…')
    expect(admin).not.toContain('移动到空间…')
  })

  it('方向与档案带冲突策略，其余根条目不带', () => {
    expect(selectionFor('direction', ['a'], 'merge')).toEqual({
      roots: { direction: ['a'] },
      conflicts: { direction: 'merge' },
    })
    expect(selectionFor('decision', ['d'], 'rename')).toEqual({
      roots: { decision: ['d'] },
      conflicts: { direction: 'rename' },
    })
    expect(selectionFor('store', ['s'], 'merge')).toEqual({ roots: { store: ['s'] } })
  })

  it('目标空间标签区分个人空间与角色', () => {
    expect(targetLabel({ id: '1', name: '我', slug: 'me', isPersonal: true, role: 'owner' })).toBe(
      '我（个人空间） · 所有者',
    )
    expect(
      targetLabel({ id: '2', name: 'Team', slug: 't', isPersonal: false, role: 'admin' }),
    ).toBe('Team · 管理员')
  })
})

describe('预览展示', () => {
  const preview: TransferPreview = {
    kind: 'copy',
    sourceName: '个人',
    targetName: '团队',
    roots: { decision: 1 },
    tables: { direction: 1, cluster: 2, lead: 1 },
    total: 4,
    conflicts: [
      {
        table: 'direction',
        sourceId: 'x',
        label: '万圣节',
        action: 'rename',
        newName: '万圣节（来自 个人）',
      },
      { table: 'tracked_store', sourceId: 'y', label: 'shop', action: 'merge', targetId: 'z' },
    ],
    scoringVersions: [1, 3],
    quota: { additionalBrowseCallsPerDay: 30, threshold: 20, exceeds: true },
    rowLimit: 50_000,
    tooLarge: false,
    directionsFollowLeads: true,
  }

  it('按表行数、冲突处理、评分版本、方向随线索复制与外部额度提示', () => {
    const html = renderToStaticMarkup(<PreviewPanel preview={preview} />)
    expect(html).toContain('预览：个人 → 团队')
    expect(html).toContain('共 4 行数据')
    expect(html).toContain('商品簇')
    expect(html).toContain('重命名为“万圣节（来自 个人）”')
    expect(html).toContain('合并到目标已有的同一条')
    expect(html).toContain('v1, v3')
    expect(html).toContain('所属方向在目标中复制一份')
    expect(html).toContain('预计每天新增约 30 次 eBay Browse 调用')
    expect(html).toContain('影子验证样本')
    expect(html).not.toContain('超过上限')
  })

  it('复制超过行数上限时提示缩小范围', () => {
    const html = renderToStaticMarkup(
      <PreviewPanel preview={{ ...preview, total: 60_000, tooLarge: true }} />,
    )
    expect(html).toContain('超过上限 50000 行')
  })
})

describe('店铺追踪页的多选', () => {
  const base: StoresData = {
    day: '2031-06-20',
    stores: [],
    removedCount: 0,
    directions: [],
    sources: {},
    disabledSources: [],
    canWrite: true,
    roundAvailable: false,
    trackedProducts: null,
    transfer: { copy: false, move: false },
  }

  it('流转可用时显示追踪商品列表与多选框；不可用时都不显示', () => {
    const enabled = renderToStaticMarkup(
      <StoresPage
        slug="s"
        initial={{
          ...base,
          transfer: { copy: true, move: false },
          trackedProducts: {
            rows: [
              {
                id: 'p1',
                productId: 'mp1',
                title: 'Pumpkin lamp',
                marketplace: 'ebay-us',
                url: null,
                tier: 'hot',
                origin: 'store',
                lastSnapshotOn: '2031-06-19',
              },
            ],
            truncated: false,
          },
        }}
      />,
    )
    expect(enabled).toContain('追踪商品')
    expect(enabled).toContain('Pumpkin lamp')
    expect(enabled).toContain('data-testid="transfer-select"')
    const disabled = renderToStaticMarkup(<StoresPage slug="s" initial={base} />)
    expect(disabled).not.toContain('data-testid="transfer-select"')
    expect(disabled).not.toContain('Pumpkin lamp')
  })
})

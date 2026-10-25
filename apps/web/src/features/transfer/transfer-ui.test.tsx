import { FLOWING_TRANSFER_TABLES } from '@product-res/follow/transfer'
import { AppError } from '@product-res/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { AdminWorkspaceTransfers } from './admin-transfers.tsx'
import { TransferBanner } from './banner.tsx'
import { transferErrorAdapter } from './error-adapter.ts'
import { batchLabel, groupTableCounts, TRANSFER_TABLES, transferErrorText } from './labels.ts'
import {
  countRows,
  type TransferDetail,
  TransferDetailView,
  transferActions,
  unmappedEntries,
} from './transfer-detail.tsx'
import {
  newIdempotencyKey,
  type UpgradePreview,
  UpgradePreviewBody,
  upgradeCardVisible,
  upgradeSubmitter,
} from './upgrade-card.tsx'

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  Link: ({ children, to, params }: { children: unknown; to: string; params?: object }) => (
    <a href={`${to}#${JSON.stringify(params ?? {})}`}>{children as never}</a>
  ),
  useRouter: () => ({ navigate: async () => {}, invalidate: async () => {} }),
}))

const userId = '0190a000-0000-7000-8000-0000000000aa'
const page = {
  multiTenant: true,
  user: { id: userId, name: 'U', email: 'u@example.com' },
  workspace: { id: userId, name: 'Personal', slug: 'u-abc', isPersonal: true },
}

describe('升级卡片显示条件', () => {
  it('仅开关开启、多租户、本人个人空间时显示', () => {
    expect(upgradeCardVisible(page, true)).toBe(true)
    expect(upgradeCardVisible(page, false)).toBe(false)
    expect(upgradeCardVisible({ ...page, multiTenant: false }, true)).toBe(false)
    expect(
      upgradeCardVisible({ ...page, workspace: { ...page.workspace, isPersonal: false } }, true),
    ).toBe(false)
    // 个人空间 id 必须等于用户 id（他人的个人空间不会出现在自己的列表中，这里防御性校验）
    expect(
      upgradeCardVisible({ ...page, workspace: { ...page.workspace, id: 'someone-else' } }, true),
    ).toBe(false)
  })
})

const preview: UpgradePreview = {
  eligible: true,
  reasons: [],
  tables: { direction: 2, lead: 5, tracked_store: 1, cost_param: 3, scoring_setting: 0 },
  total: 11,
  stays: {
    credits: { available: 120, held: 5 },
    subscriptions: 1,
    aiConversations: 4,
    files: 2,
    apiKeys: 1,
    auditLogs: 9,
  },
  targetRequiresActivation: true,
  maxWorkspacesPerUser: 5,
  teamWorkspaces: 1,
}

describe('升级预览', () => {
  it('列出随迁移的分组条数、留在个人空间的内容与新空间需开通提示', () => {
    const html = renderToStaticMarkup(<UpgradePreviewBody preview={preview} />)
    expect(html).toContain(m.transfer_group_direction())
    expect(html).toContain(m.transfer_table_lead())
    expect(html).toContain(m.transfer_group_store_pool())
    expect(html).toContain(m.transfer_upgrade_moves_total({ total: '11' }))
    // 行数为 0 的表不列出
    expect(html).not.toContain(m.transfer_table_scoring_setting())
    expect(html).toContain(m.transfer_upgrade_stays_credits({ available: '120', held: '5' }))
    expect(html).toContain(m.transfer_upgrade_stays_ai({ count: '4' }))
    expect(html).toContain(m.transfer_upgrade_stays_files({ count: '2' }))
    expect(html).toContain(m.transfer_upgrade_stays_api_keys({ count: '1' }))
    expect(html).toContain(m.transfer_upgrade_stays_audit({ count: '9' }))
    expect(html).toContain(m.transfer_upgrade_stays_subscriptions({ count: '1' }))
    expect(html).toContain('data-testid="upgrade-activation"')
    expect(html).toContain(m.transfer_upgrade_api_key_notice())
  })

  it('不满足条件时列出原因；不需开通时不显示开通提示', () => {
    const html = renderToStaticMarkup(
      <UpgradePreviewBody
        preview={{
          ...preview,
          eligible: false,
          reasons: ['WORKSPACE_LIMIT', 'TRANSFER_IN_PROGRESS'],
          teamWorkspaces: 5,
          targetRequiresActivation: false,
          stays: { ...preview.stays, credits: null, apiKeys: 0 },
        }}
      />,
    )
    expect(html).toContain(m.transfer_upgrade_reason_limit({ count: '5', max: '5' }))
    expect(html).toContain(m.transfer_upgrade_reason_in_progress())
    expect(html).not.toContain('data-testid="upgrade-activation"')
    expect(html).toContain(m.transfer_upgrade_stays_credits_disabled())
  })

  it('同一次打开的重复提交沿用同一幂等键，再次打开生成新键', async () => {
    const calls: { idempotencyKey: string; newSlug: string; name: string }[] = []
    const start = vi.fn(async ({ data }: { data: (typeof calls)[number] }) => {
      calls.push(data)
      if (calls.length === 1) throw new Error('network')
      return { transferId: 't', sourceWorkspaceId: 's', targetWorkspaceId: 'g' }
    })
    const key = newIdempotencyKey()
    const submit = upgradeSubmitter(start as never, 'u-abc', key)
    await expect(submit({ name: ' Team ', slug: 'team' })).rejects.toThrow('network')
    await submit({ name: 'Team', slug: 'team' })
    expect(calls.map((c) => c.idempotencyKey)).toEqual([key, key])
    expect(calls[0]).toMatchObject({ name: 'Team', newSlug: 'team', slug: 'u-abc' })
    expect(newIdempotencyKey()).not.toBe(key)
  })
})

const detail = (overrides: Partial<TransferDetail> = {}): TransferDetail => ({
  id: '0190a000-0000-7000-8000-0000000000t1',
  kind: 'upgrade',
  status: 'running',
  sourceWorkspaceId: userId,
  targetWorkspaceId: '0190a000-0000-7000-8000-0000000000bb',
  sourceName: 'Personal',
  targetName: 'Team',
  requestedBy: userId,
  requestedByName: 'U',
  errorCode: null,
  createdAt: '2031-06-01T00:00:00.000Z',
  startedAt: '2031-06-01T00:00:01.000Z',
  finishedAt: null,
  progress: { done: 2, compensated: 0, total: 4 },
  counts: {
    direction: { moved: 2 },
    tracked_store: { copied: 1, 'unmapped:direction_ids': 3 },
  },
  plannedTables: { direction: 2, tracked_store: 1, lead: 5 },
  batches: [
    { key: 'config', seq: 1, status: 'done', counts: {} },
    { key: 'direction:0190a000-0000-7000-8000-00000000d1d1', seq: 2, status: 'done', counts: {} },
    { key: 'store-pool', seq: 3, status: 'pending', counts: {} },
  ],
  conflicts: [
    {
      table: 'direction',
      sourceId: 'd1',
      label: '万圣节装饰',
      action: 'rename',
      newName: '万圣节装饰 (2)',
    },
  ],
  skipped: [{ table: 'tracked_product', sourceId: 'p1', action: 'skipped', label: 'Mug' }],
  renamed: [
    {
      table: 'direction',
      sourceId: 'd1',
      action: 'renamed',
      label: '万圣节装饰',
      newName: '万圣节装饰 (2)',
    },
  ],
  quota: null,
  ...overrides,
})

const owner = { userId, role: 'owner' }
const member = { userId: 'other', role: 'member' }

describe('流转详情', () => {
  it('取消只在排队 / 进行中，续跑在全部进行中状态；只给发起人或 owner', () => {
    const t = { requestedBy: userId }
    expect(transferActions({ ...t, status: 'pending' }, owner)).toEqual({
      cancel: true,
      retry: true,
    })
    expect(transferActions({ ...t, status: 'running' }, owner)).toEqual({
      cancel: true,
      retry: true,
    })
    expect(transferActions({ ...t, status: 'compensating' }, owner)).toEqual({
      cancel: false,
      retry: true,
    })
    for (const status of ['completed', 'compensated'] as const)
      expect(transferActions({ ...t, status }, owner)).toEqual({ cancel: false, retry: false })
    expect(transferActions({ ...t, status: 'running' }, member)).toEqual({
      cancel: false,
      retry: false,
    })
    // 发起人即使是 member 也可以管理自己的流转
    expect(
      transferActions({ requestedBy: 'other', status: 'running' }, { ...member, role: 'admin' }),
    ).toEqual({ cancel: true, retry: true })
    expect(transferActions({ ...t, status: 'running' }, null)).toEqual({
      cancel: false,
      retry: false,
    })
  })

  it('进行中显示进度、按表计数、冲突 / 跳过 / 重命名 / 未映射清单与操作按钮', () => {
    const html = renderToStaticMarkup(<TransferDetailView detail={detail()} viewer={owner} />)
    expect(html).toContain(m.transfer_status_running())
    expect(html).toContain(m.transfer_progress_batches({ done: '2', total: '4' }))
    expect(html).toContain(m.transfer_table_lead())
    expect(html).toContain(m.transfer_detail_conflict_rename({ name: '万圣节装饰 (2)' }))
    expect(html).toContain('Mug')
    expect(html).toContain(
      m.transfer_detail_unmapped_row({
        table: m.transfer_table_tracked_store(),
        column: 'direction_ids',
        count: '3',
      }),
    )
    expect(html).toContain(m.transfer_action_cancel())
    expect(html).toContain(m.transfer_action_retry())
    expect(html).toContain(m.transfer_detail_readonly_banner())
  })

  it('已回滚显示失败原因文案，没有操作按钮；取消显示为“已取消”', () => {
    const failed = renderToStaticMarkup(
      <TransferDetailView
        detail={detail({ status: 'compensated', errorCode: 'TRANSFER_PERMISSION_REVOKED' })}
        viewer={owner}
      />,
    )
    expect(failed).toContain(m.transfer_status_compensated())
    expect(failed).toContain(m.transfer_error_permission_revoked())
    expect(failed).toContain(m.transfer_detail_upgrade_compensated_hint())
    expect(failed).not.toContain(m.transfer_action_cancel())
    expect(failed).not.toContain(m.transfer_action_retry())
    const cancelled = renderToStaticMarkup(
      <TransferDetailView
        detail={detail({ status: 'compensated', errorCode: 'TRANSFER_CANCELLED' })}
        viewer={owner}
      />,
    )
    expect(cancelled).toContain(m.transfer_status_cancelled())
  })

  it('升级完成提供进入新团队空间的入口', () => {
    const html = renderToStaticMarkup(
      <TransferDetailView
        detail={detail({ status: 'completed', progress: { done: 4, compensated: 0, total: 4 } })}
        viewer={owner}
        onOpenTarget={() => {}}
      />,
    )
    expect(html).toContain(m.transfer_detail_completed_upgrade())
    expect(html).toContain(m.transfer_detail_open_target())
  })

  it('计数合并计划行数与 unmapped 键', () => {
    const rows = countRows(detail())
    expect(rows.find((r) => r.table === 'tracked_store')).toEqual({
      table: 'tracked_store',
      planned: 1,
      actions: { copied: 1 },
      unmapped: 3,
    })
    expect(rows.find((r) => r.table === 'lead')?.planned).toBe(5)
    expect(unmappedEntries(detail().counts)).toEqual([
      { table: 'tracked_store', column: 'direction_ids', count: 3 },
    ])
  })

  it('后台只读：列表与详情都不提供取消或续跑', () => {
    const html = renderToStaticMarkup(
      <AdminWorkspaceTransfers workspaceId={userId} transfers={[detail()]} />,
    )
    expect(html).toContain(m.transfer_list_title())
    expect(html).toContain(m.transfer_status_running())
    expect(html).not.toContain(m.transfer_action_cancel())
    const view = renderToStaticMarkup(<TransferDetailView detail={detail()} viewer={null} />)
    expect(view).not.toContain(m.transfer_action_cancel())
    expect(view).not.toContain(m.transfer_action_retry())
  })
})

describe('只读横幅', () => {
  it('流转中显示；有权查看时链接到进度页', () => {
    const transfer = { id: 't1', kind: 'upgrade' as const, status: 'running' as const }
    expect(renderToStaticMarkup(<TransferBanner page={{ ...page, transfer: null }} />)).toBe('')
    const html = renderToStaticMarkup(
      <TransferBanner page={{ ...page, transfer: { ...transfer, viewable: true } }} />,
    )
    expect(html).toContain(m.transfer_banner({ kind: m.transfer_kind_upgrade() }))
    expect(html).toContain('/app/$slug/settings/transfers/$transferId')
    expect(html).toContain('&quot;transferId&quot;:&quot;t1&quot;')
    const hidden = renderToStaticMarkup(
      <TransferBanner page={{ ...page, transfer: { ...transfer, viewable: false } }} />,
    )
    expect(hidden).toContain('data-testid="transfer-banner"')
    expect(hidden).not.toContain('href=')
  })
})

describe('文案与错误码', () => {
  it('注册表中的每张流转表都有文案与分组', () => {
    const missing = FLOWING_TRANSFER_TABLES.map((t) => t.name).filter((n) => !TRANSFER_TABLES[n])
    expect(missing).toEqual([])
    for (const entry of FLOWING_TRANSFER_TABLES)
      expect(TRANSFER_TABLES[entry.name]?.group).toBe(entry.batch)
  })

  it('error_code 映射本地化文案，未知码带码显示', () => {
    expect(transferErrorText('TRANSFER_TIMEOUT')).toBe(m.transfer_error_timeout())
    expect(transferErrorText('SLUG_TAKEN')).toBe(m.workspace_error_slug_taken())
    expect(transferErrorText('X_UNKNOWN')).toBe(m.transfer_error_unknown({ code: 'X_UNKNOWN' }))
  })

  it('批次键与分组汇总', () => {
    expect(batchLabel('config')).toBe(m.transfer_batch_family_config())
    expect(batchLabel('direction:0190a000-0000-7000-8000-00000000d1d1#2')).toBe(
      `${m.transfer_table_direction()} · 00d1d1 #2`,
    )
    expect(groupTableCounts({ lead: 2, direction: 1, tracked_store: 0 })).toEqual([
      {
        group: 'direction',
        total: 3,
        tables: [
          { table: 'lead', count: 2 },
          { table: 'direction', count: 1 },
        ],
      },
    ])
  })

  it('RPC 往返保留流转错误码，不序列化 details', () => {
    const original = new AppError('SLUG_TAKEN', 'Slug already in use', {
      status: 400,
      details: { internal: 'x' },
    })
    expect(transferErrorAdapter.test(original)).toBe(true)
    const wire = JSON.stringify(transferErrorAdapter.toSerializable(original))
    expect(wire).not.toContain('internal')
    expect(transferErrorAdapter.fromSerializable(JSON.parse(wire))).toMatchObject({
      code: 'SLUG_TAKEN',
      status: 400,
    })
    expect(transferErrorAdapter.test(new AppError('WORKSPACE_TRANSFERRING', 'x'))).toBe(false)
    expect(transferErrorAdapter.test(new Error('x'))).toBe(false)
  })
})

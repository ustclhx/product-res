import { DataTable, type DataTableColumn } from '@product-res/ui'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { formatUtc, kindLabel } from './labels.ts'
import {
  progressText,
  TransferStatusTag,
  type TransferSummary,
  workspaceName,
} from './transfer-detail.tsx'

/** 流转记录列表（空间设置与 /admin/workspaces 共用）；记录最多 50 条，单页展示 */
export function TransferList({
  transfers,
  action,
}: {
  transfers: readonly TransferSummary[]
  /** 每行的查看入口：空间页为链接，后台为展开详情的按钮 */
  action: (transfer: TransferSummary) => ReactNode
}) {
  const columns: DataTableColumn<TransferSummary>[] = [
    { id: 'kind', header: m.transfer_col_kind(), cell: (t) => kindLabel(t.kind) },
    {
      id: 'route',
      header: m.transfer_col_route(),
      className: 'min-w-[180px]',
      cell: (t) => `${workspaceName(t.sourceName)} → ${workspaceName(t.targetName)}`,
    },
    {
      id: 'status',
      header: m.transfer_col_status(),
      cell: (t) => <TransferStatusTag transfer={t} />,
    },
    {
      id: 'progress',
      header: m.transfer_col_progress(),
      cell: (t) => <span className="font-mono text-xs">{progressText(t)}</span>,
    },
    {
      id: 'requester',
      header: m.transfer_col_requester(),
      cell: (t) => t.requestedByName ?? t.requestedBy,
    },
    {
      id: 'created',
      header: m.transfer_col_created(),
      className: 'whitespace-nowrap',
      cell: (t) => formatUtc(t.createdAt),
    },
    { id: 'actions', header: m.transfer_col_actions(), cell: action },
  ]
  return (
    <DataTable
      label={m.transfer_list_label()}
      columns={columns}
      rows={transfers}
      getRowId={(t) => t.id}
      page={{ pageIndex: 0, pageSize: Math.max(1, transfers.length), rowCount: transfers.length }}
      onPageChange={() => {}}
      labels={{
        empty: m.transfer_list_empty(),
        previous: m.transfer_table_previous(),
        next: m.transfer_table_next(),
        page: (page, pageCount) =>
          m.transfer_table_page({ page: String(page), pageCount: String(pageCount ?? page) }),
      }}
    />
  )
}

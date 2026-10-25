import { Button } from '@product-res/ui'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { AdminSection } from '../admin/ui.tsx'
import { transferActionError } from './labels.ts'
import { getAdminWorkspaceTransfer } from './transfer.functions.ts'
import {
  type TransferDetail,
  TransferDetailView,
  type TransferSummary,
} from './transfer-detail.tsx'
import { TransferList } from './transfer-list.tsx'

/**
 * /admin/workspaces 详情的流转记录（tasks 6.3，design D6、D11）：只读，不提供取消 / 续跑等代操作。
 */
export function AdminWorkspaceTransfers({
  workspaceId,
  transfers,
}: {
  workspaceId: string
  transfers: readonly TransferSummary[]
}) {
  const [detail, setDetail] = useState<TransferDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function view(transferId: string) {
    setBusy(true)
    setError('')
    try {
      setDetail(await getAdminWorkspaceTransfer({ data: { id: workspaceId, transferId } }))
    } catch (e) {
      setError(transferActionError(e, m.transfer_detail_refresh_failed()))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AdminSection title={m.transfer_list_title()}>
      <TransferList
        transfers={transfers}
        action={(t) => (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-pressed={detail?.id === t.id}
            onClick={() => void (detail?.id === t.id ? setDetail(null) : view(t.id))}
          >
            {detail?.id === t.id ? m.transfer_close() : m.transfer_view()}
          </Button>
        )}
      />
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {detail ? <TransferDetailView detail={detail} viewer={null} /> : null}
    </AdminSection>
  )
}

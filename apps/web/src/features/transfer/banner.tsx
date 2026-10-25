import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import type { WorkspacePage } from '../workspace/components.tsx'
import { kindLabel } from './labels.ts'

/**
 * 流转中只读横幅（add-workspace-data-transfer tasks 6.3）：getWorkspacePage 在 workspaceTransferring
 * 为真时返回 transfer；有权查看详情时链接到进度页。
 */
export function TransferBanner({ page }: { page: Pick<WorkspacePage, 'transfer' | 'workspace'> }) {
  const transfer = page.transfer
  if (!transfer) return null
  return (
    <div
      role="status"
      data-testid="transfer-banner"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/30 bg-warning-soft px-5 py-2 text-[13px] text-warning-strong"
    >
      <span>{m.transfer_banner({ kind: kindLabel(transfer.kind) })}</span>
      {transfer.viewable ? (
        <Link
          to="/app/$slug/settings/transfers/$transferId"
          params={{ slug: page.workspace.slug, transferId: transfer.id }}
          className="font-medium underline"
        >
          {m.transfer_banner_link()}
        </Link>
      ) : null}
    </div>
  )
}

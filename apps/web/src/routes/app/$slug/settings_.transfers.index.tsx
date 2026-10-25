import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { isActiveTransfer } from '../../../features/transfer/labels.ts'
import { usePolling } from '../../../features/transfer/polling.ts'
import { getWorkspaceTransfers } from '../../../features/transfer/transfer.functions.ts'
import { TransferList } from '../../../features/transfer/transfer-list.tsx'
import { m } from '../../../paraglide/messages.js'

/** 空间设置下的“数据流转记录”（add-workspace-data-transfer tasks 6.3）；开关关闭时仍可查看已有记录 */
export const Route = createFileRoute('/app/$slug/settings_/transfers/')({
  loader: ({ params }) => getWorkspaceTransfers({ data: { slug: params.slug } }),
  staleTime: 0,
  component: TransfersPage,
})

function TransfersPage() {
  const initial = Route.useLoaderData()
  const { slug } = Route.useParams()
  const [transfers, setTransfers] = useState(initial)
  usePolling(
    transfers.some((t) => isActiveTransfer(t.status)),
    async () => {
      try {
        setTransfers(await getWorkspaceTransfers({ data: { slug } }))
      } catch {
        // 下一轮继续
      }
    },
    5000,
  )
  return (
    <div className="grid max-w-5xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-lg">{m.transfer_list_title()}</h1>
        <Link
          to="/app/$slug/settings"
          params={{ slug }}
          className="text-muted-foreground text-sm hover:text-foreground"
        >
          {m.transfer_list_back()}
        </Link>
      </div>
      <p className="text-muted-foreground text-xs">{m.transfer_list_hint()}</p>
      <TransferList
        transfers={transfers}
        action={(t) => (
          <Link
            to="/app/$slug/settings/transfers/$transferId"
            params={{ slug, transferId: t.id }}
            className="text-primary text-[13px] underline-offset-4 hover:underline"
          >
            {m.transfer_view()}
          </Link>
        )}
      />
    </div>
  )
}

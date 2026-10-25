import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { isActiveTransfer, transferActionError } from '../../../features/transfer/labels.ts'
import { usePolling } from '../../../features/transfer/polling.ts'
import {
  cancelWorkspaceTransfer,
  getWorkspaceTransfer,
  retryWorkspaceTransfer,
} from '../../../features/transfer/transfer.functions.ts'
import { TransferDetailView } from '../../../features/transfer/transfer-detail.tsx'
import { activateWorkspace } from '../../../features/workspace/client.ts'
import { clearWorkspacePageCache } from '../../../features/workspace/load-page.ts'
import { m } from '../../../paraglide/messages.js'

/** 流转进度 / 详情页（tasks 6.3）：升级确认后跳转到这里；进行中自动轮询 */
export const Route = createFileRoute('/app/$slug/settings_/transfers/$transferId')({
  loader: async ({ params, context }) => ({
    page: context.workspacePage,
    detail: await getWorkspaceTransfer({
      data: { slug: params.slug, transferId: params.transferId },
    }),
  }),
  staleTime: 0,
  component: TransferPage,
})

function TransferPage() {
  const { page, detail: initial } = Route.useLoaderData()
  const { slug, transferId } = Route.useParams()
  const router = useRouter()
  const [detail, setDetail] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const active = isActiveTransfer(detail.status)

  async function refresh() {
    const next = await getWorkspaceTransfer({ data: { slug, transferId } })
    setDetail(next)
    // 流转结束：两个空间恢复可写，重新获取布局数据（横幅、空间列表）
    if (isActiveTransfer(detail.status) && !isActiveTransfer(next.status)) {
      clearWorkspacePageCache()
      await router.invalidate()
    }
  }

  usePolling(active, async () => {
    try {
      await refresh()
    } catch {
      setMessage(m.transfer_detail_refresh_failed())
    }
  })

  async function act(run: () => Promise<string | undefined>) {
    setBusy(true)
    setMessage('')
    try {
      const text = await run()
      await refresh()
      if (text) setMessage(text)
    } catch (e) {
      setMessage(m.transfer_action_failed({ message: transferActionError(e, '') }))
    } finally {
      setBusy(false)
    }
  }

  const target = page.spaces.find((s) => s.id === detail.targetWorkspaceId)
  return (
    <div className="grid max-w-5xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-lg">{m.transfer_detail_title()}</h1>
        <Link
          to="/app/$slug/settings/transfers"
          params={{ slug }}
          className="text-muted-foreground text-sm hover:text-foreground"
        >
          {m.transfer_detail_back()}
        </Link>
      </div>
      <TransferDetailView
        detail={detail}
        viewer={{ userId: page.user.id, role: page.role }}
        busy={busy}
        message={message}
        polling={active}
        onOpenTarget={
          detail.kind === 'upgrade' && detail.targetWorkspaceId !== page.workspace.id
            ? () =>
                void (target
                  ? activateWorkspace(target)
                  : Promise.resolve(window.location.assign('/app')))
            : undefined
        }
        onCancel={() =>
          act(async () => {
            await cancelWorkspaceTransfer({ data: { slug, transferId } })
            return undefined
          })
        }
        onRetry={() =>
          act(async () => {
            const result = await retryWorkspaceTransfer({ data: { slug, transferId } })
            return result.resumed
              ? m.transfer_action_retry_started()
              : m.transfer_action_retry_running()
          })
        }
      />
    </div>
  )
}

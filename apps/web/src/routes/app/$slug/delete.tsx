import { listDeletionRefundReminders } from '@product-res/billing'
import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { DeletionSection } from '../../../features/deletion/deletion-section.tsx'
import { withWorkspace } from '../../../server/middleware.ts'
import { templateConfig } from '../../../server/template-config.ts'

const getDeletionWorkspace = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .handler(async ({ context: { workspace, member, db, user } }) => {
    if (workspace.isPersonal || member.role !== 'owner' || !templateConfig.tenancy.multiTenant)
      throw notFound()
    const reminders = templateConfig.billing.enabled
      ? await listDeletionRefundReminders(
          { db, actorUserId: user.id, workspaceIds: [workspace.id] },
          templateConfig.billing.refundWindowDays,
        )
      : { eligiblePaymentIds: [], pendingRequests: [] }
    return {
      refundReminder: {
        eligibleCount: reminders.eligiblePaymentIds.length,
        pendingCount: reminders.pendingRequests.length,
        billingHref: `/app/${workspace.slug}/billing`,
      },
      workspace: { id: workspace.id, name: workspace.name },
      supportEmail: templateConfig.app.supportEmail,
    }
  })
export const Route = createFileRoute('/app/$slug/delete')({
  loader: ({ params }) => getDeletionWorkspace({ data: { slug: params.slug } }),
  component: DeleteWorkspacePage,
})
function DeleteWorkspacePage() {
  const data = Route.useLoaderData()
  return (
    <DeletionSection
      workspace={data.workspace}
      supportEmail={data.supportEmail}
      refundReminder={data.refundReminder}
    />
  )
}

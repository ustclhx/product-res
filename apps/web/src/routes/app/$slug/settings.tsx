import { createFileRoute, Link } from '@tanstack/react-router'
import { Section } from '../../../features/data-center/shared.tsx'
import { UpgradeCard, upgradeCardVisible } from '../../../features/transfer/upgrade-card.tsx'
import { requireActivatedPage } from '../../../features/workspace/activation.tsx'
import { WorkspaceSettings } from '../../../features/workspace/components.tsx'
import { getInviteLinks } from '../../../features/workspace/invite-links.functions.ts'
import { loadWorkspacePage } from '../../../features/workspace/load-page.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/app/$slug/settings')({
  // 成员、邀请与席位需要最新数据：总是重新获取，并顺带刷新布局缓存
  beforeLoad: async ({ params }) => ({
    workspacePage: requireActivatedPage(await loadWorkspacePage(params.slug, { fresh: true })),
  }),
  loader: async ({ context, params }) => ({
    page: context.workspacePage,
    // 邀请链接只对团队空间的 owner / admin 返回列表，其余为 null（不渲染区块）
    inviteLinks: (await getInviteLinks({ data: { slug: params.slug } })).links,
  }),
  staleTime: 0,
  component: WorkspaceSettingsPage,
})

function WorkspaceSettingsPage() {
  const { page, inviteLinks } = Route.useLoaderData()
  return (
    <div className="grid max-w-4xl gap-4">
      <WorkspaceSettings page={page} inviteLinks={inviteLinks} />
      {upgradeCardVisible(page) ? <UpgradeCard page={page} /> : null}
      {/* 开关关闭后进行中的流转仍需可查看与自助恢复（transfer.server.ts assertTransferEnabled） */}
      {templateConfig.tenancy.dataTransfer || page.transfer ? (
        <Section title={m.transfer_section_title()}>
          <p className="text-muted-foreground text-xs">{m.transfer_records_hint()}</p>
          <Link
            to="/app/$slug/settings/transfers"
            params={{ slug: page.workspace.slug }}
            className="w-fit text-primary text-sm underline-offset-4 hover:underline"
          >
            {m.transfer_records_link()}
          </Link>
        </Section>
      ) : null}
      {!page.workspace.isPersonal && !page.readOnly && page.role === 'owner' ? (
        <a
          className="text-destructive text-sm underline"
          href={`/app/${page.workspace.slug}/delete`}
        >
          {m.workspace_delete_team()}
        </a>
      ) : null}
    </div>
  )
}

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'

/**
 * 邀请链接的 server functions（add-team-invite-links 4.1）。
 * 预览与加入用 POST：token 只在请求体中，不进入查询串。
 */
const service = () => import('./invite-links.server.ts')
const slug = z.object({ slug: z.string().min(1).max(64) })
const token = z.object({ token: z.string().min(1).max(128) })

export const getInviteLinks = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => ({
    links: await (await service()).inviteLinksFor(
      context.db,
      context.workspace,
      context.member,
      context.workspaceTeamReadOnly,
    ),
  }))

export const createInviteLinkFn = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      role: z.enum(['member', 'admin']),
      ttlDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
      maxUses: z.number().int().min(1).max(1000).nullable(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await service()).createLink(context.db, context.workspace.id, input)
  })

export const revokeInviteLinkFn = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ linkId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).revokeLink(context.db, context.workspace.id, data.linkId),
  )

export const previewJoinFn = createServerFn({ method: 'POST' })
  .inputValidator(token)
  .handler(async ({ data }) => (await service()).previewJoin(data.token))

export const joinWithLinkFn = createServerFn({ method: 'POST' })
  .inputValidator(token)
  .handler(async ({ data }) => (await service()).joinLink(data.token))

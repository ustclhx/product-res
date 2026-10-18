import { requireFreshSession } from '@product-res/auth'
import { AppError } from '@product-res/shared'
import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import {
  recipientInvitation,
  resolveWorkspaceMaxSeats,
  userWorkspaces,
  workspaceInvitations,
  workspaceMembers,
} from '../../server/workspace-data.ts'

export const getWorkspacePage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .handler(async ({ context }) => {
    const { db, workspace, member, workspaceReadOnly } = context
    const { user } = await requireFreshSession({
      auth: getWebRuntime().auth,
      db,
      headers: getRequest().headers,
    })
    const members = await workspaceMembers(db, workspace.id)
    const canManage =
      !workspace.isPersonal &&
      !workspaceReadOnly &&
      (member.role === 'owner' || member.role === 'admin')
    return {
      user: { id: user.id, name: user.name, email: user.email },
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        isPersonal: workspace.isPersonal,
      },
      role: member.role,
      readOnly: workspaceReadOnly,
      canManage,
      multiTenant: templateConfig.tenancy.multiTenant,
      spaces: templateConfig.tenancy.multiTenant ? await userWorkspaces(db, user.id) : [],
      members,
      invitations:
        !workspace.isPersonal && (member.role === 'owner' || member.role === 'admin')
          ? await workspaceInvitations(db, workspace.id)
          : [],
      memberCount: members.length,
      maxSeats: await resolveWorkspaceMaxSeats(workspace.id, db.$client),
    }
  })

export const getInvitationPage = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { db } = getWebRuntime()
    try {
      const { user } = await requireFreshSession({
        auth: getWebRuntime().auth,
        db,
        headers: getRequest().headers,
      })
      return {
        ...(await recipientInvitation(db, data.id, user.email, user.emailVerified)),
        multiTenant: templateConfig.tenancy.multiTenant,
      }
    } catch (error) {
      if (error instanceof AppError)
        throw redirect({
          href: `/login?redirect=${encodeURIComponent(`/accept-invitation?id=${data.id}`)}`,
        })
      throw error
    }
  })

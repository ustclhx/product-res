import { z } from 'zod'
import { m } from '../../paraglide/messages.js'

const errors: Record<string, () => string> = {
  WORKSPACE_READ_ONLY: () => m.workspace_error_workspace_read_only(),
  INVALID_WORKSPACE_SLUG: () => m.workspace_error_invalid_workspace_slug(),
  SLUG_TAKEN: () => m.workspace_error_slug_taken(),
  WORKSPACE_LIMIT: () => m.workspace_error_workspace_limit(),
  WORKSPACE_PERMISSION: () => m.workspace_error_workspace_permission(),
  PERSONAL_WORKSPACE: () => m.workspace_error_personal_workspace(),
  SEATS_FULL: () => m.workspace_error_seats_full(),
  LAST_OWNER: () => m.workspace_error_last_owner(),
  INVITATION_INVALID: () => m.workspace_error_invitation_invalid(),
  INVITATION_RECIPIENT: () => m.workspace_error_invitation_recipient(),
  INVITATION_EMAIL_UNVERIFIED: () => m.workspace_error_invitation_email_unverified(),
  INVITATION_EXISTS: () => m.workspace_error_invitation_exists(),
  ALREADY_MEMBER: () => m.workspace_error_already_member(),
  SESSION_REQUIRED: () => m.workspace_error_session_required(),
  USER_BANNED: () => m.workspace_error_user_banned(),
  USE_OWNER_TRANSFER: () => m.workspace_error_use_owner_transfer(),
}
export function workspaceError(code: string) {
  return errors[code]?.() ?? m.workspace_error_unknown()
}
const responseError = z.object({
  code: z.string().optional(),
  error: z.object({ code: z.string().optional() }).optional(),
})
export async function workspaceAction<T>(
  action: string,
  body: object,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api/auth/organization/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const value: unknown = await response.json()
  if (!response.ok) {
    const parsed = responseError.safeParse(value)
    throw new Error(
      workspaceError(parsed.success ? (parsed.data.code ?? parsed.data.error?.code ?? '') : ''),
    )
  }
  return schema.parse(value)
}
export const actionResult = z.unknown()
export async function activateWorkspace(workspace: { id: string; slug: string }) {
  await workspaceAction('set-active', { organizationId: workspace.id }, actionResult)
  window.location.assign(`/app/${encodeURIComponent(workspace.slug)}`)
}

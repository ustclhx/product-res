import { m } from '../../paraglide/messages.js'
import { workspaceError } from './client.ts'

/** 邀请链接与加入的错误码 → 文案；未列出的空间错误码沿用 workspaceError */
const messages: Record<string, () => string> = {
  INVITE_LINK_INVALID: () => m.join_error_invalid(),
  INVITE_LINK_EXPIRED: () => m.join_error_expired(),
  INVITE_LINK_REVOKED: () => m.join_error_revoked(),
  INVITE_LINK_EXHAUSTED: () => m.join_error_exhausted(),
  INVITE_LINK_INACTIVE: () => m.join_error_inactive(),
  SEATS_FULL: () => m.join_error_seats_full(),
  WORKSPACE_READ_ONLY: () => m.join_error_disabled(),
  RATE_LIMITED: () => m.join_error_rate_limited(),
  IMPERSONATION_FORBIDDEN: () => m.join_error_impersonating(),
  SESSION_REQUIRED: () => m.join_error_session(),
}

export function inviteLinkErrorMessage(code: string): string {
  return messages[code]?.() ?? workspaceError(code)
}

/** 预览状态 → 文案（valid / member / signed_out 由页面单独处理） */
export function joinStatusMessage(status: string): string {
  const map: Record<string, () => string> = {
    invalid: () => m.join_error_invalid(),
    expired: () => m.join_error_expired(),
    revoked: () => m.join_error_revoked(),
    exhausted: () => m.join_error_exhausted(),
    inactive: () => m.join_error_inactive(),
    seats_full: () => m.join_error_seats_full(),
    disabled: () => m.join_error_disabled(),
    rate_limited: () => m.join_error_rate_limited(),
  }
  return map[status]?.() ?? m.join_error_unknown()
}

export function roleLabel(role: string) {
  if (role === 'owner') return m.workspace_role_owner()
  if (role === 'admin') return m.workspace_role_admin()
  return m.workspace_role_member()
}

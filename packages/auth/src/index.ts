export { type Auth, type CreateAuthDeps, createAuth } from './auth.ts'
export {
  DELETION_CLEANUP_PREFIX,
  type DeletionContext,
  type DeletionStep,
  type DeletionTransaction,
  deleteAccount,
  deleteTeamWorkspace,
  deletionPlugin,
  registerDeletionStep,
  retryDeletionCleanup,
} from './deletion.ts'
export type { AuthEmail, SendAuthEmail } from './email.ts'
export { type AuthEnv, parseAuthEnv } from './env.ts'
export {
  type AuthContextSource,
  type FreshSession,
  requireFreshSession,
  SESSION_REQUIRED,
  USER_BANNED,
} from './fresh-session.ts'
export {
  type CreateInviteLinkInput,
  createInviteLink,
  INVITE_LINK_DEFAULT_TTL_DAYS,
  INVITE_LINK_MAX_USES_LIMIT,
  INVITE_LINK_TTL_DAYS,
  type InviteLinkActor,
  type InviteLinkDeps,
  type InviteLinkPreview,
  type InviteLinkRole,
  type InviteLinkStatus,
  type InviteLinkSummary,
  isInviteLinkToken,
  joinWithInviteLink,
  listInviteLinks,
  previewInviteLink,
  revokeInviteLink,
} from './invite-links.ts'
export {
  ensurePersonalWorkspace,
  findPersonalWorkspace,
  PERSONAL_SLUG_PREFIX,
  PERSONAL_WORKSPACE_NAME,
  personalSlug,
} from './personal-workspace.ts'
export { TURNSTILE_TOKEN_HEADER, verifyTurnstile } from './protection.ts'
export { SESSION_COOKIE_CACHE_MAX_AGE } from './session.ts'
export type { ResolveMaxSeats } from './team-workspaces.ts'
export {
  cleanupExpiredWorkspaces,
  restoreWorkspace,
  WORKSPACE_RETENTION_DAYS,
  workspaceLifecyclePlugin,
} from './workspace-lifecycle.ts'

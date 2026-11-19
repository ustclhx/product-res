import {
  cleanupExpiredWorkspaces,
  purgeDeletedPersonalWorkspaceShareCards,
  purgeDeletedUserAiContent,
} from '@product-res/auth'
import type { DatabaseAccess, KeyValueStore } from '@product-res/platform'
import { log } from '@product-res/shared/log'
import { createShareCardInvalidator, type ShareCardObjects } from '@product-res/storage'

/** Daily at 03:00 UTC; independent of the health heartbeat. */
export const WORKSPACE_CLEANUP_CRON = '0 3 * * *'
export async function runWorkspaceCleanup(context: {
  db: DatabaseAccess
  cache: KeyValueStore
  shareCardCache?: KeyValueStore
  shareCards?: ShareCardObjects
}): Promise<void> {
  const db = context.db.business()
  const invalidator = context.shareCards
    ? createShareCardInvalidator(context.shareCards, context.shareCardCache ?? context.cache)
    : undefined
  try {
    if (invalidator)
      await purgeDeletedPersonalWorkspaceShareCards(db, invalidator.cleanupWorkspaceShareCards)
  } catch {
    log.error('cron.personal-share-cards-cleanup.failed')
  }
  try {
    const result = await cleanupExpiredWorkspaces(db, {
      ...(invalidator && { cleanupShareCards: invalidator.cleanupWorkspaceShareCards }),
    })
    log.info('cron.workspace-cleanup', result)
  } catch {
    log.error('cron.workspace-cleanup.failed')
  }
  // 删号后团队空间中的 AI 内容不放进删号事务，由这里分批删除，避免长事务持锁。
  try {
    const deletedUsers = await purgeDeletedUserAiContent(db)
    log.info('cron.deleted-user-ai-cleanup', deletedUsers)
  } catch {
    log.error('cron.deleted-user-ai-cleanup.failed')
  }
}

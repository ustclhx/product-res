import { retryDeletionCleanup } from '@product-res/auth'
import type { DatabaseAccess, KeyValueStore } from '@product-res/platform'
import { log } from '@product-res/shared/log'

/** 跟随心跳重试已提交的凭据失效；staging reduced profile 的周期为半小时。 */
export async function runDeletionCleanup(context: { db: DatabaseAccess; cache: KeyValueStore }) {
  const result = await retryDeletionCleanup(context.db.business(), context.cache)
  log.info('cron.deletion-cleanup', result)
  if (result.failed > 0) throw new Error('Credential cache cleanup failed; retry next heartbeat')
}

import type { DataKind, Marketplace } from '@product-res/datasources'
import type { Database } from '@product-res/db'
import { syncRun } from '@product-res/db/schema'
import { and, desc, eq, type SQL } from 'drizzle-orm'

export type SyncTrigger = 'scheduled' | 'manual' | 'replay'
export type SyncStatus = 'running' | 'succeeded' | 'failed' | 'deferred' | 'skipped'

export async function startRun(
  db: Database,
  input: {
    sourceId: string
    dataKind: DataKind
    marketplace: Marketplace
    scope: Record<string, unknown>
    trigger: SyncTrigger
    planned: number
    startedAt: Date
  },
) {
  const [row] = await db
    .insert(syncRun)
    .values({ ...input, status: 'running' })
    .returning({ id: syncRun.id })
  return (row as { id: string }).id
}

export async function finishRun(
  db: Database,
  id: string,
  result: {
    status: Exclude<SyncStatus, 'running'>
    calls?: number
    cost?: number
    okCount?: number
    failCount?: number
    errorCode?: string | null
    finishedAt: Date
  },
) {
  await db.update(syncRun).set(result).where(eq(syncRun.id, id))
}

export async function listRuns(
  db: Database,
  filter: { sourceId?: string; status?: SyncStatus; limit?: number } = {},
) {
  const where: SQL[] = []
  if (filter.sourceId) where.push(eq(syncRun.sourceId, filter.sourceId))
  if (filter.status) where.push(eq(syncRun.status, filter.status))
  return db
    .select()
    .from(syncRun)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(syncRun.startedAt))
    .limit(filter.limit ?? 50)
}

export async function getRun(db: Database, id: string) {
  const [row] = await db.select().from(syncRun).where(eq(syncRun.id, id))
  return row
}

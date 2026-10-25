import { env } from 'cloudflare:workers'
import {
  cluster,
  createDb,
  decision,
  direction,
  lead,
  leadEvent,
  member,
  notification,
  organization,
  scoped,
  user,
  workspaceTransfer,
} from '@product-res/db'
import {
  finalizeTransfer,
  listTransferBatches,
  planTransfer,
  runBatch,
  startCopy,
} from '@product-res/follow/transfer'
import { newId } from '@product-res/shared'
import { and, eq, inArray, or, type SQL, sql } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'
import { REVIEW_REMINDER_EVENT, runSelectionReview } from '../src/review/selection-review.ts'

// add-workspace-data-transfer 3.4：复制已提醒过的决定后，lead_event.payload.decisionId 改指目标空间的
// 决定副本，回看任务据此判断已提醒，不在目标空间重复发送。
const db = () => createDb(env.HYPERDRIVE)
const NOW = new Date('2026-10-19T01:00:00Z')
const config = { tenancy: { multiTenant: true, dataTransfer: true, maxWorkspacesPerUser: 5 } }
const spaces: string[] = []
const owner = newId()

afterAll(async () => {
  await db()
    .delete(workspaceTransfer)
    .where(
      or(
        inArray(workspaceTransfer.sourceWorkspaceId, spaces),
        inArray(workspaceTransfer.targetWorkspaceId, spaces),
      ),
    )
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(notification, undefined)
    await s.delete(decision, undefined)
    await s.delete(leadEvent, undefined)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(member, undefined)
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
  await db().delete(user).where(eq(user.id, owner))
})

async function team(name: string) {
  const ws = newId()
  spaces.push(ws)
  await db()
    .insert(organization)
    .values({ id: ws, name, slug: `copy-${ws.slice(-12)}`, isPersonal: false })
  await scoped(db(), ws).insert(member, { id: newId(), userId: owner, role: 'owner' })
  return ws
}

it('复制已到期并已提醒的决定：目标空间不再发回看提醒', async () => {
  await db()
    .insert(user)
    .values({ id: owner, name: 'Owner', email: `${owner}@copy-review.test` })
  const a = await team('CopyA')
  const b = await team('CopyB')
  const s = scoped(db(), a)
  const [dir] = await s.insert(direction, { name: '厨房' }).returning()
  const [c] = await s
    .insert(cluster, { directionId: dir?.id as string, marketplace: 'ebay-us', name: '到期水杯' })
    .returning()
  const [l] = await s
    .insert(lead, {
      clusterId: c?.id as string,
      directionId: dir?.id as string,
      leadOn: '2026-06-01',
      settingVersion: 1,
      status: 'followed',
    })
    .returning()
  const [d] = await s
    .insert(decision, {
      leadId: l?.id as string,
      kind: 'follow',
      decidedBy: owner,
      plannedListingOn: '2026-07-01',
      snapshot: { cluster: { name: '到期水杯' } },
    })
    .returning()
  await runSelectionReview(db(), NOW)
  expect(await s.count(notification)).toBe(1)

  const started = await startCopy(
    db(),
    {
      userId: owner,
      sourceWorkspaceId: a,
      targetWorkspaceId: b,
      selection: { roots: { decision: [d?.id as string] } },
      idempotencyKey: newId(),
    },
    config,
  )
  await planTransfer(db(), started.transferId, config)
  for (const batch of await listTransferBatches(db(), started.transferId))
    await runBatch(db(), started.transferId, batch.key, config)
  await finalizeTransfer(db(), started.transferId)

  const t = scoped(db(), b)
  const [copied] = await t.select(decision)
  expect(copied?.id).not.toBe(d?.id)
  const marks = await t.select(leadEvent, {
    where: and(
      eq(leadEvent.kind, 'note'),
      sql`${leadEvent.payload}->>'type' = ${REVIEW_REMINDER_EVENT}`,
    ) as SQL,
  })
  expect(marks.map((m) => [m.leadId, (m.payload as { decisionId?: string }).decisionId])).toEqual([
    [copied?.leadId, copied?.id],
  ])

  await runSelectionReview(db(), NOW)
  expect(await t.count(notification)).toBe(0)
  expect(await s.count(notification)).toBe(1)
})

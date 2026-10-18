import { env } from 'cloudflare:workers'
import {
  cluster,
  createDb,
  decision,
  direction,
  followOutcome,
  lead,
  leadEvent,
  member,
  notification,
  organization,
  scoped,
  user,
} from '@product-res/db'
import { newId } from '@product-res/shared'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  REVIEW_REMINDER_EVENT,
  reviewCutoff,
  runSelectionReview,
  SELECTION_REVIEW_SCHEDULE,
} from '../src/review/selection-review.ts'

// add-costing-decisions 4.2：计划上架日 + 30 天到期且未录入回看的跟卖决定发一次站内通知。
const db = () => createDb(env.HYPERDRIVE)
const NOW = new Date('2026-10-19T01:00:00Z') // 新加坡 09:00
const spaces: string[] = []
const users: string[] = []

async function seedSpace(opts: { deciderLeft?: boolean } = {}) {
  const ws = newId()
  const owner = newId()
  const decider = newId()
  spaces.push(ws)
  users.push(owner, decider)
  await db()
    .insert(organization)
    .values({ id: ws, name: 'Review', slug: `review-${ws.slice(-12)}` })
  await db()
    .insert(user)
    .values([
      { id: owner, name: 'Owner', email: `${owner}@review.test` },
      { id: decider, name: 'Decider', email: `${decider}@review.test` },
    ])
  const s = scoped(db(), ws)
  await s.insert(member, [
    { id: newId(), userId: owner, role: 'owner' },
    ...(opts.deciderLeft ? [] : [{ id: newId(), userId: decider, role: 'member' }]),
  ])
  const [dir] = await s.insert(direction, { name: '厨房' }).returning()
  async function decided(name: string, values: Partial<typeof decision.$inferInsert>) {
    const [c] = await s
      .insert(cluster, { directionId: dir?.id as string, marketplace: 'ebay-us', name })
      .returning()
    const [l] = await s
      .insert(lead, {
        clusterId: c?.id as string,
        directionId: dir?.id as string,
        leadOn: '2026-08-01',
        settingVersion: 1,
        status: values.kind === 'drop' ? 'dropped' : 'followed',
      })
      .returning()
    const [d] = await s
      .insert(decision, {
        leadId: l?.id as string,
        kind: 'follow',
        decidedBy: decider,
        snapshot: { cluster: { name } },
        ...values,
      })
      .returning()
    return { leadId: l?.id as string, decisionId: d?.id as string }
  }
  return { ws, owner, decider, decided }
}

let a: Awaited<ReturnType<typeof seedSpace>>
let b: Awaited<ReturnType<typeof seedSpace>>
const ids: Record<string, { leadId: string; decisionId: string }> = {}

beforeAll(async () => {
  a = await seedSpace()
  // 计划上架日 09-19 + 30 = 10-19，今天到期
  ids.due = await a.decided('到期水杯', { plannedListingOn: '2026-09-19' })
  ids.notYet = await a.decided('未到期', { plannedListingOn: '2026-09-20' })
  ids.reviewed = await a.decided('已回看', { plannedListingOn: '2026-08-01' })
  ids.dropped = await a.decided('已放弃', { kind: 'drop', dropReason: 'timing' })
  await scoped(db(), a.ws).insert(followOutcome, {
    decisionId: ids.reviewed.decisionId,
    actualUnits: 10,
  })
  // 决定人已离开空间：改为通知所有者
  b = await seedSpace({ deciderLeft: true })
  ids.orphan = await b.decided('离开的人', { plannedListingOn: '2026-07-01' })
})

afterAll(async () => {
  for (const ws of spaces) {
    const s = scoped(db(), ws)
    await s.delete(notification, undefined)
    await s.delete(followOutcome, undefined)
    await s.delete(decision, undefined)
    await s.delete(leadEvent, undefined)
    await s.delete(lead, undefined)
    await s.delete(cluster, undefined)
    await s.delete(direction, undefined)
    await s.delete(member, undefined)
  }
  await db().delete(organization).where(inArray(organization.id, spaces))
  await db().delete(user).where(inArray(user.id, users))
})

it('每日 09:00 新加坡时间运行，错过时补跑一次', () => {
  expect(SELECTION_REVIEW_SCHEDULE).toEqual({
    id: 'selection-review-v1',
    cron: '0 9 * * *',
    timeZone: 'Asia/Singapore',
    missedRun: 'once',
  })
  expect(reviewCutoff(NOW)).toBe('2026-09-19')
})

it('到期未回看的跟卖决定发通知并写幂等标记；已回看、未到期、放弃不发；重复运行不再发', async () => {
  await runSelectionReview(db(), NOW)

  const notesA = await scoped(db(), a.ws).select(notification)
  expect(notesA).toEqual([
    expect.objectContaining({
      userId: a.decider,
      type: 'selection.review_due',
      title: '跟卖回看：到期水杯',
      link: `/app/review-${a.ws.slice(-12)}/archive?kind=follow`,
    }),
  ])
  const notesB = await scoped(db(), b.ws).select(notification)
  expect(notesB.map((n) => n.userId)).toEqual([b.owner])

  const marks = await scoped(db(), a.ws).select(leadEvent, {
    where: eq(leadEvent.leadId, ids.due?.leadId as string),
  })
  expect(marks).toEqual([
    expect.objectContaining({
      kind: 'note',
      payload: {
        type: REVIEW_REMINDER_EVENT,
        decisionId: ids.due?.decisionId,
        reviewDays: 30,
        dueOn: '2026-10-19',
      },
    }),
  ])

  // 再跑一次（含次日）：已提醒的不重复
  await runSelectionReview(db(), NOW)
  await runSelectionReview(db(), new Date('2026-10-20T01:00:00Z'))
  const after = await scoped(db(), a.ws).select(notification)
  // 次日 notYet 到期，发它自己的一条
  expect(after.map((n) => n.title).sort()).toEqual(['跟卖回看：到期水杯', '跟卖回看：未到期'])
  expect(await scoped(db(), b.ws).count(notification)).toBe(1)
})

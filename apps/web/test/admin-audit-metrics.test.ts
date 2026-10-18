import { newId } from '@product-res/shared'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { listAuditLogs } from '../src/features/admin/audit.ts'
import { readAdminMetrics } from '../src/features/admin/metrics.ts'
import { createAdminTestDb } from './admin-test-resources.ts'

const db = createAdminTestDb()
const uid = newId(),
  workspaceId = newId(),
  action = `test.audit.${newId()}`
const email = `${uid}@audit-query.test`
const days = ['2002-03-01', '2002-03-02', '2002-03-03']
beforeAll(async () => {
  const sql = db.$client
  await sql`insert into "user" (id,name,email) values (${uid},'Audit',${email})`
  await sql`insert into organization (id,name,slug) values (${workspaceId},'Audit',${workspaceId})`
  for (let i = 0; i < 52; i++)
    await sql`insert into audit_log (id,actor_user_id,workspace_id,action,created_at) values (${newId()},${uid},${workspaceId},${action},${new Date(Date.parse('2002-03-02T00:00:00Z') + i * 1000).toISOString()})`
  for (const day of ['2002-03-01T23:59:59Z', '2002-03-03T00:00:00Z'])
    await sql`insert into audit_log (id,actor_user_id,workspace_id,action,created_at) values (${newId()},${uid},${workspaceId},${action},${day})`
  for (const [i, day] of days.entries())
    await sql`insert into metrics_daily (day,registrations,total_users,total_workspaces,paid_workspaces,mrr_by_currency,credits_consumed,overage_absorbed,overage_by_model,text_completed,text_failed,text_aborted,data_through)
    values (${day},${i + 1},20,10,${i + 1},${JSON.stringify({ USD: 1200 * (i + 1) })}::jsonb,${100 * (i + 1)},${10 * (i + 1)},${JSON.stringify({ model: 10 * (i + 1) })}::jsonb,${i === 1 ? 1 : 9},1,0,${new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString()})`
})
afterAll(async () => {
  const sql = createAdminTestDb('migrator').$client
  await sql`delete from audit_log where workspace_id=${workspaceId}`
  await sql`delete from metrics_daily where day in ${sql(days)}`
  await sql`delete from organization where id=${workspaceId}`
  await sql`delete from "user" where id=${uid}`
})
it('审计操作人、空间、动作、UTC 时间组合筛选与服务端分页', async () => {
  const filter = {
    offset: 0,
    actor: email,
    workspaceId,
    action,
    from: '2002-03-02',
    to: '2002-03-02',
  }
  const first = await listAuditLogs(db, filter)
  expect(first.rows).toHaveLength(50)
  expect(first.hasMore).toBe(true)
  expect(first.rows[0]?.log.createdAt.toISOString()).toBe('2002-03-02T00:00:51.000Z')
  const second = await listAuditLogs(db, { ...filter, actor: uid, offset: 50 })
  expect(second.rows.map((row) => row.log.createdAt.toISOString())).toEqual([
    '2002-03-02T00:00:01.000Z',
    '2002-03-02T00:00:00.000Z',
  ])
  expect(second.hasMore).toBe(false)
  expect((await listAuditLogs(db, { ...filter, action: 'unmatched' })).rows).toEqual([])
})
it('看板按区间累计增量、按样本加权成功率、取最后一日存量并显示数据截止时间', async () => {
  const data = await readAdminMetrics(db, { from: days[0], to: days[1] })
  expect(data).toMatchObject({
    registrations: 3,
    creditsConsumed: 300,
    overageAbsorbed: 30,
    overageByModel: { model: 30 },
    successRate: 10 / 12,
    attempts: 12,
    paidConversion: 0.2,
    latest: { paidWorkspaces: 2, mrrByCurrency: { USD: 2400 } },
  })
  expect(data.latest?.dataThrough.toISOString()).toBe('2002-03-03T00:00:00.000Z')
  expect(
    (await readAdminMetrics(db, { from: '2002-04-01', to: '2002-04-02' })).successRate,
  ).toBeNull()
})

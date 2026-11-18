import { newId } from '@product-res/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  purgeDeletedPersonalWorkspaceShareCards,
  purgeDeletedUserAiContent,
} from '../src/ai-content-cleanup.ts'
import { deleteAccount, deleteTeamWorkspace } from '../src/deletion.ts'
import { cleanupExpiredWorkspaces } from '../src/workspace-lifecycle.ts'
import { cookieHeader, setup, signUpBody, testUsers } from './helpers.ts'

const users = testUsers('ai-cleanup')
const growthEmails: string[] = []
const app = () =>
  setup({
    rateLimiter: { limit: async () => ({ success: true }) },
    config: { auth: { turnstile: false }, tenancy: { multiTenant: true } },
  })
type App = ReturnType<typeof app>

const deletedIds: string[] = []
afterAll(async () => {
  const sql = app().db.$client
  const domain = users.email('x').split('@')[1] ?? ''
  const userIds = [
    ...deletedIds,
    ...(await sql<{ id: string }[]>`select id from "user" where email like ${`%@${domain}`}`).map(
      (u) => u.id,
    ),
  ]
  // 个人空间的 id 即用户 id
  const ids = [...new Set([...users.createdOrgs, ...userIds])]
  if (ids.length) {
    await sql`delete from ai_message_feedback where workspace_id in ${sql(ids)}`
    await sql`delete from ai_message where workspace_id in ${sql(ids)}`
    await sql`delete from ai_conversation where workspace_id in ${sql(ids)}`
    await sql`delete from file where workspace_id in ${sql(ids)}`
    await sql`delete from ai_task where workspace_id in ${sql(ids)}`
    await sql`delete from credit_ledger where workspace_id in ${sql(ids)}`
    await sql`delete from credit_hold where workspace_id in ${sql(ids)}`
    await sql`delete from notification where workspace_id in ${sql(ids)} or user_id in ${sql(ids)}`
  }
  if (growthEmails.length) {
    await sql`delete from newsletter_subscriber where email in ${sql(growthEmails)}`
    await sql`delete from waitlist where email in ${sql(growthEmails)}`
  }
  // 已删号用户的邮箱被替换，按 id 改回测试域名，交给 testUsers 统一清理。
  for (const id of deletedIds)
    await sql`update "user" set email=${users.email('cleanup')} where id=${id}`
  await users.cleanup()
})

async function actor(a: App, name: string) {
  const email = users.email(name)
  const response = await a.post('/sign-up/email', signUpBody(email))
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  const cookie = cookieHeader(response)
  return {
    id: user.id,
    email,
    options: {
      auth: a.auth,
      db: a.db,
      headers: new Headers({ cookie }),
      clientIp: a.ip,
    },
  }
}
async function team(a: App, members: { id: string; role: string }[]) {
  const id = newId()
  users.createdOrgs.push(id)
  await a.db.$client`insert into organization (id,name,slug) values (${id},'AI cleanup',${id})`
  for (const member of members)
    await a.db
      .$client`insert into member (id,organization_id,user_id,role) values (${newId()},${id},${member.id},${member.role})`
  return id
}
const pricing = { mode: 'per_call', credits: 1 }
async function hold(
  a: App,
  workspaceId: string,
  userId: string,
  ref: { type: 'ai_task' | 'ai_message'; id: string },
  status: 'held' | 'captured',
) {
  const id = newId()
  await a.db
    .$client`insert into credit_hold (id,workspace_id,user_id,amount,status,ref_type,ref_id,captured_amount)
    values (${id},${workspaceId},${userId},5,${status},${ref.type},${ref.id},${status === 'captured' ? 5 : 0})`
  return id
}
/** 一段对话（含两条消息）与一个带产出文件的媒体任务；heldMessage 让助手消息保持 held 预扣。 */
async function content(
  a: App,
  workspaceId: string,
  userId: string,
  { heldMessage = false, heldTask = false } = {},
) {
  const sql = a.db.$client
  const conversation = newId()
  // 对象对话（add-subject-chat）：带 subject 字段与首条 system 上下文，已完成的回复带评分
  await sql`insert into ai_conversation (id,workspace_id,user_id,model_key,subject_type,subject_id)
    values (${conversation},${workspaceId},${userId},'m','report',${newId()})`
  await sql`insert into ai_message (id,conversation_id,workspace_id,role) values (${newId()},${conversation},${workspaceId},'system')`
  const assistant = newId()
  const holdId = await hold(
    a,
    workspaceId,
    userId,
    { type: 'ai_message', id: assistant },
    heldMessage ? 'held' : 'captured',
  )
  await sql`insert into ai_message (id,conversation_id,workspace_id,role) values (${newId()},${conversation},${workspaceId},'user')`
  await sql`insert into ai_message (id,conversation_id,workspace_id,role,status,hold_id)
    values (${assistant},${conversation},${workspaceId},'assistant',${heldMessage ? 'streaming' : 'completed'},${holdId})`
  if (!heldMessage)
    await sql`insert into ai_message_feedback (id,workspace_id,message_id,user_id,rating,comment,model_key,subject_type)
      values (${newId()},${workspaceId},${assistant},${userId},'down','too long','m','report')`
  const task = newId()
  const taskHold = await hold(
    a,
    workspaceId,
    userId,
    { type: 'ai_task', id: task },
    heldTask ? 'held' : 'captured',
  )
  await sql`insert into ai_task (id,workspace_id,user_id,kind,model_key,pricing,status,input,provider,provider_request_key,hold_id,deadline_at)
    values (${task},${workspaceId},${userId},'image','m',${JSON.stringify(pricing)}::jsonb,${heldTask ? 'running' : 'succeeded'},'{}'::jsonb,'fake',${task},${taskHold},now()+interval '1 hour')`
  const file = newId()
  await sql`insert into file (id,workspace_id,user_id,purpose,status,r2_key,mime,size,source_task_id)
    values (${file},${workspaceId},${userId},'ai_output','ready',${`test/${file}`},'image/png',1,${task})`
  await sql`insert into credit_ledger (id,workspace_id,user_id,delta,type,ref_type,ref_id)
    values (${newId()},${workspaceId},${userId},-5,'consume','ai_message',${assistant})`
  return { conversation, assistant, holdId, task, taskHold, file }
}
async function counts(a: App, workspaceId: string, userId?: string) {
  const sql = a.db.$client
  const by = userId ? sql`and user_id=${userId}` : sql``
  const [row] = await sql<
    { conversations: number; messages: number; tasks: number; files: number }[]
  >`select
    (select count(*)::int from ai_conversation where workspace_id=${workspaceId} ${by}) as conversations,
    (select count(*)::int from ai_message m where m.workspace_id=${workspaceId}
      and m.conversation_id in (select id from ai_conversation where workspace_id=${workspaceId} ${by})) as messages,
    (select count(*)::int from ai_task where workspace_id=${workspaceId} ${by}) as tasks,
    (select count(*)::int from file where workspace_id=${workspaceId} ${by}) as files`
  return row
}
async function feedbackCount(a: App, workspaceId: string, userId?: string) {
  const sql = a.db.$client
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ai_message_feedback
    where workspace_id=${workspaceId} ${userId ? sql`and user_id=${userId}` : sql``}`
  return row?.n
}
async function finance(a: App, workspaceId: string) {
  const sql = a.db.$client
  return {
    ledger:
      await sql`select id,delta,type,ref_id from credit_ledger where workspace_id=${workspaceId} order by id`,
    holds:
      await sql`select id,status,amount,captured_amount from credit_hold where workspace_id=${workspaceId} order by id`,
  }
}

describe('AI content deletion in workerd', () => {
  it('invalidates personal share cards immediately on account deletion and retries failures before retention ends', async () => {
    const a = app()
    const target = await actor(a, 'share-personal')
    deletedIds.push(target.id)
    const other = await actor(a, 'share-other')
    const cleanupShareCards = vi.fn(async (_workspaceId: string) => {})
    cleanupShareCards.mockRejectedValueOnce(new Error('provider-secret'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(deleteAccount({ ...target.options, cleanupShareCards })).rejects.toMatchObject({
        code: 'DELETION_CLEANUP_FAILED',
        details: { deletionCompleted: true },
      })
      expect(warning).toHaveBeenCalled()
      expect(JSON.stringify(warning.mock.calls)).toContain('share-card-cleanup-failed')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('provider-secret')
    } finally {
      warning.mockRestore()
    }
    expect(cleanupShareCards).toHaveBeenCalledWith(target.id, { maxIndexes: 20 })
    const second = await actor(a, 'share-second-deleted')
    deletedIds.push(second.id)
    await deleteAccount(second.options)
    cleanupShareCards.mockClear()
    cleanupShareCards.mockImplementation(async (workspaceId) => {
      if (workspaceId === target.id) throw new Error('storage unavailable')
    })
    expect(await purgeDeletedPersonalWorkspaceShareCards(a.db, cleanupShareCards)).toMatchObject({
      failed: 1,
    })
    expect(cleanupShareCards).toHaveBeenCalledWith(target.id)
    expect(cleanupShareCards).toHaveBeenCalledWith(second.id)
    expect(cleanupShareCards).not.toHaveBeenCalledWith(other.id)
    const marks = (workspaceId: string) => a.db
      .$client`select id from audit_log where workspace_id=${workspaceId}
      and action='workspace.share-cards.cleanup.completed'`
    expect(await marks(target.id)).toHaveLength(0)
    expect(await marks(second.id)).toHaveLength(1)
    cleanupShareCards.mockClear()
    cleanupShareCards.mockImplementation(async () => {})
    await purgeDeletedPersonalWorkspaceShareCards(a.db, cleanupShareCards)
    expect(await marks(target.id)).toHaveLength(1)
    expect(cleanupShareCards).toHaveBeenCalledWith(target.id)
    expect(cleanupShareCards).not.toHaveBeenCalledWith(second.id)
    cleanupShareCards.mockClear()
    await purgeDeletedPersonalWorkspaceShareCards(a.db, cleanupShareCards)
    expect(cleanupShareCards).not.toHaveBeenCalledWith(target.id)
    const [workspace] = await a.db
      .$client`select deleted_at>now()-interval '30 days' as retained from organization where id=${target.id}`
    expect(workspace?.retained).toBe(true)
  })

  it('bounds account deletion cleanup and only marks completion after cron finishes the remainder', async () => {
    const a = app()
    const target = await actor(a, 'share-bounded')
    deletedIds.push(target.id)
    let indexes = 23
    const cleanupShareCards = vi.fn(
      async (_workspaceId: string, options?: { maxIndexes?: number }) => {
        indexes -= Math.min(indexes, options?.maxIndexes ?? indexes)
        return { complete: indexes === 0 }
      },
    )
    await expect(deleteAccount({ ...target.options, cleanupShareCards })).resolves.toEqual({
      deleted: true,
    })
    expect(indexes).toBe(3)
    const marks = () => a.db.$client`select id from audit_log where workspace_id=${target.id}
      and action='workspace.share-cards.cleanup.completed'`
    expect(await marks()).toHaveLength(0)
    await purgeDeletedPersonalWorkspaceShareCards(a.db, cleanupShareCards, target.id)
    expect(indexes).toBe(0)
    expect(await marks()).toHaveLength(1)
  })

  it('isolates expired workspace failures and retries without touching active or retained spaces', async () => {
    const a = app()
    const owner = await actor(a, 'share-team')
    const expired = await team(a, [{ id: owner.id, role: 'owner' }])
    const otherExpired = await team(a, [{ id: owner.id, role: 'owner' }])
    const active = await team(a, [{ id: owner.id, role: 'owner' }])
    const retained = await team(a, [{ id: owner.id, role: 'owner' }])
    for (const workspaceId of [expired, otherExpired, retained])
      await deleteTeamWorkspace({ ...owner.options, workspaceId })
    for (const workspaceId of [expired, otherExpired])
      await a.db
        .$client`update organization set deleted_at=now()-interval '31 days' where id=${workspaceId}`
    const cleanupShareCards = vi.fn(async (workspaceId: string) => {
      if (workspaceId === expired) throw new Error('storage unavailable')
    })
    expect(await cleanupExpiredWorkspaces(a.db, { cleanupShareCards })).toMatchObject({ failed: 1 })
    const marks = (workspaceId: string) => a.db
      .$client`select id from audit_log where workspace_id=${workspaceId}
      and action='workspace.cleanup.completed'`
    expect(await marks(expired)).toHaveLength(0)
    expect(await marks(otherExpired)).toHaveLength(1)
    cleanupShareCards.mockImplementation(async () => {})
    const result = await cleanupExpiredWorkspaces(a.db, { cleanupShareCards })
    expect(result.cleaned).toBeGreaterThanOrEqual(1)
    expect(await marks(expired)).toHaveLength(1)
    expect(cleanupShareCards).toHaveBeenCalledWith(expired)
    expect(cleanupShareCards).toHaveBeenCalledWith(otherExpired)
    expect(cleanupShareCards).not.toHaveBeenCalledWith(active)
    expect(cleanupShareCards).not.toHaveBeenCalledWith(retained)
  })

  it('purges an expired workspace in batches, keeps held rows until settled and finance intact', async () => {
    const a = app()
    const owner = await actor(a, 'owner')
    const id = await team(a, [{ id: owner.id, role: 'owner' }])
    await content(a, id, owner.id)
    await content(a, id, owner.id)
    const pending = await content(a, id, owner.id, { heldMessage: true, heldTask: true })
    await deleteTeamWorkspace({ ...owner.options, workspaceId: id })
    const before = await finance(a, id)
    await a.db.$client`update organization set deleted_at=now()-interval '31 days' where id=${id}`

    // 批大小 1、最多 2 批：一轮删不完，标记 remaining，留给下一轮
    const first = await cleanupExpiredWorkspaces(a.db, { batchSize: 1, maxBatches: 2 })
    expect(first.ai.remaining).toBe(true)
    const result = await cleanupExpiredWorkspaces(a.db)
    expect(result.ai.remaining).toBe(false)
    // held 预扣的消息与任务（及其对话）保留到兜底处理器结算之后
    expect(await counts(a, id)).toEqual({ conversations: 1, messages: 1, tasks: 1, files: 3 })
    expect(await a.db.$client`select id from ai_message where workspace_id=${id}`).toMatchObject([
      { id: pending.assistant },
    ])
    // 产出文件不由本任务删除（文件清理负责），只解除对已删除任务的引用
    expect(
      await a.db
        .$client`select id from file where workspace_id=${id} and source_task_id is not null`,
    ).toMatchObject([{ id: pending.file }])

    // 兜底处理器结算：预扣释放，消息与任务进入终态
    const sql = a.db.$client
    await sql`update credit_hold set status='released' where id in ${sql([pending.holdId, pending.taskHold])}`
    await sql`update ai_message set status='failed' where id=${pending.assistant}`
    await sql`update ai_task set status='failed' where id=${pending.task}`
    await cleanupExpiredWorkspaces(a.db)
    expect(await counts(a, id)).toMatchObject({ conversations: 0, messages: 0, tasks: 0 })
    expect(await feedbackCount(a, id)).toBe(0)
    const after = await finance(a, id)
    expect(after.ledger).toEqual(before.ledger)
    expect(after.holds.map((h) => h.id)).toEqual(before.holds.map((h) => h.id))
    expect(await cleanupExpiredWorkspaces(a.db)).toMatchObject({
      cleaned: 0,
      ai: { messages: 0, conversations: 0, tasks: 0 },
    })
  })

  it('keeps AI content of a soft-deleted workspace inside the retention period', async () => {
    const a = app()
    const owner = await actor(a, 'retained')
    const id = await team(a, [{ id: owner.id, role: 'owner' }])
    await content(a, id, owner.id)
    await deleteTeamWorkspace({ ...owner.options, workspaceId: id })
    await cleanupExpiredWorkspaces(a.db)
    expect(await counts(a, id)).toEqual({ conversations: 1, messages: 3, tasks: 1, files: 1 })
  })

  it('deletes a deleted member’s team AI content without touching other members or credits', async () => {
    const a = app()
    const owner = await actor(a, 'team-owner')
    const member = await actor(a, 'team-member')
    deletedIds.push(member.id)
    const id = await team(a, [
      { id: owner.id, role: 'owner' },
      { id: member.id, role: 'member' },
    ])
    await content(a, id, owner.id)
    const mine = await content(a, id, member.id)
    const pending = await content(a, id, member.id, { heldMessage: true })
    // 个人空间内容走保留期规则，删号清理不处理
    await content(a, member.id, member.id)
    const before = await finance(a, id)

    await deleteAccount(member.options)
    // 删号事务只做账号匿名化；对话等由 jobs 清理分批删除
    expect(await counts(a, id, member.id)).toMatchObject({ conversations: 2, tasks: 2 })
    const result = await purgeDeletedUserAiContent(a.db, { batchSize: 1, maxBatches: 1000 })
    expect(result.remaining).toBe(false)

    // 仍有 held 预扣的消息及其对话保留；任务与其余内容已删除
    expect(await counts(a, id, member.id)).toEqual({
      conversations: 1,
      messages: 1,
      tasks: 0,
      files: 2,
    })
    expect(
      await a.db
        .$client`select m.id from ai_message m join ai_conversation c on c.id=m.conversation_id
        where c.user_id=${member.id} and c.workspace_id=${id}`,
    ).toMatchObject([{ id: pending.assistant }])
    // 团队空间的共享产出文件保留，只解除对已删除任务的引用
    expect(await a.db.$client`select source_task_id from file where id=${mine.file}`).toMatchObject(
      [{ source_task_id: null }],
    )
    expect(await counts(a, id, owner.id)).toEqual({
      conversations: 1,
      messages: 3,
      tasks: 1,
      files: 1,
    })
    expect(await counts(a, member.id, member.id)).toEqual({
      conversations: 1,
      messages: 3,
      tasks: 1,
      files: 1,
    })
    // 评分随消息删除，其他成员与个人空间的评分保留
    expect(await feedbackCount(a, id, member.id)).toBe(0)
    expect(await feedbackCount(a, id, owner.id)).toBe(1)
    expect(await feedbackCount(a, member.id)).toBe(1)
    expect(await finance(a, id)).toEqual(before)
  })

  it('removes growth records and notifications, keeping audit rows free of the email', async () => {
    const a = app()
    const target = await actor(a, 'growth')
    const other = await actor(a, 'growth-other')
    deletedIds.push(target.id)
    const sql = a.db.$client
    growthEmails.push(target.email, other.email)
    await sql`insert into newsletter_subscriber (id,email,confirm_token)
      values (${newId()},${target.email},${newId()}),(${newId()},${other.email},${newId()})`
    await sql`insert into waitlist (id,email) values (${newId()},${target.email}),(${newId()},${other.email})`
    const workspace = await team(a, [{ id: other.id, role: 'owner' }])
    // 邀请会写入 workspace.member_invited 审计；审计行永久保留，不得包含受邀邮箱
    const invited = await a.post(
      '/organization/invite-member',
      { organizationId: workspace, email: target.email, role: 'member' },
      { cookie: other.options.headers.get('cookie') ?? '' },
    )
    expect(invited.status).toBe(200)
    await sql`insert into member (id,organization_id,user_id,role) values (${newId()},${workspace},${target.id},'member')`
    await sql`insert into notification (id,user_id,workspace_id,type,title)
      values (${newId()},${target.id},${workspace},'test','team'),(${newId()},${target.id},null,'test','global'),
        (${newId()},${other.id},${workspace},'test','other')`

    await deleteAccount(target.options)
    const emails = sql([target.email, other.email])
    expect(
      (await sql`select email from newsletter_subscriber where email in ${emails}`).map(
        (r) => r.email,
      ),
    ).toEqual([other.email])
    expect(
      (await sql`select email from waitlist where email in ${emails}`).map((r) => r.email),
    ).toEqual([other.email])
    expect(await sql`select id from notification where user_id=${target.id}`).toHaveLength(0)
    expect(await sql`select id from notification where user_id=${other.id}`).toHaveLength(1)
    // 审计行保留，但不再含原邮箱（用户行已匿名化，审计页显示为已删除用户）
    const audits = await sql<{ action: string; meta: unknown }[]>`select action,meta from audit_log
      where workspace_id=${workspace} or actor_user_id=${target.id} or target_id=${target.id}`
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['workspace.member_invited', 'account.deleted']),
    )
    expect(JSON.stringify(audits).toLowerCase()).not.toContain(target.email.toLowerCase())
  })
})

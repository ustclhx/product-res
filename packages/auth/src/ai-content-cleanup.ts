import type { Database } from '@product-res/db'
import { newId } from '@product-res/shared'
import { log } from '@product-res/shared/log'

export type CleanupWorkspaceShareCards = (
  workspaceId: string,
  options?: { maxIndexes?: number },
) => Promise<
  // biome-ignore lint/suspicious/noConfusingVoidType: 保留已有无返回值清理回调的兼容性。
  { complete: boolean } | void
>

/** 删号后的个人空间不等内容保留期；成功标记与保留期内容清理互不影响。 */
export async function purgeDeletedPersonalWorkspaceShareCards(
  db: Database,
  cleanupShareCards: CleanupWorkspaceShareCards,
  workspaceId?: string,
  options?: { maxIndexes?: number },
) {
  const sql = db.$client
  const workspaces = await sql<{ id: string }[]>`select o.id from organization o
    where o.is_personal and o.deleted_at is not null
      ${workspaceId ? sql`and o.id=${workspaceId}` : sql``}
      and not exists(select 1 from audit_log l where l.workspace_id=o.id
        and l.action='workspace.share-cards.cleanup.completed')
    order by o.id`
  let cleaned = 0
  let failed = 0
  let remaining = 0
  for (const workspace of workspaces) {
    try {
      const result = options
        ? await cleanupShareCards(workspace.id, options)
        : await cleanupShareCards(workspace.id)
      if (result?.complete === false) {
        remaining++
        continue
      }
      await sql`insert into audit_log (id,workspace_id,action,target_type,target_id)
        values (${newId()},${workspace.id},'workspace.share-cards.cleanup.completed','organization',${workspace.id})`
      cleaned++
    } catch {
      failed++
      log.error('workspace.personal-share-cards.cleanup.failed', { workspaceId: workspace.id })
    }
  }
  return { cleaned, failed, remaining }
}

type Transaction = Parameters<Parameters<Database['$client']['begin']>[1]>[0]
type Scope = { readonly workspaceId: string } | { readonly userId: string }
export interface AiPurgeResult {
  messages: number
  conversations: number
  tasks: number
}

/** 单个事务的删除上限；大空间分多批提交，避免长时间持锁。 */
export const AI_PURGE_BATCH_SIZE = 500
/** 单次 cron 的批次上限；剩余数据留给下一轮。 */
export const AI_PURGE_MAX_BATCHES = 200

export const emptyAiPurge = (): AiPurgeResult => ({ messages: 0, conversations: 0, tasks: 0 })
export function addAiPurge(total: AiPurgeResult, batch: AiPurgeResult) {
  total.messages += batch.messages
  total.conversations += batch.conversations
  total.tasks += batch.tasks
}

/**
 * 删除一批 AI 内容，按外键顺序：评分 → 消息 → 无消息的对话 → 媒体任务。
 * 仍有 held 预扣，或一天内仍在生成（streaming / queued / running）的行跳过，等兜底处理器结算后下一轮再删；
 * 预扣、积分流水等财务记录不删，它们只以 ref_id 文本指向这些行。
 * 团队空间中的产出文件属于空间共享资产，只解除 source_task_id 引用、不删文件。
 */
export async function purgeAiBatch(
  sql: Transaction,
  scope: Scope,
  limit = AI_PURGE_BATCH_SIZE,
): Promise<AiPurgeResult> {
  const byWorkspace = 'workspaceId' in scope
  const conversationScope = byWorkspace
    ? sql`c.workspace_id=${scope.workspaceId}`
    : sql`c.user_id=${scope.userId} and exists(select 1 from organization o where o.id=c.workspace_id and not o.is_personal)`
  const taskScope = byWorkspace
    ? sql`t.workspace_id=${scope.workspaceId}`
    : sql`t.user_id=${scope.userId} and exists(select 1 from organization o where o.id=t.workspace_id and not o.is_personal)`
  // 先选出本批消息，删除其上的评分（add-subject-chat），再删消息本身
  const batch = await sql<{ id: string }[]>`
    select m.id from ai_message m join ai_conversation c on c.id=m.conversation_id
    where ${conversationScope}
      and not (m.status='streaming' and m.updated_at>now()-interval '1 day')
      and not exists(select 1 from credit_hold h where h.workspace_id=m.workspace_id and h.status='held'
        and (h.id=m.hold_id or (h.ref_type='ai_message' and h.ref_id=m.id)))
    order by m.id limit ${limit} for update of m skip locked`
  const messageIds = batch.map((row) => row.id)
  let messages: { id: string }[] = []
  if (messageIds.length) {
    await sql`delete from ai_message_feedback where message_id in ${sql(messageIds)}`
    messages = await sql<{ id: string }[]>`
      delete from ai_message where id in ${sql(messageIds)} returning id`
  }
  const conversations = await sql<{ id: string }[]>`
    delete from ai_conversation where id in (
      select c.id from ai_conversation c where ${conversationScope}
        and not exists(select 1 from ai_message m where m.conversation_id=c.id)
      order by c.id limit ${limit}
    ) returning id`
  const tasks = await sql<{ id: string }[]>`
    select t.id from ai_task t where ${taskScope}
      and not (t.status in ('queued','running') and t.updated_at>now()-interval '1 day')
      and not exists(select 1 from credit_hold h where h.workspace_id=t.workspace_id and h.status='held'
        and (h.id=t.hold_id or (h.ref_type='ai_task' and h.ref_id=t.id)))
    order by t.id limit ${limit} for update of t skip locked`
  const taskIds = tasks.map((task) => task.id)
  if (taskIds.length) {
    await sql`update file set source_task_id=null,updated_at=now() where source_task_id in ${sql(taskIds)}`
    await sql`delete from ai_task where id in ${sql(taskIds)}`
  }
  return {
    messages: messages.length,
    conversations: conversations.length,
    tasks: taskIds.length,
  }
}

/**
 * 删号后团队空间中该用户的对话、消息与媒体任务（个人空间走保留期清理）。
 * 按已删除用户扫描，每批一个事务，批次总数有上限，剩余的留给下一轮。
 */
export async function purgeDeletedUserAiContent(
  db: Database,
  { batchSize = AI_PURGE_BATCH_SIZE, maxBatches = AI_PURGE_MAX_BATCHES } = {},
) {
  // 占位邮箱与 deleteAccount 写入的格式一致，是"账号已删除"的唯一判据。
  const users = await db.$client<{ id: string }[]>`
    select u.id from "user" u where u.email='deleted+'||u.id::text||'@invalid' and (
      exists(select 1 from ai_conversation c join organization o on o.id=c.workspace_id
        where c.user_id=u.id and not o.is_personal)
      or exists(select 1 from ai_task t join organization o on o.id=t.workspace_id
        where t.user_id=u.id and not o.is_personal))
    order by u.id`
  const total = emptyAiPurge()
  let batches = 0
  let remaining = false
  for (const { id } of users) {
    for (;;) {
      if (batches >= maxBatches) {
        remaining = true
        break
      }
      batches++
      const batch = await db.$client.begin((sql) => purgeAiBatch(sql, { userId: id }, batchSize))
      addAiPurge(total, batch)
      // 一批不满说明该用户剩下的都是被跳过的行（held 预扣或仍在生成）。
      if (Math.max(batch.messages, batch.conversations, batch.tasks) < batchSize) break
    }
    if (remaining) break
  }
  return { users: users.length, ...total, remaining }
}

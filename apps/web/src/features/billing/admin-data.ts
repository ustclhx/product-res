import {
  creditGrant,
  type Database,
  payment,
  purchase,
  refundRequest,
  subscription,
  webhookEvent,
} from '@product-res/db'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { ADMIN_PAGE_SIZE } from '../admin/list.ts'

export interface BillingListInput {
  offset: number
  workspaceId?: string | undefined
}
const pageResult = <T>(rows: T[]) => ({
  rows: rows.slice(0, ADMIN_PAGE_SIZE),
  hasMore: rows.length > ADMIN_PAGE_SIZE,
})

export async function listAdminPayments(db: Database, data: BillingListInput) {
  const rows = await db
    .select({
      id: payment.id,
      workspaceId: payment.workspaceId,
      provider: payment.provider,
      amount: payment.amount,
      refundedAmount: payment.refundedAmount,
      currency: payment.currency,
      status: payment.status,
      kind: payment.kind,
    })
    // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads.
    .from(payment)
    .where(data.workspaceId ? eq(payment.workspaceId, data.workspaceId) : undefined)
    .orderBy(desc(payment.createdAt), desc(payment.id))
    .limit(ADMIN_PAGE_SIZE + 1)
    .offset(data.offset)
  return pageResult(rows)
}
export async function listAdminSubscriptions(db: Database, data: BillingListInput) {
  const rows = await db
    .select({
      id: subscription.id,
      workspaceId: subscription.workspaceId,
      provider: subscription.provider,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
    })
    // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads, including overlapping subscriptions.
    .from(subscription)
    .where(data.workspaceId ? eq(subscription.workspaceId, data.workspaceId) : undefined)
    .orderBy(desc(subscription.createdAt), desc(subscription.id))
    .limit(ADMIN_PAGE_SIZE + 1)
    .offset(data.offset)
  return pageResult(rows)
}
export async function listAdminPurchases(db: Database, data: BillingListInput) {
  const rows = await db
    .select({
      id: purchase.id,
      workspaceId: purchase.workspaceId,
      provider: purchase.provider,
      status: purchase.status,
      amount: purchase.amount,
      currency: purchase.currency,
      paidAt: purchase.paidAt,
    })
    // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace billing reads.
    .from(purchase)
    .where(data.workspaceId ? eq(purchase.workspaceId, data.workspaceId) : undefined)
    .orderBy(desc(purchase.createdAt), desc(purchase.id))
    .limit(ADMIN_PAGE_SIZE + 1)
    .offset(data.offset)
  return pageResult(rows)
}

/** 回调表没有空间列：按已验证载荷中的结账元数据或本地账务的平台 ID 关联，筛选先于分页。 */
export async function listAdminWebhooks(db: Database, data: BillingListInput) {
  const workspace = data.workspaceId
  const hasIdentity = (
    id:
      | typeof subscription.providerSubscriptionId
      | typeof payment.providerPaymentId
      | typeof purchase.providerOrderId,
  ) =>
    sql`jsonb_path_exists(${webhookEvent.payload}, '$.** ? (@ == $id)', jsonb_build_object('id', ${id}))`
  const association = workspace
    ? sql`(
    jsonb_path_exists(${webhookEvent.payload}, '$.**.workspaceId ? (@ == $id)', jsonb_build_object('id', ${workspace}::text))
    or jsonb_path_exists(${webhookEvent.payload}, ${`$.**.custom_id ? (@ like_regex "${workspace}" flag "i")`}::jsonpath)
    or exists (select 1 from ${subscription} where ${subscription.workspaceId} = ${workspace} and ${subscription.provider} = ${webhookEvent.provider} and ${hasIdentity(subscription.providerSubscriptionId)})
    or exists (select 1 from ${payment} where ${payment.workspaceId} = ${workspace} and ${payment.provider} = ${webhookEvent.provider} and ${hasIdentity(payment.providerPaymentId)})
    or exists (select 1 from ${purchase} where ${purchase.workspaceId} = ${workspace} and ${purchase.provider} = ${webhookEvent.provider} and ${hasIdentity(purchase.providerOrderId)})
  )`
    : undefined
  const rows = await db
    .select({
      id: webhookEvent.id,
      provider: webhookEvent.provider,
      providerEventId: webhookEvent.providerEventId,
      type: webhookEvent.type,
      status: webhookEvent.status,
      attempts: webhookEvent.attempts,
    })
    .from(webhookEvent)
    .where(association)
    .orderBy(desc(webhookEvent.receivedAt), desc(webhookEvent.id))
    .limit(ADMIN_PAGE_SIZE + 1)
    .offset(data.offset)
  return pageResult(rows)
}

export async function listAdminRefunds(db: Database, data: BillingListInput) {
  const found = await db
    .select({
      id: refundRequest.id,
      workspaceId: refundRequest.workspaceId,
      reason: refundRequest.reason,
      requestedAmount: refundRequest.requestedAmount,
      approvedAmount: refundRequest.approvedAmount,
      status: refundRequest.status,
      reviewNote: refundRequest.reviewNote,
      reviewerId: refundRequest.reviewerId,
      providerRefundId: refundRequest.providerRefundId,
      paymentId: payment.id,
      provider: payment.provider,
      currency: payment.currency,
      paymentAmount: payment.amount,
      refundedAmount: payment.refundedAmount,
    })
    // biome-ignore lint/plugin: Fresh platform-admin middleware authorizes bounded cross-workspace refund reads.
    .from(refundRequest)
    .innerJoin(
      payment,
      and(
        eq(payment.id, refundRequest.paymentId),
        eq(payment.workspaceId, refundRequest.workspaceId),
      ),
    )
    .where(data.workspaceId ? eq(refundRequest.workspaceId, data.workspaceId) : undefined)
    .orderBy(desc(refundRequest.createdAt), desc(refundRequest.id))
    .limit(ADMIN_PAGE_SIZE + 1)
    .offset(data.offset)
  const { rows, hasMore } = pageResult(found)
  const totals = rows.length
    ? await db
        .select({
          paymentId: creditGrant.paymentId,
          original: sql<number>`coalesce(sum(${creditGrant.amount}),0)::int`,
          remaining: sql<number>`coalesce(sum(${creditGrant.remaining}),0)::int`,
        })
        // biome-ignore lint/plugin: Platform-admin reads credit totals only for the bounded page of owned payment references.
        .from(creditGrant)
        .where(
          inArray(
            creditGrant.paymentId,
            rows.map((row) => row.paymentId),
          ),
        )
        .groupBy(creditGrant.paymentId)
    : []
  return {
    rows: rows.map((row) => ({
      ...row,
      remainingRefundable: row.paymentAmount - row.refundedAmount,
      originalCredits: totals.find((t) => t.paymentId === row.paymentId)?.original ?? 0,
      remainingCredits: totals.find((t) => t.paymentId === row.paymentId)?.remaining ?? 0,
    })),
    hasMore,
  }
}

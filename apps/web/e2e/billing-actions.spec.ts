import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  applyBillingEvent,
  cancelSubscription,
  type NormalizedEvent,
  type PaymentProvider,
  prepareBillingEvents,
  type RefundInput,
  resumeSubscription,
  reviewRefundRequest,
  type SubscriptionSnapshot,
  submitRefundRequest,
} from '@product-res/billing'
import { getCreditBalance, grant } from '@product-res/credits'
import {
  creditGrant,
  payment,
  plan,
  planPrice,
  purchase,
  refundRequest,
  subscription,
  user,
} from '@product-res/db'
import { eq } from 'drizzle-orm'
import templateConfig from '../../../template.config.ts'
import { actionDb, actor, offlineProviderTransport } from './billing-actions-helper.ts'
import { register, simulateClientIp, uiText, waitForHydration } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

async function catalog(db: ReturnType<typeof actionDb>, subscriptionPlan = false) {
  const planId = randomUUID()
  const priceId = randomUUID()
  await db.insert(plan).values({
    id: planId,
    key: planId,
    name: 'Offline actions fixture',
    type: subscriptionPlan ? 'subscription' : 'credit_pack',
    credits: 100,
    features: {
      models: [],
      maxConcurrentTasks: 1,
      maxSeats: 1,
      storageGb: 1,
      publicApi: false,
      priorityQueue: false,
      watermark: true,
    },
  })
  await db.insert(planPrice).values({
    id: priceId,
    planId,
    provider: 'stripe',
    providerPriceId: `offline:${priceId}`,
    amount: 1000,
    currency: 'USD',
    interval: subscriptionPlan ? 'month' : null,
  })
  return { planId, priceId }
}

for (const realSubmission of [true, false])
  test(
    realSubmission
      ? 'real customer refund submission saves contact and rejects duplicates'
      : 'offline partial admin approval preserves money until callback',
    async ({ page }) => {
      test.skip(
        !realSubmission && !templateConfig.billing.providers.includes('stripe'),
        '模板配置关闭了 Stripe 退款审批渠道',
      )
      const db = actionDb()
      try {
        const email = `refund-actions-${randomUUID()}@example.com`
        await simulateClientIp(page)
        await stubTurnstile(page)
        await register(page, email)
        await waitForHydration(page)
        const owner = await actor(email)
        const { planId, priceId } = await catalog(db)
        const purchaseId = randomUUID()
        const paymentId = randomUUID()
        await db.insert(purchase).values({
          id: purchaseId,
          workspaceId: owner.workspaceId,
          userId: owner.userId,
          planId,
          planPriceId: priceId,
          provider: 'stripe',
          providerOrderId: purchaseId,
          status: 'paid',
          amount: 1000,
          currency: 'USD',
        })
        await db.insert(payment).values({
          id: paymentId,
          workspaceId: owner.workspaceId,
          provider: 'stripe',
          providerPaymentId: paymentId,
          purchaseId,
          planPriceId: priceId,
          kind: 'one_time',
          amount: 1000,
          currency: 'USD',
          paidAt: new Date(),
        })
        await grant(db, {
          workspaceId: owner.workspaceId,
          source: 'purchase',
          sourceRef: paymentId,
          paymentId,
          amount: 100,
        })
        if (realSubmission) {
          await page.goto(`/app/${owner.slug}/billing`)
          await waitForHydration(page)
          const form = page.getByRole('form', { name: 'Request a refund' })
          await form.getByRole('combobox', { name: 'Payment', exact: true }).selectOption(paymentId)
          await form
            .getByLabel('Reason', { exact: true })
            .fill('Please return part of this payment')
          await form.getByLabel('Contact email').fill('retained-contact@example.com')
          const submission = page.waitForRequest(
            (request) => request.method() === 'POST' && request.url().includes('/_serverFn/'),
          )
          await form.getByRole('button', { name: 'Submit refund request' }).click()
          const submitted = await submission
          expect(submitted.postData()).toContain(paymentId)
          await expect(page.getByText('Refund request submitted.', { exact: false })).toBeVisible()
          await expect(
            page.getByText('No eligible payments without a pending request.'),
          ).toBeVisible()
          const requests = await db
            .select()
            .from(refundRequest)
            .where(eq(refundRequest.paymentId, paymentId))
          expect(requests).toHaveLength(1)
          const request = requests[0]
          if (!request) throw new Error('Missing saved request')
          expect(request).toMatchObject({
            status: 'pending',
            contactEmail: 'retained-contact@example.com',
            reason: 'Please return part of this payment',
            userId: owner.userId,
          })
          // Replay the actual authenticated browser submission: the real server rejects duplicates.
          const duplicate = await page.context().request.post(submitted.url(), {
            headers: submitted.headers(),
            data: submitted.postData() ?? '',
          })
          expect(await duplicate.text()).toContain('REFUND_ALREADY_PENDING')
          expect(
            await db.select().from(refundRequest).where(eq(refundRequest.paymentId, paymentId)),
          ).toHaveLength(1)
          return
        }
        const request = await submitRefundRequest(
          { db, providers: {}, config: { refundWindowDays: 30 }, notify: async () => {} },
          {
            ...owner,
            paymentId,
            reason: 'Offline partial review',
            contactEmail: 'retained-contact@example.com',
          },
        )
        await db.update(user).set({ role: 'admin' }).where(eq(user.id, owner.userId))
        await page.goto('/admin/billing')
        await waitForHydration(page)
        const calls: RefundInput[] = []
        const provider = {
          id: 'stripe',
          capabilities: { refundsViaApi: true },
          refund: async (input: RefundInput) => {
            calls.push(input)
            return { providerRefundId: `offline-refund:${request.id}` }
          },
        } as unknown as PaymentProvider
        const options = {
          db,
          providers: { stripe: provider },
          config: { refundWindowDays: 30 },
          notify: async () => {},
        }
        await offlineProviderTransport(page, async (data) => {
          expect(data).toEqual({
            requestId: request.id,
            decision: 'approve',
            approvedAmount: 400,
            reviewNote: 'Partial review offline',
          })
          const saved = await reviewRefundRequest(options, {
            userId: owner.userId,
            requestId: String(data.requestId),
            decision: 'approve',
            approvedAmount: Number(data.approvedAmount),
            reviewNote: String(data.reviewNote),
          })
          return { ok: true, status: saved.status }
        })
        await page
          .getByRole('navigation', { name: uiText('admin_admin_sections') })
          .getByRole('link', { name: uiText('admin_refund_reviews'), exact: true })
          .click()
        const article = page.getByRole('article', {
          name: uiText('admin_refund', { id: request.id }),
          exact: true,
        })
        await article.getByLabel(uiText('admin_review_note_field')).fill('Partial review offline')
        await article.getByLabel(uiText('admin_partial_amount_usd_cents')).fill('400')
        await article.getByRole('button', { name: uiText('admin_approve_partial_refund') }).click()
        await expect(
          article.getByText(`${uiText('admin_status_inline')} approved`, { exact: false }),
        ).toBeVisible()
        expect(calls).toEqual([
          {
            providerPaymentId: paymentId,
            kind: 'one_time',
            currency: 'USD',
            amount: 400,
            idempotencyKey: `refund:${request.id}`,
          },
        ])
        await article
          .getByRole('button', { name: uiText('admin_retry_approved_refund_api') })
          .click()
        await expect(
          article.getByRole('button', { name: uiText('admin_retry_approved_refund_api') }),
        ).toBeEnabled()
        expect(calls).toHaveLength(1)
        expect((await db.select().from(payment).where(eq(payment.id, paymentId)))[0]).toMatchObject(
          {
            status: 'succeeded',
            refundedAmount: 0,
          },
        )
        expect(
          (await db.select().from(creditGrant).where(eq(creditGrant.paymentId, paymentId)))[0]
            ?.remaining,
        ).toBe(100)
        const callback: NormalizedEvent = {
          provider: 'stripe',
          type: 'payment.refunded',
          occurredAt: new Date(),
          raw: {},
          providerPaymentId: paymentId,
          providerRefundId: `offline-refund:${request.id}`,
          amount: 400,
          currency: 'USD',
          refundedAmount: 400,
        }
        const prepared = await prepareBillingEvents([callback], db, options.providers)
        await db.transaction((tx) => applyBillingEvent(tx, callback, prepared))
        await db.transaction((tx) => applyBillingEvent(tx, callback, prepared))
        expect((await db.select().from(payment).where(eq(payment.id, paymentId)))[0]).toMatchObject(
          {
            status: 'partially_refunded',
            refundedAmount: 400,
          },
        )
        expect(
          (await db.select().from(refundRequest).where(eq(refundRequest.id, request.id)))[0]
            ?.status,
        ).toBe('refunded')
        expect(
          (await db.select().from(creditGrant).where(eq(creditGrant.paymentId, paymentId)))[0]
            ?.remaining,
        ).toBe(0)
      } finally {
        await db.$client.end()
      }
    },
  )

test('offline browser cancel and resume call real services without minting credits', async ({
  page,
}) => {
  test.skip(
    !templateConfig.billing.providers.includes('stripe'),
    '模板配置关闭了 Stripe 订阅管理渠道',
  )
  const db = actionDb()
  try {
    const email = `subscription-actions-${randomUUID()}@example.com`
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    await waitForHydration(page)
    const owner = await actor(email)
    const { planId, priceId } = await catalog(db, true)
    const id = randomUUID()
    const start = new Date()
    const end = new Date(start.getTime() + 86400000 * 20)
    await db.insert(subscription).values({
      id,
      workspaceId: owner.workspaceId,
      planId,
      planPriceId: priceId,
      provider: 'stripe',
      providerSubscriptionId: id,
      status: 'active',
      currentPeriodStart: start,
      currentPeriodEnd: end,
      lastEventAt: start,
    })
    let snapshot: SubscriptionSnapshot = {
      providerSubscriptionId: id,
      providerCustomerId: null,
      providerPriceId: `offline:${priceId}`,
      status: 'active',
      remoteStatus: 'active',
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      trialEnd: null,
      pastDueSince: null,
      metadata: null,
      raw: {},
    }
    const actions: string[] = []
    const provider = {
      id: 'stripe',
      cancelSubscription: async (remoteId: string, opts: { atPeriodEnd: boolean }) => {
        expect(remoteId).toBe(id)
        expect(opts).toEqual({ atPeriodEnd: true })
        snapshot = { ...snapshot, cancelAtPeriodEnd: true }
      },
      resumeSubscription: async (remoteId: string) => {
        expect(remoteId).toBe(id)
        snapshot = { ...snapshot, cancelAtPeriodEnd: false }
      },
      getSubscription: async () => snapshot,
    } as unknown as PaymentProvider
    const ctx = { db, providers: { stripe: provider }, enabledProviders: ['stripe'] as const }
    const before = await getCreditBalance(db, owner.workspaceId)
    const grants = await db
      .select()
      .from(creditGrant)
      .where(eq(creditGrant.workspaceId, owner.workspaceId))
    await page.goto(`/app/${owner.slug}/billing-return`)
    await waitForHydration(page)
    await offlineProviderTransport(page, async (data) => {
      expect(data.slug).toBe(owner.slug)
      expect(data.subscriptionId).toBe(id)
      actions.push(String(data.action))
      const input = { ...owner, subscriptionId: String(data.subscriptionId) }
      if (data.action === 'cancel') await cancelSubscription(ctx, input)
      else {
        expect(data.action).toBe('resume')
        await resumeSubscription(ctx, input)
      }
      return { ok: true, result: { status: 'updated' } }
    })
    await page.getByRole('link', { name: 'Return to billing', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel at period end' }).click()
    await expect(page.getByRole('button', { name: 'Resume subscription' })).toBeEnabled()
    expect((await db.select().from(subscription).where(eq(subscription.id, id)))[0]).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: end,
    })
    await page.getByRole('button', { name: 'Resume subscription' }).click()
    await expect(page.getByRole('button', { name: 'Cancel at period end' })).toBeEnabled()
    expect((await db.select().from(subscription).where(eq(subscription.id, id)))[0]).toMatchObject({
      status: 'active',
      cancelAtPeriodEnd: false,
      currentPeriodEnd: end,
    })
    expect(actions).toEqual(['cancel', 'resume'])
    expect(await getCreditBalance(db, owner.workspaceId)).toEqual(before)
    expect(
      await db.select().from(creditGrant).where(eq(creditGrant.workspaceId, owner.workspaceId)),
    ).toEqual(grants)
  } finally {
    await db.$client.end()
  }
})

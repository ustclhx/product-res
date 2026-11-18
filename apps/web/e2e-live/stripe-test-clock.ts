import { createStripeClient } from '../../../packages/billing/src/stripe/client.ts'
import { changeStripePlan } from '../../../packages/billing/src/stripe/operations.ts'
import {
  classifyStripeBillingReason,
  stripeInvoiceLines,
  stripeSubscriptionLines,
} from '../../../packages/billing/src/stripe/snapshots.ts'

// Stripe 测试时钟辅助：供 harden 7.3「月付↔年付周期末切换」的平台实验与应用端到端用例共用。
// 只接受 sk_test_ 密钥；请求与报错都不带出凭据、请求 URL 或平台响应正文。
export const STRIPE_API_VERSION = '2026-09-30.endive'
/** 实验对象统一标记，便于在 Stripe Dashboard 中识别和清理 */
export const ACCEPTANCE_TAG = 'harden-7.3'

type Params = Record<string, unknown>

function encode(params: Params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === 'object')
          encode(item as Params, `${name}[${index}]`, out)
        else out.append(`${name}[${index}]`, String(item))
      })
    } else if (value !== null && typeof value === 'object') encode(value as Params, name, out)
    else out.append(name, String(value))
  }
  return out
}

export async function stripeApi<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Params = {},
): Promise<T> {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret?.startsWith('sk_test_'))
    throw new Error('Test-clock acceptance requires a Stripe test-mode secret')
  if (!/^[a-zA-Z0-9_/]+$/.test(path)) throw new Error('Stripe acceptance path is invalid')
  const body = encode(params)
  const query = method === 'GET' && body.size ? `?${body}` : ''
  const response = await fetch(`https://api.stripe.com/v1/${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': STRIPE_API_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' ? { body } : {}),
  }).catch(() => {
    throw new Error(`Stripe acceptance ${method} ${path.split('/')[0]} failed`)
  })
  const result = (await response.json().catch(() => ({}))) as T & {
    livemode?: boolean
    error?: { code?: string; type?: string; message?: string }
  }
  if (!response.ok)
    throw new Error(
      `Stripe acceptance ${method} ${path.split('/')[0]} returned HTTP ${response.status} ${result.error?.code ?? result.error?.type ?? ''} ${process.env.STRIPE_ACCEPTANCE_DEBUG ? (result.error?.message ?? '') : ''}`.trim(),
    )
  if (result.livemode === true) throw new Error('Stripe acceptance returned a live-mode object')
  return result
}

export interface TestClock {
  id: string
  status: 'ready' | 'advancing' | 'internal_failure'
  frozen_time: number
}

export async function createTestClock(name: string, frozenTime = Math.floor(Date.now() / 1000)) {
  return stripeApi<TestClock>('POST', 'test_helpers/test_clocks', {
    frozen_time: frozenTime,
    name: `saasAcceptance=${ACCEPTANCE_TAG} ${name}`.slice(0, 300),
  })
}

/** 推进到目标时间并等待 Stripe 处理完该时段内的续费、开票与扣款 */
export async function advanceTestClock(id: string, to: number, timeoutMs = 240_000) {
  await stripeApi('POST', `test_helpers/test_clocks/${id}/advance`, { frozen_time: to })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const clock = await stripeApi<TestClock>('GET', `test_helpers/test_clocks/${id}`)
    if (clock.status === 'ready' && clock.frozen_time === to) return clock
    if (clock.status === 'internal_failure') throw new Error('Stripe test clock advance failed')
    if (Date.now() > deadline) throw new Error('Stripe test clock did not become ready in time')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

const DAY = 86_400

/**
 * Stripe 每次最多推进两个最短计费周期（schedule 中含月付价格时为两个月），
 * 跨年需分段推进；每段 50 天，最后一段直达目标。
 */
export async function advanceTestClockTo(clock: TestClock, to: number) {
  for (let at = clock.frozen_time + 50 * DAY; at < to; at += 50 * DAY)
    await advanceTestClock(clock.id, at)
  return advanceTestClock(clock.id, to)
}

/** 删除测试时钟会同时删除挂在其上的 customer 与订阅；清理失败不覆盖原始断言错误 */
export async function deleteTestClock(id: string) {
  await stripeApi('DELETE', `test_helpers/test_clocks/${id}`).catch(() => undefined)
}

/** 挂在测试时钟上的 customer；只有创建时能指定 test_clock，因此必须由验收预先建立 */
export async function createClockCustomer(clockId: string, email: string, withCard: boolean) {
  const customer = await stripeApi<{ id: string }>('POST', 'customers', {
    test_clock: clockId,
    email,
    metadata: { saasAcceptance: ACCEPTANCE_TAG },
    ...(withCard ? { payment_method: 'pm_card_visa' } : {}),
  })
  if (withCard) {
    // pm_card_visa 附加后得到新的 pm_ 标识，需以实际 id 作为默认付款方式
    const methods = await stripeApi<{ data: { id: string }[] }>('GET', 'payment_methods', {
      customer: customer.id,
      type: 'card',
    })
    const method = methods.data[0]?.id
    if (!method) throw new Error('Test-clock customer has no card')
    await stripeApi('POST', `customers/${customer.id}`, {
      invoice_settings: { default_payment_method: method },
    })
  }
  return customer
}

export interface InvoiceSummary {
  id: string
  billingReason: string | null
  status: string
  amountDue: number
  amountPaid: number
  currency: string
  created: number
  periodStart: number
  periodEnd: number
  lines: {
    priceId: string | null
    amount: number
    proration: boolean
    periodStart: number
    periodEnd: number
  }[]
}

interface StripeInvoice {
  id: string
  billing_reason: string | null
  status: string
  amount_due: number
  amount_paid: number
  currency: string
  created: number
  period_start: number
  period_end: number
  lines: {
    has_more: boolean
    data: {
      amount: number
      period: { start: number; end: number }
      pricing?: { price_details?: { price?: string | { id: string } } } | null
      parent?: { subscription_item_details?: { proration?: boolean } | null } | null
    }[]
  }
}

/** 只保留开票原因、金额、周期与价格，不带出联系方式或托管页 URL */
export async function customerInvoices(customerId: string): Promise<InvoiceSummary[]> {
  const result = await stripeApi<{ data: StripeInvoice[]; has_more: boolean }>('GET', 'invoices', {
    customer: customerId,
    limit: 100,
  })
  if (result.has_more) throw new Error('Test-clock customer has too many invoices')
  return result.data
    .map((invoice) => ({
      id: invoice.id,
      billingReason: invoice.billing_reason,
      status: invoice.status,
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency.toUpperCase(),
      created: invoice.created,
      periodStart: invoice.period_start,
      periodEnd: invoice.period_end,
      lines: invoice.lines.data.map((line) => {
        const price = line.pricing?.price_details?.price
        return {
          priceId: typeof price === 'string' ? price : (price?.id ?? null),
          amount: line.amount,
          proration: Boolean(line.parent?.subscription_item_details?.proration),
          periodStart: line.period.start,
          periodEnd: line.period.end,
        }
      }),
    }))
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
}

interface StripeEvent {
  id: string
  type: string
  created: number
  data: {
    object: {
      id?: string
      object?: string
      customer?: string | { id: string } | null
      billing_reason?: string | null
      status?: string
    }
  }
}

/** 列出与该 customer 相关的事件（时间正序），只保留类型与开票原因 */
export async function customerEvents(customerId: string, since: number) {
  const events: StripeEvent[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < 10; page++) {
    const result = await stripeApi<{ data: StripeEvent[]; has_more: boolean }>('GET', 'events', {
      created: { gte: since },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    })
    events.push(...result.data)
    if (!result.has_more) break
    startingAfter = result.data.at(-1)?.id
  }
  return events
    .filter((event) => {
      const object = event.data.object
      const customer =
        typeof object.customer === 'string' ? object.customer : (object.customer?.id ?? null)
      return customer === customerId || object.id === customerId
    })
    .reverse()
    .map((event) => ({
      id: event.id,
      type: event.type,
      object: event.data.object.object ?? null,
      objectId: event.data.object.id ?? null,
      ...(event.data.object.object === 'invoice'
        ? {
            billingReason: event.data.object.billing_reason ?? null,
            status: event.data.object.status,
          }
        : {}),
    }))
}

export interface ScheduleSummary {
  id: string
  status: string
  endBehavior: string
  saasManaged: string | null
  phases: {
    start: number
    end: number
    prorationBehavior: string | null
    items: { providerPriceId: string; quantity: number }[]
  }[]
}

export async function scheduleSummary(id: string): Promise<ScheduleSummary> {
  const schedule = await stripeApi<{
    id: string
    status: string
    end_behavior: string
    metadata: { saasManaged?: string }
    phases: {
      start_date: number
      end_date: number
      proration_behavior: string | null
      items: { price: string | { id: string }; quantity: number }[]
    }[]
  }>('GET', `subscription_schedules/${id}`)
  return {
    id: schedule.id,
    status: schedule.status,
    endBehavior: schedule.end_behavior,
    saasManaged: schedule.metadata.saasManaged ?? null,
    phases: schedule.phases.map((phase) => ({
      start: phase.start_date,
      end: phase.end_date,
      prorationBehavior: phase.proration_behavior,
      items: phase.items.map((item) => ({
        providerPriceId: typeof item.price === 'string' ? item.price : item.price.id,
        quantity: item.quantity,
      })),
    })),
  }
}

export interface SubscriptionSummary {
  id: string
  status: string
  priceId: string
  interval: string
  periodStart: number
  periodEnd: number
  scheduleId: string | null
  cancelAtPeriodEnd: boolean
}

export async function subscriptionSummary(id: string): Promise<SubscriptionSummary> {
  const subscription = await stripeApi<{
    id: string
    status: string
    cancel_at_period_end: boolean
    schedule: string | { id: string } | null
    items: {
      has_more: boolean
      data: {
        price: { id: string; recurring: { interval: string } | null }
        current_period_start: number
        current_period_end: number
      }[]
    }
  }>('GET', `subscriptions/${id}`)
  const item = subscription.items.data[0]
  if (!item || subscription.items.has_more || subscription.items.data.length !== 1)
    throw new Error('Test-clock subscription requires one item')
  return {
    id: subscription.id,
    status: subscription.status,
    priceId: item.price.id,
    interval: item.price.recurring?.interval ?? '',
    periodStart: item.current_period_start,
    periodEnd: item.current_period_end,
    scheduleId:
      typeof subscription.schedule === 'string'
        ? subscription.schedule
        : (subscription.schedule?.id ?? null),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  }
}

function productStripe() {
  const secret = process.env.STRIPE_SECRET_KEY
  if (!secret?.startsWith('sk_test_'))
    throw new Error('Test-clock acceptance requires a Stripe test-mode secret')
  return createStripeClient(secret)
}

/** 直接调用产品的发票分类（含发票订阅行），判断这张发票会按哪类付款入账；不在验收侧另维护镜像 */
export async function productInvoiceKind(invoiceId: string) {
  const stripe = productStripe()
  const invoice = await stripe.invoices.retrieve(invoiceId)
  return classifyStripeBillingReason(
    invoice.billing_reason,
    stripeSubscriptionLines(invoice, await stripeInvoiceLines(stripe, invoice)),
  )
}

/** 直接调用产品的 changeStripePlan(atPeriodEnd) 写入 schedule，Stripe 侧参数与线上完全一致 */
export async function productScheduleChange(
  subscriptionId: string,
  target: { providerPriceId: string; interval: 'month' | 'year'; amount: number },
) {
  await changeStripePlan(
    productStripe(),
    subscriptionId,
    {
      id: crypto.randomUUID(),
      planId: crypto.randomUUID(),
      provider: 'stripe',
      providerPriceId: target.providerPriceId,
      interval: target.interval,
      amount: target.amount,
      currency: 'USD',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    { atPeriodEnd: true },
  )
}

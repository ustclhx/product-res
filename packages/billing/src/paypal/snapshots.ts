import type { JsonValue, SubscriptionStatus } from '@product-res/db/schema'
import type {
  CheckoutMetadata,
  OrderSnapshot,
  PaymentProvider,
  PaymentReference,
  PaymentSnapshot,
  SubscriptionSnapshot,
} from '../provider.ts'
import { decodePayPalMetadata } from './metadata.ts'
import { fromPayPalDecimal } from './money.ts'
import type { PayPalTransport } from './transport.ts'

export type PayPalSnapshots = Pick<PaymentProvider, 'getSubscription' | 'getOrder' | 'getPayment'>
export interface PayPalRecordedSale {
  providerPaymentId: string
  providerSubscriptionId: string
  providerPriceId: string
  workspaceId: string
  planPriceId: string
  kind: 'initial' | 'renewal'
  amount: number
  currency: string
  paidAt: Date
  period: { start: Date; end: Date }
}
export type PayPalSaleLookup = (saleId: string) => Promise<PayPalRecordedSale | null>
type Money = { value: string; currency_code: string }
type Link = { rel: string; href: string }
export interface PayPalSubscriptionPayload {
  id: string
  plan_id: string
  status: string
  start_time?: string
  status_update_time?: string
  custom_id?: string
  plan_overridden?: boolean
  quantity?: string
  subscriber?: { payer_id?: string }
  billing_info?: { last_payment?: { time: string; amount: Money }; next_billing_time?: string }
}
export interface PayPalPlanPayload {
  id: string
  billing_cycles: {
    tenure_type: string
    frequency: { interval_unit: string; interval_count: number }
    pricing_scheme: { fixed_price?: Money; version?: number }
    total_cycles: number
  }[]
  payment_preferences?: { setup_fee?: Money }
}
export interface PayPalCapturePayload {
  id: string
  status: string
  amount: Money
  create_time: string
  supplementary_data?: { related_ids?: { order_id?: string } }
  links?: Link[]
}
export interface PayPalOrderPayload {
  id: string
  status: string
  payer?: { payer_id?: string }
  payment_source?: { paypal?: { account_id?: string } }
  purchase_units: {
    custom_id?: string
    amount: Money
    payments?: { captures?: PayPalCapturePayload[] }
  }[]
}
export interface PayPalSalePayload {
  id: string
  state: string
  amount: { total: string; currency: string }
  create_time: string
  billing_agreement_id?: string
}
type Transactions = {
  transactions: {
    id: string
    status: string
    time: string
    amount_with_breakdown: { gross_amount: Money }
  }[]
  total_items?: number
  total_pages?: number
  links?: Link[]
}

export class PayPalSnapshotCapabilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayPalSnapshotCapabilityError'
  }
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Invalid PayPal resource ID')
  return value
}
/** Reject non-JSON values instead of silently dropping them during serialization. */
export function payPalRaw(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(payPalRaw)
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, payPalRaw(item)]))
  throw new Error('Invalid PayPal JSON payload')
}
export function payPalDate(value: unknown): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    throw new Error('Invalid PayPal date')
  const date = new Date(value)
  const day = Number(value.slice(8, 10))
  const month = Number(value.slice(5, 7))
  const maxDay = new Date(Date.UTC(Number(value.slice(0, 4)), month, 0)).getUTCDate()
  if (
    !Number.isFinite(date.getTime()) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maxDay ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    throw new Error('Invalid PayPal date')
  return date
}
function metadata(value: unknown): CheckoutMetadata | null {
  if (value === undefined) return null
  const result = decodePayPalMetadata(value)
  if (!result) throw new Error('Malformed PayPal checkout metadata')
  return result
}
function cents(value: Money): number {
  if (value?.currency_code !== 'USD' || typeof value.value !== 'string')
    throw new Error('Expected PayPal USD amount')
  return fromPayPalDecimal(value.value, value.currency_code)
}
function customer(value: unknown): string | null {
  return value === undefined ? null : id(value)
}
async function retrieve<T extends { id: string }>(
  transport: PayPalTransport,
  path: string,
  expected: string,
): Promise<T> {
  const result = await transport.request<T>('GET', path)
  payPalRaw(result)
  if (!result || result.id !== expected) throw new Error('PayPal response ID mismatch')
  return result
}
async function subscription(transport: PayPalTransport, subId: string) {
  return retrieve<PayPalSubscriptionPayload>(
    transport,
    `/v1/billing/subscriptions/${id(subId)}`,
    subId,
  )
}
async function frequency(
  transport: PayPalTransport,
  sub: PayPalSubscriptionPayload,
): Promise<{ unit: 'MONTH' | 'YEAR'; amount: number }> {
  if (sub.plan_overridden || (sub.quantity !== undefined && sub.quantity !== '1'))
    throw new PayPalSnapshotCapabilityError(
      'Overridden or quantity subscription is outside template scope',
    )
  const plan = await retrieve<PayPalPlanPayload>(
    transport,
    `/v1/billing/plans/${id(sub.plan_id)}`,
    sub.plan_id,
  )
  const cycle = plan.billing_cycles?.[0]
  if (cycle?.pricing_scheme?.version !== undefined && cycle.pricing_scheme.version !== 1)
    throw new PayPalSnapshotCapabilityError(
      'Revised PayPal pricing scheme cannot prove historical periods',
    )
  if (
    plan.billing_cycles?.length !== 1 ||
    !cycle ||
    cycle.tenure_type !== 'REGULAR' ||
    cycle.total_cycles !== 0 ||
    cycle.frequency?.interval_count !== 1 ||
    !['MONTH', 'YEAR'].includes(cycle.frequency.interval_unit) ||
    !cycle.pricing_scheme?.fixed_price ||
    cents(cycle.pricing_scheme.fixed_price) <= 0 ||
    (plan.payment_preferences?.setup_fee && cents(plan.payment_preferences.setup_fee) !== 0)
  )
    throw new PayPalSnapshotCapabilityError(
      'Expected one fixed USD REGULAR monthly/yearly cycle without trial or setup fee',
    )
  return {
    unit: cycle.frequency.interval_unit as 'MONTH' | 'YEAR',
    amount: cents(cycle.pricing_scheme.fixed_price),
  }
}
function advance(anchor: Date, unit: 'MONTH' | 'YEAR', count = 1): Date {
  const result = new Date(anchor)
  result.setUTCDate(1)
  result.setUTCMonth(anchor.getUTCMonth() + count * (unit === 'YEAR' ? 12 : 1))
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate()
  result.setUTCDate(Math.min(anchor.getUTCDate(), lastDay))
  return result
}
function period(start: Date, end: Date) {
  if (end <= start) throw new Error('Invalid PayPal paid period')
  return { start, end }
}
const statuses: Record<string, SubscriptionStatus> = {
  ACTIVE: 'active',
  SUSPENDED: 'paused',
  CANCELLED: 'canceled',
  EXPIRED: 'expired',
  APPROVAL_PENDING: 'paused',
  APPROVED: 'paused',
}
async function getSubscription(
  transport: PayPalTransport,
  subId: string,
): Promise<SubscriptionSnapshot> {
  const sub = await subscription(transport, subId)
  const status = statuses[sub.status]
  if (!status) throw new Error('Unsupported PayPal subscription status')
  const last = sub.billing_info?.last_payment
  const start = last && cents(last.amount) > 0 ? payPalDate(last.time) : null
  const end = start
    ? sub.billing_info?.next_billing_time === undefined
      ? advance(start, (await frequency(transport, sub)).unit)
      : payPalDate(sub.billing_info.next_billing_time)
    : null
  if (start && end) period(start, end)
  return {
    providerSubscriptionId: sub.id,
    providerPriceId: id(sub.plan_id),
    providerCustomerId: customer(sub.subscriber?.payer_id),
    status,
    remoteStatus: sub.status,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    cancelAtPeriodEnd: false,
    canceledAt: sub.status === 'CANCELLED' ? payPalDate(sub.status_update_time) : null,
    trialEnd: null,
    pastDueSince: null,
    metadata: metadata(sub.custom_id),
    raw: payPalRaw(sub),
  }
}
async function order(transport: PayPalTransport, orderId: string) {
  const result = await retrieve<PayPalOrderPayload>(
    transport,
    `/v2/checkout/orders/${id(orderId)}`,
    orderId,
  )
  if (result.purchase_units?.length !== 1) throw new Error('Expected one PayPal purchase unit')
  return result
}
function orderSnapshot(value: PayPalOrderPayload): OrderSnapshot {
  const unit = value.purchase_units[0]
  if (!unit) throw new Error('Expected one PayPal purchase unit')
  const captures = unit.payments?.captures ?? []
  if (captures.length > 1)
    throw new PayPalSnapshotCapabilityError('Multiple captures are outside template scope')
  const capture = captures[0]
  const amount = cents(unit.amount)
  if (capture && cents(capture.amount) !== amount)
    throw new Error('PayPal order/capture amount mismatch')
  const meta = metadata(unit.custom_id)
  let status: OrderSnapshot['status']
  if (capture?.status === 'REFUNDED') status = 'refunded'
  else if (capture && ['COMPLETED', 'PARTIALLY_REFUNDED'].includes(capture.status)) status = 'paid'
  else if (
    value.status === 'VOIDED' ||
    (capture && ['DECLINED', 'FAILED'].includes(capture.status))
  )
    status = 'failed'
  else if (
    ['CREATED', 'SAVED', 'APPROVED', 'PAYER_ACTION_REQUIRED'].includes(value.status) ||
    capture?.status === 'PENDING'
  )
    status = 'pending'
  else throw new Error('PayPal order lacks supported capture state')
  return {
    providerOrderId: value.id,
    providerCustomerId: customer(value.payer?.payer_id ?? value.payment_source?.paypal?.account_id),
    providerPriceId: meta ? `paypal:credit_pack:${meta.planPriceId}` : null,
    status,
    amount,
    currency: 'USD',
    metadata: meta,
    raw: payPalRaw(value),
  }
}
/** GET Capture/Sale has no documented cumulative partial-refund amount. Never substitute a refund delta. */
export function payPalRefundedAmount(status: string, amount: number): number | null {
  if (status === 'COMPLETED' || status === 'completed') return 0
  if (status === 'REFUNDED' || status === 'refunded') return amount
  if (status === 'PARTIALLY_REFUNDED' || status === 'partially_refunded') return null
  throw new Error('PayPal payment is not successfully paid')
}
function relatedOrder(capture: PayPalCapturePayload): string {
  const direct = capture.supplementary_data?.related_ids?.order_id
  if (direct !== undefined) return id(direct)
  const link = capture.links?.find((item) => item.rel === 'up')
  if (link) {
    const url = new URL(link.href)
    const match = /^\/v2\/checkout\/orders\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
    if (
      [
        'https://api-m.paypal.com',
        'https://api-m.sandbox.paypal.com',
        'https://api.paypal.com',
        'https://api.sandbox.paypal.com',
      ].includes(url.origin) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      match?.[1]
    )
      return id(match[1])
  }
  throw new Error('PayPal Capture lacks order association')
}
async function paidHistory(
  transport: PayPalTransport,
  sale: PayPalSalePayload,
  sub: PayPalSubscriptionPayload,
) {
  const start = payPalDate(sub.start_time)
  const end = payPalDate(sale.create_time)
  if (end < start) throw new Error('Sale precedes subscription start')
  const pathname = `/v1/billing/subscriptions/${id(sub.id)}/transactions`
  let path = `${pathname}?start_time=${encodeURIComponent(start.toISOString())}&end_time=${encodeURIComponent(end.toISOString())}`
  const seen = new Set<string>()
  const unique = new Map<string, Transactions['transactions'][number]>()
  let expectedItems: number | undefined
  let expectedPages: number | undefined
  while (true) {
    if (seen.has(path)) throw new Error('Cyclic PayPal history pagination')
    seen.add(path)
    const page = await transport.request<Transactions>('GET', path)
    payPalRaw(page)
    if (!Array.isArray(page.transactions)) throw new Error('Malformed PayPal history')
    for (const total of [page.total_items, page.total_pages])
      if (total !== undefined && (!Number.isSafeInteger(total) || total < 0))
        throw new Error('Malformed PayPal history totals')
    if (
      (expectedItems !== undefined &&
        page.total_items !== undefined &&
        expectedItems !== page.total_items) ||
      (expectedPages !== undefined &&
        page.total_pages !== undefined &&
        expectedPages !== page.total_pages)
    )
      throw new Error('PayPal history totals changed during pagination')
    expectedItems ??= page.total_items
    expectedPages ??= page.total_pages
    for (const tx of page.transactions) {
      const key = id(tx.id)
      const previous = unique.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(tx))
        throw new Error('Conflicting PayPal history transaction')
      unique.set(key, tx)
    }
    const next = page.links?.find((link) => link.rel === 'next')
    if (!next) break
    const url = new URL(next.href)
    if (
      url.origin !== transport.apiOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== pathname ||
      url.searchParams.get('start_time') !== start.toISOString() ||
      url.searchParams.get('end_time') !== end.toISOString()
    )
      throw new Error('Unsafe PayPal history pagination link')
    path = `${url.pathname}${url.search}`
  }
  if (
    (expectedItems !== undefined && expectedItems !== unique.size) ||
    (expectedPages !== undefined && expectedPages > seen.size)
  )
    throw new PayPalSnapshotCapabilityError(
      'Complete history unavailable: transactions API documents only start_time/end_time; truncated response has no usable next link or documented paging/range limit',
    )
  const history = { transactions: [...unique.values()] }
  if (
    history.transactions.some(
      (tx) =>
        !['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'PENDING', 'DECLINED', 'FAILED'].includes(
          tx.status,
        ),
    )
  )
    throw new Error('Malformed subscription transaction history')
  for (const tx of history.transactions) {
    const time = payPalDate(tx.time)
    cents(tx.amount_with_breakdown.gross_amount)
    if (time < start || time > end) throw new Error('Transaction outside requested history')
  }
  const paid = history.transactions.filter((tx) =>
    ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(tx.status),
  )
  const target = paid.find((tx) => tx.id === sale.id)
  if (
    !target ||
    payPalDate(target.time).getTime() !== end.getTime() ||
    cents(target.amount_with_breakdown.gross_amount) !==
      fromPayPalDecimal(sale.amount.total, sale.amount.currency)
  )
    throw new Error('Sale absent or inconsistent in verified subscription history')
  for (const tx of paid) {
    const time = payPalDate(tx.time)
    if (tx.id !== sale.id && time.getTime() === end.getTime())
      throw new PayPalSnapshotCapabilityError('Ambiguous first payment timestamp')
  }
  return paid.sort((a, b) => payPalDate(a.time).getTime() - payPalDate(b.time).getTime())
}
async function classify(
  transport: PayPalTransport,
  sale: PayPalSalePayload,
  sub: PayPalSubscriptionPayload,
) {
  const paid = await paidHistory(transport, sale, sub)
  return paid[0]?.id === sale.id ? ('initial' as const) : ('renewal' as const)
}
/** Reusable by webhook normalization; uses remote history, never delivery order or local presence. */
export async function classifyPayPalSale(
  transport: PayPalTransport,
  saleId: string,
): Promise<'initial' | 'renewal'> {
  const sale = await retrieve<PayPalSalePayload>(
    transport,
    `/v1/payments/sale/${id(saleId)}`,
    saleId,
  )
  if (!['completed', 'refunded', 'partially_refunded'].includes(sale.state))
    throw new Error('Sale is not paid')
  return classify(transport, sale, await subscription(transport, id(sale.billing_agreement_id)))
}
function verifyRecordedSale(
  recorded: PayPalRecordedSale,
  tx: Transactions['transactions'][number],
  sub: PayPalSubscriptionPayload,
  kind: 'initial' | 'renewal',
) {
  const checkout = metadata(sub.custom_id)
  if (
    recorded.providerPaymentId !== tx.id ||
    recorded.providerSubscriptionId !== sub.id ||
    recorded.providerPriceId !== sub.plan_id ||
    recorded.kind !== kind ||
    recorded.amount !== cents(tx.amount_with_breakdown.gross_amount) ||
    recorded.currency !== tx.amount_with_breakdown.gross_amount.currency_code ||
    recorded.paidAt.getTime() !== payPalDate(tx.time).getTime() ||
    (checkout &&
      (recorded.workspaceId !== checkout.workspaceId ||
        recorded.planPriceId !== checkout.planPriceId))
  )
    throw new PayPalSnapshotCapabilityError('Recorded PayPal Sale identity mismatch')
  return recorded.period
}
async function salePeriod(
  transport: PayPalTransport,
  sale: PayPalSalePayload,
  sub: PayPalSubscriptionPayload,
  history: Transactions['transactions'],
  lookupRecordedSale?: PayPalSaleLookup,
) {
  const { unit, amount } = await frequency(transport, sub)
  if (history.some((tx) => cents(tx.amount_with_breakdown.gross_amount) !== amount))
    throw new PayPalSnapshotCapabilityError('Revised charge in verified paid history')
  const targetIndex = history.findIndex((tx) => tx.id === sale.id)
  const target = history[targetIndex]
  if (!target) throw new Error('Sale absent from verified paid history')
  const recorded = await lookupRecordedSale?.(sale.id)
  if (recorded)
    return verifyRecordedSale(recorded, target, sub, targetIndex === 0 ? 'initial' : 'renewal')
  const paidAt = payPalDate(sale.create_time)
  const last = sub.billing_info?.last_payment
  if (
    !last ||
    payPalDate(last.time).getTime() !== paidAt.getTime() ||
    cents(last.amount) !== amount ||
    !sub.billing_info?.next_billing_time
  )
    throw new PayPalSnapshotCapabilityError(
      'Historical PayPal Sale period unavailable without recorded evidence or current billing dates',
    )
  const end = payPalDate(sub.billing_info.next_billing_time)
  let start: Date
  if (targetIndex === 0) {
    start = payPalDate(sub.start_time)
  } else {
    const previous = history[targetIndex - 1]
    const recordedPrevious = previous && (await lookupRecordedSale?.(previous.id))
    if (!previous || !recordedPrevious)
      throw new PayPalSnapshotCapabilityError('Previous PayPal Sale period evidence unavailable')
    start = verifyRecordedSale(
      recordedPrevious,
      previous,
      sub,
      targetIndex === 1 ? 'initial' : 'renewal',
    ).end
  }
  // 日历运算仅用于拒绝跨过未付周期的扣款；权益边界必须来自真实账期证据。
  if (paidAt < start || paidAt >= end || paidAt >= advance(start, unit))
    throw new PayPalSnapshotCapabilityError('Unprovable billing-cycle gap in verified paid history')
  return period(start, end)
}
async function getPayment(
  transport: PayPalTransport,
  reference: PaymentReference,
  checkKind = true,
  lookupRecordedSale?: PayPalSaleLookup,
): Promise<PaymentSnapshot> {
  const paymentId = id(reference.providerPaymentId)
  if (reference.kind === 'adjustment') throw new Error('PayPal adjustment payments are unsupported')
  if (reference.kind === 'one_time') {
    const capture = await retrieve<PayPalCapturePayload>(
      transport,
      `/v2/payments/captures/${paymentId}`,
      paymentId,
    )
    const amount = cents(capture.amount)
    const refundedAmount = payPalRefundedAmount(capture.status, amount)
    const remoteOrder = await order(transport, relatedOrder(capture))
    const snapshot = orderSnapshot(remoteOrder)
    if (
      !remoteOrder.purchase_units[0]?.payments?.captures?.some((item) => item.id === capture.id) ||
      snapshot.amount !== amount
    )
      throw new Error('Capture not associated with verified order')
    return {
      kind: 'one_time',
      providerPaymentId: capture.id,
      providerOrderId: remoteOrder.id,
      providerPriceId: snapshot.providerPriceId,
      period: null,
      providerCustomerId: snapshot.providerCustomerId,
      amount,
      currency: 'USD',
      paidAt: payPalDate(capture.create_time),
      refundedAmount,
      status:
        refundedAmount === null
          ? 'partially_refunded'
          : refundedAmount === 0
            ? 'succeeded'
            : 'refunded',
      metadata: snapshot.metadata,
      raw: payPalRaw(capture),
    }
  }
  if (reference.kind !== 'initial' && reference.kind !== 'renewal')
    throw new Error('Invalid PayPal payment kind')
  const sale = await retrieve<PayPalSalePayload>(
    transport,
    `/v1/payments/sale/${paymentId}`,
    paymentId,
  )
  const amount = fromPayPalDecimal(sale.amount.total, sale.amount.currency)
  const refundedAmount = payPalRefundedAmount(sale.state, amount)
  const sub = await subscription(transport, id(sale.billing_agreement_id))
  const history = await paidHistory(transport, sale, sub)
  const kind = history[0]?.id === sale.id ? 'initial' : 'renewal'
  if (checkKind && kind !== reference.kind) throw new Error('PayPal Sale kind mismatch')
  return {
    kind,
    providerPaymentId: sale.id,
    providerSubscriptionId: sub.id,
    providerPriceId: sub.plan_id,
    period: await salePeriod(transport, sale, sub, history, lookupRecordedSale),
    providerCustomerId: customer(sub.subscriber?.payer_id),
    amount,
    currency: 'USD',
    paidAt: payPalDate(sale.create_time),
    refundedAmount,
    status:
      refundedAmount === null
        ? 'partially_refunded'
        : refundedAmount === 0
          ? 'succeeded'
          : 'refunded',
    metadata: kind === 'initial' ? metadata(sub.custom_id) : null,
    raw: payPalRaw(sale),
  }
}
export function createPayPalSnapshots(
  transport: PayPalTransport,
  lookupRecordedSale?: PayPalSaleLookup,
): PayPalSnapshots {
  return {
    getSubscription: (subId) => getSubscription(transport, subId),
    getOrder: async (orderId) => orderSnapshot(await order(transport, orderId)),
    getPayment: (reference) => getPayment(transport, reference, true, lookupRecordedSale),
  }
}

/** For verified Sale events; classification always comes from complete remote history. */
export async function getPayPalSalePayment(
  transport: PayPalTransport,
  saleId: string,
  lookupRecordedSale?: PayPalSaleLookup,
): Promise<PaymentSnapshot> {
  return getPayment(
    transport,
    { providerPaymentId: saleId, kind: 'initial' },
    false,
    lookupRecordedSale,
  )
}

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  type BadgeColor,
  Button,
  cn,
  DailyClaimNotice,
  type DailyClaimNoticeProps,
} from '@product-res/ui'
import { CircleAlert } from '@product-res/ui/icons'
import type { ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { useAppShellBarAvailable } from '../app-shell/bar.tsx'
import type { DailyCreditsCheck } from '../credits/daily.server.ts'
import { Bone } from '../shared/bone.tsx'

/** 账单页积分摘要，字段与 `getCreditSummary` 一致 */
export interface BillingCreditSummary {
  readonly subscription: { readonly total: number; readonly currentPeriod: number }
  readonly purchase: number
  readonly free: { readonly signup: number; readonly daily: number; readonly total: number }
  readonly other: number
  readonly available: number
}

export interface BillingSections {
  readonly subscription: boolean
  readonly packs: boolean
  readonly free: boolean
}

type PlanType = 'subscription' | 'credit_pack'
interface CatalogPlan {
  readonly id: string
  readonly type: PlanType
}
interface CatalogPrice {
  readonly planId: string
  readonly provider: string
  readonly active: boolean
}

/**
 * 「订阅 / 积分包 / 免费积分」三个分区各自有数据来源时才渲染：
 * 订阅来自有生效价格的订阅套餐或已有订阅，积分包来自有生效价格的积分包或已持有的积分包积分，
 * 免费积分来自注册赠送 / 每日领取配置或已持有的免费积分。
 */
export function billingSections({
  plans,
  prices,
  subscriptionCount,
  summary,
  freeConfigured,
}: {
  plans: readonly CatalogPlan[]
  prices: readonly CatalogPrice[]
  subscriptionCount: number
  summary: BillingCreditSummary | null
  freeConfigured: boolean
}): BillingSections {
  const priced = (type: PlanType) =>
    plans.some(
      (plan) =>
        plan.type === type && prices.some((price) => price.active && price.planId === plan.id),
    )
  return {
    subscription: priced('subscription') || subscriptionCount > 0,
    packs: priced('credit_pack') || (summary?.purchase ?? 0) > 0,
    free: freeConfigured || (summary?.free.total ?? 0) > 0,
  }
}

/**
 * 默认支付方式：优先「可用且有生效价格」的渠道，其次有价格的渠道，最后按配置顺序。
 * 默认渠道没有价格时购买区不能整体消失，所以不按所选渠道判断是否显示购买入口。
 */
export function defaultProvider(
  providers: readonly { readonly id: string; readonly available: boolean }[],
  prices: readonly CatalogPrice[],
): string {
  const priced = (id: string) => prices.some((price) => price.active && price.provider === id)
  return (
    providers.find((p) => p.available && priced(p.id))?.id ??
    providers.find((p) => priced(p.id))?.id ??
    providers.find((p) => p.available)?.id ??
    providers[0]?.id ??
    ''
  )
}

export const formatCredits = (count: number) => new Intl.NumberFormat(getLocale()).format(count)

export const formatBillingDate = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleDateString(getLocale(), { timeZone: 'UTC', dateStyle: 'medium' })
    : m.billing_page_pending()

const providerNames: Record<string, () => string> = {
  stripe: m.billing_page_provider_stripe,
  paypal: m.billing_page_provider_paypal,
  creem: m.billing_page_provider_creem,
  paddle: m.billing_page_provider_paddle,
  polar: m.billing_page_provider_polar,
}
export const providerName = (id: string) => providerNames[id]?.() ?? id

const paymentStatuses: Record<string, () => string> = {
  succeeded: m.billing_page_payment_succeeded,
  refunded: m.billing_page_payment_refunded,
  partially_refunded: m.billing_page_payment_partially_refunded,
  disputed: m.billing_page_payment_disputed,
}
export const paymentStatusLabel = (status: string) => paymentStatuses[status]?.() ?? status

const refundStatuses: Record<string, () => string> = {
  pending: m.billing_page_refund_pending,
  approved: m.billing_page_refund_approved,
  rejected: m.billing_page_refund_rejected,
  refunded: m.billing_page_refund_refunded,
}
export const refundStatusLabel = (status: string) => refundStatuses[status]?.() ?? status

/** 分区外框：标题在左，补充信息在右 */
export function BillingSection({
  id,
  title,
  aside,
  children,
}: {
  id: string
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid scroll-mt-6 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${id}-title`} className="font-semibold text-title">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function BillingCard({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid content-start gap-2.5 rounded-xl border bg-card px-5 py-4', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'ending' | 'ended'

export function subscriptionStatus(sub: {
  status: string
  cancelAtPeriodEnd: boolean
}): SubscriptionStatus {
  if (['canceled', 'expired'].includes(sub.status)) return 'ended'
  if (sub.cancelAtPeriodEnd) return 'ending'
  if (sub.status === 'trialing' || sub.status === 'past_due' || sub.status === 'paused')
    return sub.status
  return 'active'
}

const statusBadge: Record<SubscriptionStatus, { color: BadgeColor; label: () => string }> = {
  active: { color: 'green', label: m.billing_page_status_active },
  trialing: { color: 'blue', label: m.billing_page_status_trialing },
  past_due: { color: 'amber', label: m.billing_page_status_past_due },
  paused: { color: 'gray', label: m.billing_page_status_paused },
  ending: { color: 'amber', label: m.billing_page_status_ending },
  ended: { color: 'gray', label: m.billing_page_status_ended },
}

export function SubscriptionStatusBadge({ status }: { status: SubscriptionStatus }) {
  const badge = statusBadge[status]
  return <Badge color={badge.color}>{badge.label()}</Badge>
}

/** 未订阅时的订阅分区卡片 */
/**
 * 当前权益套餐的显示名：优先权益自带的套餐名（已下架套餐不在目录中也能显示），
 * 再按目录 key 匹配；未落库的免费兜底显示本地化文案，不把权益 key 直接展示给用户。
 */
export function entitlementPlanName(
  entitlements: { key: string; name?: string | null },
  plans: readonly { key: string; name: string }[],
): string {
  return (
    entitlements.name ||
    plans.find((plan) => plan.key === entitlements.key)?.name ||
    (entitlements.key === 'free' ? m.billing_page_free_plan() : entitlements.key)
  )
}

export function FreePlanCard({ action }: { action?: ReactNode }) {
  return (
    <BillingCard className="px-6 py-5 shadow-surface-2 sm:flex sm:items-center sm:justify-between sm:gap-6">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold text-title">{m.billing_page_free_plan()}</h3>
          <Badge variant="dot">{m.billing_page_not_subscribed()}</Badge>
        </div>
        <p className="text-muted-foreground">{m.billing_page_free_desc()}</p>
      </div>
      {action}
    </BillingCard>
  )
}

/**
 * 每日领取提示的状态。每日积分在进入工作台时自动发放，没有手动领取的 server function，
 * 所以只展示状态、不显示领取按钮。布局 loader 只在当天首次检查时返回 granted / already_claimed，
 * 之后是 cached，因此「今日已领」也从仍有剩余的 daily 积分推导（daily 积分当天到期）。
 */
export function dailyNoticeState(
  result: DailyCreditsCheck | null | undefined,
  dailyRemaining: number,
): Pick<DailyClaimNoticeProps, 'status' | 'title' | 'description'> | null {
  if (result?.status === 'granted' || result?.status === 'already_claimed' || dailyRemaining > 0)
    return {
      status: 'claimed',
      title: m.billing_page_daily_claimed_title(),
      description: m.billing_page_daily_claimed_desc({
        count: formatCredits(result?.status === 'granted' ? result.credits : dailyRemaining),
      }),
    }
  if (result?.status === 'monthly_limit')
    return {
      status: 'available',
      title: m.billing_page_daily_limit(),
      description: m.billing_page_daily_limit_desc(),
    }
  if (result?.status === 'unverified')
    return {
      status: 'available',
      title: m.billing_page_daily_verify(),
      description: m.billing_page_daily_verify_desc(),
    }
  return null
}

/** 订阅积分卡需要的当前订阅信息；未订阅时为 null */
export interface BalanceSubscription {
  /** 当前套餐每月发放的积分 */
  readonly planCredits: number | null
  readonly interval: 'month' | 'year' | null
  /** 已取消续费或已结束：显示结束日期而非重置日期 */
  readonly ending: boolean
  readonly periodEnd: Date | string | null
}

/** 订阅积分卡右上角：取消中显示结束日，月付显示下次重置日，年付按月发放不显示续费日 */
export function subscriptionCreditsNote(sub: BalanceSubscription | null): string | null {
  if (!sub) return null
  if (sub.ending) return m.billing_page_sub_ends({ date: formatBillingDate(sub.periodEnd) })
  if (sub.interval === 'year') return m.billing_page_sub_monthly_grant()
  return sub.periodEnd
    ? m.billing_page_sub_resets({ date: formatBillingDate(sub.periodEnd) })
    : null
}

/** 余额：订阅、积分包、免费积分三张卡片只渲染有数据来源的分区 */
export function CreditBalance({
  summary,
  sections,
  subscription,
  packExpiry,
  daily,
  freeRows,
  packAction,
  footer,
}: {
  summary: BillingCreditSummary
  sections: BillingSections
  subscription: BalanceSubscription | null
  /** 积分包有效天数；全部长期有效时为 null */
  packExpiry: number | null
  daily: DailyCreditsCheck | null | undefined
  /** 免费积分明细行：对应来源已配置或已有余额时才显示 */
  freeRows: { readonly signup: boolean; readonly daily: boolean }
  packAction?: ReactNode
  footer?: ReactNode
}) {
  const current = summary.subscription.currentPeriod
  const planCredits = subscription?.planCredits ?? null
  // 多个付费周期重叠时本期剩余可能超过单个套餐额度，此时不显示分母与进度
  const ratio = planCredits && planCredits > 0 && current <= planCredits ? planCredits : null
  const percent = ratio ? Math.round((current / ratio) * 100) : 0
  const note = subscriptionCreditsNote(subscription)
  const showSignup = freeRows.signup || summary.free.signup > 0
  const showDaily = freeRows.daily || summary.free.daily > 0
  const dailyNotice = dailyNoticeState(daily, summary.free.daily)
  return (
    <BillingSection
      id="balance"
      title={m.billing_page_balance()}
      aside={
        <p className="text-muted-foreground">
          {m.billing_page_available()}{' '}
          <strong className="font-semibold text-foreground tabular-nums">
            {formatCredits(summary.available)}
          </strong>
        </p>
      }
    >
      <div className="grid items-start gap-3 md:grid-cols-3">
        {sections.subscription && (
          <BillingCard>
            <CardHead
              title={m.billing_page_sub_credits()}
              aside={note && <span className="text-caption text-muted-foreground">{note}</span>}
            />
            <p className="font-semibold text-display tabular-nums">
              {formatCredits(current)}
              {ratio ? (
                <span className="font-medium text-muted-foreground text-subtitle">
                  {' '}
                  / {formatCredits(ratio)}
                </span>
              ) : null}
            </p>
            {subscription ? (
              <>
                {ratio !== null && (
                  <div
                    role="progressbar"
                    aria-label={m.billing_page_sub_progress()}
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 overflow-hidden rounded-full bg-active"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
                <p className="text-caption text-muted-foreground">
                  {summary.subscription.total > current
                    ? m.billing_page_sub_total({
                        count: formatCredits(summary.subscription.total),
                      })
                    : m.billing_page_sub_no_rollover()}
                </p>
              </>
            ) : (
              <p className="text-caption text-muted-foreground">{m.billing_page_sub_hint()}</p>
            )}
          </BillingCard>
        )}
        {sections.packs && (
          <BillingCard>
            <CardHead
              title={m.billing_page_pack_credits()}
              aside={
                <span className="text-caption text-muted-foreground">
                  {packExpiry === null
                    ? m.billing_page_pack_permanent()
                    : m.billing_page_pack_expiry({ count: packExpiry })}
                </span>
              }
            />
            <p className="font-semibold text-display tabular-nums">
              {formatCredits(summary.purchase)}
            </p>
            {summary.purchase === 0 && (
              <p className="text-caption text-muted-foreground">{m.billing_page_pack_empty()}</p>
            )}
            {packAction}
          </BillingCard>
        )}
        {sections.free && (
          <BillingCard>
            <CardHead title={m.billing_page_free_credits()} />
            <p className="font-semibold text-display tabular-nums">
              {formatCredits(summary.free.total)}
            </p>
            {(showSignup || showDaily) && (
              <dl className="grid gap-1 text-caption">
                {showSignup && (
                  <Row label={m.billing_page_signup()} value={formatCredits(summary.free.signup)} />
                )}
                {showDaily && (
                  <Row label={m.billing_page_daily()} value={formatCredits(summary.free.daily)} />
                )}
              </dl>
            )}
            {showDaily && dailyNotice && (
              <DailyClaimNotice
                compact
                {...dailyNotice}
                labels={{
                  claim: m.billing_page_daily_claim(),
                  claimed: m.billing_page_daily_claimed(),
                }}
              />
            )}
          </BillingCard>
        )}
      </div>
      {summary.other > 0 && (
        <p className="text-caption text-muted-foreground">
          {m.billing_page_other_credits({ count: formatCredits(summary.other) })}
        </p>
      )}
      {footer}
    </BillingSection>
  )
}

function CardHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-medium">{title}</h3>
      {aside}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

/** 积分包购买卡片：价格随所选支付方式变化，不受订阅周期影响 */
export function PackOption({
  name,
  credits,
  price,
  expiry,
  disabled,
  onBuy,
}: {
  name: string
  credits: number
  price: string
  expiry: string
  disabled: boolean
  onBuy(): void
}) {
  return (
    <li className="grid gap-2 rounded-lg px-3.5 py-3 ring-1 ring-border">
      <span className="flex items-center justify-between gap-2">
        <span className="font-semibold text-subtitle">{name}</span>
        <span className="text-caption text-muted-foreground tabular-nums">
          {m.billing_page_pack_amount({ count: formatCredits(credits) })}
        </span>
      </span>
      <span className="text-caption text-muted-foreground">
        {price} · {expiry}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        aria-label={m.billing_page_buy_label({ name })}
        onClick={onBuy}
      >
        {m.billing_page_buy()}
      </Button>
    </li>
  )
}

export function BillingSkeleton() {
  return (
    <div role="status" aria-label={m.billing_page_loading()} className="grid gap-8">
      <div className="grid gap-2">
        <Bone className="h-7 w-48" />
        <Bone className="h-4 w-full max-w-lg" />
      </div>
      <BillingCard className="px-6 py-5">
        <Bone className="h-5 w-40" />
        <Bone className="h-3 w-full max-w-sm" />
      </BillingCard>
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <BillingCard key={key}>
            <Bone className="h-4 w-28" />
            <Bone className="h-7 w-24" />
            <Bone className="h-3 w-3/4" />
          </BillingCard>
        ))}
      </div>
    </div>
  )
}

/**
 * 页面主标题：侧边栏布局下工作台顶部条的默认标题已是页名 h1，此时不重复；
 * 顶部布局没有该插槽，由页面自己渲染 h1。
 */
export function BillingPageTitle({ children }: { children?: ReactNode }) {
  if (useAppShellBarAvailable()) return children ? <div>{children}</div> : null
  return (
    <header className="grid gap-1">
      <h1 className="font-semibold text-display">{m.billing_page_title()}</h1>
      {children}
    </header>
  )
}

export function BillingError({ onRetry }: { onRetry(): void }) {
  return (
    <div className="grid gap-6">
      <BillingPageTitle />
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>{m.billing_page_error_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.billing_page_error_desc()}</p>
          <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onRetry}>
            {m.billing_page_retry()}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}

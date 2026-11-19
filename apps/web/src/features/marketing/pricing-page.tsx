import { Alert, AlertDescription, AlertTitle, Badge, Button, cn } from '@product-res/ui'
import {
  Calendar,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  CreditCard,
  Package,
  Plus,
} from '@product-res/ui/icons'
import { Link } from '@tanstack/react-router'
import { type ReactNode, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { Bone } from '../shared/bone.tsx'
import {
  type BillingInterval,
  type groupPricingPlans,
  type PricingFeature,
  type PricingPlan,
  packExpiryDays,
  planPrice,
  pricingFeatures,
  subscriptionDisplayPrice,
  yearlySavings,
} from './pricing-data.ts'
import { formatPrice } from './sections/pricing.tsx'

export type PricingGroupsData = ReturnType<typeof groupPricingPlans<PricingPlan>>

const credits = (count: number) => new Intl.NumberFormat(getLocale()).format(count)

/** 套餐分组决定首屏文案：只有一种类型时不提叠加使用 */
export type PricingKind = 'both' | 'subscriptions' | 'packs'

export function pricingKind(groups: PricingGroupsData): PricingKind {
  if (groups.subscriptions.length > 0 && groups.creditPacks.length === 0) return 'subscriptions'
  if (groups.subscriptions.length === 0 && groups.creditPacks.length > 0) return 'packs'
  return 'both'
}

const heroCopy = {
  both: [m.pricing_page_title, m.pricing_page_subtitle],
  subscriptions: [m.pricing_page_title_subscriptions, m.pricing_page_subtitle_subscriptions],
  packs: [m.pricing_page_title_packs, m.pricing_page_subtitle_packs],
} as const

/** 定价页首屏：标题与说明，加载、错误与空状态用默认文案 */
export function PricingHero({ kind = 'both' }: { kind?: PricingKind | undefined }) {
  const [title, subtitle] = heroCopy[kind]
  return (
    <section className="px-4 pt-16 pb-10">
      <div className="mx-auto grid max-w-3xl justify-items-center gap-4 text-center">
        <span className="rounded-full border px-3 py-1 text-caption text-muted-foreground">
          {m.pricing_page_eyebrow()}
        </span>
        <h1 className="font-bold text-4xl tracking-tight">{title()}</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">{subtitle()}</p>
      </div>
    </section>
  )
}

/** 积分规则条：只在订阅与积分包并存时说明叠加和扣费顺序 */
export function PricingFacts({ packExpiry }: { packExpiry: number | null }) {
  const facts = [
    {
      icon: Calendar,
      title: m.pricing_page_fact_monthly_title(),
      desc: m.pricing_page_fact_monthly_desc(),
    },
    packExpiry === null
      ? {
          icon: Package,
          title: m.pricing_page_fact_pack_title(),
          desc: m.pricing_page_fact_pack_desc(),
        }
      : {
          icon: Package,
          title: m.pricing_page_fact_pack_title_expiry(),
          desc: m.pricing_page_fact_pack_desc_expiry({ count: packExpiry }),
        },
    {
      icon: Plus,
      title: m.pricing_page_fact_stack_title(),
      desc: m.pricing_page_fact_stack_desc(),
    },
    {
      icon: Clock,
      title: m.pricing_page_fact_order_title(),
      desc: m.pricing_page_fact_order_desc(),
    },
  ]
  return (
    <section aria-label={m.pricing_page_facts_label()} className="px-4 pb-10">
      {/* 间隙露出边框色作分隔线，任意列数下都不需要按位置判断边框 */}
      <ul className="mx-auto grid max-w-6xl gap-px overflow-hidden rounded-xl bg-border shadow-surface-2 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map(({ icon: Icon, title, desc }) => (
          <li key={title} className="flex gap-3 bg-card px-5 py-4">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-active"
            >
              <Icon className="size-4" />
            </span>
            <span className="grid gap-0.5">
              <span className="font-semibold text-subtitle">{title}</span>
              <span className="text-caption text-muted-foreground">{desc}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * 订阅与积分包并列：月付/年付切换只作用于订阅组；只有积分包时不显示切换与订阅组，
 * 只有订阅时订阅组占满宽度。两组都没有时显示空状态。
 */
export function PricingGroups({
  groups,
  paymentsAvailable,
  initialInterval = 'month',
}: {
  groups: PricingGroupsData
  paymentsAvailable: boolean
  initialInterval?: BillingInterval
}) {
  const [interval, setInterval] = useState<BillingInterval>(initialInterval)
  if (groups.subscriptions.length === 0 && groups.creditPacks.length === 0) return <PricingEmpty />
  const both = groups.subscriptions.length > 0 && groups.creditPacks.length > 0
  const hasYearly = groups.subscriptions.some((plan) =>
    plan.prices.some((price) => price.interval === 'year'),
  )
  const saving = yearlySavings(groups.subscriptions)
  const packExpiry = packExpiryDays(groups.creditPacks)
  // 免费套餐的 0 元按首个付费订阅的币种显示
  const currency =
    groups.subscriptions.flatMap((plan) => plan.prices)[0]?.currency ??
    groups.creditPacks.flatMap((plan) => plan.prices)[0]?.currency ??
    'usd'
  return (
    <div className="grid gap-4">
      <div className={cn('grid items-start gap-8', both && 'lg:grid-cols-10')}>
        {groups.subscriptions.length > 0 && (
          <section aria-labelledby="pricing-subscriptions" className="grid gap-4 lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <GroupHeading
                id="pricing-subscriptions"
                title={m.pricing_page_subscriptions()}
                desc={m.pricing_page_subscriptions_desc()}
              />
              {hasYearly && (
                <fieldset className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5">
                  <legend className="sr-only">{m.pricing_page_cycle()}</legend>
                  {(['month', 'year'] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="compact"
                      variant={interval === value ? 'outline' : 'ghost'}
                      aria-pressed={interval === value}
                      className={cn(interval === value && 'bg-surface-3 shadow-surface-2')}
                      onClick={() => setInterval(value)}
                    >
                      {value === 'month' ? m.pricing_page_monthly() : m.pricing_page_yearly()}
                      {value === 'year' && saving.max > 0 && (
                        <Badge color="green" size="compact">
                          {saving.uniform
                            ? m.pricing_page_save({ percent: saving.max })
                            : m.pricing_page_save_up_to({ percent: saving.max })}
                        </Badge>
                      )}
                    </Button>
                  ))}
                </fieldset>
              )}
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {groups.subscriptions.map((plan) => (
                <SubscriptionCard
                  key={plan.key}
                  plan={plan}
                  interval={interval}
                  currency={currency}
                />
              ))}
            </ul>
          </section>
        )}
        {groups.creditPacks.length > 0 && (
          <section aria-labelledby="pricing-packs" className="grid gap-4 lg:col-span-3">
            <div className="flex min-h-8 items-center">
              <GroupHeading
                id="pricing-packs"
                title={m.pricing_page_packs()}
                desc={
                  packExpiry === null
                    ? m.pricing_page_packs_desc()
                    : m.pricing_page_packs_desc_expiry()
                }
              />
            </div>
            <ul className={cn('grid gap-3', !both && 'sm:grid-cols-2 lg:grid-cols-3')}>
              {groups.creditPacks.map((plan) => (
                <PackRow key={plan.key} plan={plan} />
              ))}
            </ul>
            {both && (
              <p className="text-caption text-muted-foreground">{m.pricing_page_pack_order()}</p>
            )}
          </section>
        )}
      </div>
      {!paymentsAvailable && (
        <p role="status" className="text-caption text-muted-foreground">
          {m.pricing_page_payments_unavailable()}
        </p>
      )}
    </div>
  )
}

function GroupHeading({ id, title, desc }: { id: string; title: string; desc: string }) {
  return (
    <div className="grid gap-0.5">
      <h2 id={id} className="font-semibold text-title">
        {title}
      </h2>
      <p className="text-caption text-muted-foreground">{desc}</p>
    </div>
  )
}

/** 权益文案：布尔权益只列出「有」的项，水印为负向权益不作卖点 */
function featureLabel(item: PricingFeature): string | null {
  switch (item.key) {
    case 'maxSeats':
      return m.pricing_page_feature_seats({ count: item.value })
    case 'storageGb':
      return m.pricing_page_feature_storage({ count: item.value })
    case 'maxConcurrentTasks':
      return m.pricing_page_feature_tasks({ count: item.value })
    case 'models':
      return item.value.length
        ? m.pricing_page_feature_models({ value: item.value.join(', ') })
        : null
    case 'publicApi':
      return item.value ? m.pricing_page_feature_api() : null
    case 'priorityQueue':
      return item.value ? m.pricing_page_feature_priority() : null
    default:
      return null
  }
}

function SubscriptionCard({
  plan,
  interval,
  currency,
}: {
  plan: PricingPlan
  interval: BillingInterval
  currency: string
}) {
  const locale = getLocale()
  const display = subscriptionDisplayPrice(plan, interval)
  const free = !display && plan.key === 'free'
  const note = free
    ? m.pricing_page_note_free()
    : !display
      ? '\u00a0'
      : display.monthlyOnly
        ? m.pricing_page_note_monthly_only()
        : display.interval === 'year'
          ? m.pricing_page_note_yearly({
              price: formatPrice(
                Math.round(display.price.amount / 12),
                display.price.currency,
                locale,
              ),
            })
          : m.pricing_page_note_monthly()
  const entitlements = [
    plan.credits > 0 ? m.pricing_page_credits_monthly({ count: credits(plan.credits) }) : null,
    ...pricingFeatures(plan.features).map(featureLabel),
  ].filter((item): item is string => Boolean(item))
  return (
    <li
      className={cn(
        'relative flex flex-col gap-4 rounded-xl bg-card p-6',
        plan.highlighted ? 'shadow-surface-4 ring-2 ring-primary' : 'shadow-surface-2',
      )}
    >
      {plan.highlighted && (
        <Badge color="accent" size="compact" className="-top-2.5 absolute left-6">
          {m.pricing_page_recommended()}
        </Badge>
      )}
      <h3 className="font-semibold text-title">{plan.name}</h3>
      <div className="grid gap-0.5">
        <p className="flex items-baseline gap-1">
          <span className="font-semibold text-display">
            {display
              ? formatPrice(display.price.amount, display.price.currency, locale)
              : free
                ? formatPrice(0, currency, locale)
                : m.pricing_page_price_unavailable()}
          </span>
          {display && (
            <span className="text-muted-foreground">
              {display.interval === 'month'
                ? m.pricing_page_per_month()
                : m.pricing_page_per_year()}
            </span>
          )}
        </p>
        <p className="text-caption text-muted-foreground">{note}</p>
      </div>
      <Button asChild variant={plan.highlighted ? 'default' : 'outline'}>
        {free ? (
          <Link to="/register">{m.pricing_page_start_free()}</Link>
        ) : (
          <Link to="/app" aria-label={m.pricing_page_subscribe_label({ name: plan.name })}>
            {m.pricing_page_subscribe()}
          </Link>
        )}
      </Button>
      <ul className="grid gap-2.5 border-t pt-4">
        {entitlements.map((item) => (
          <li key={item} className="flex items-start gap-2">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </li>
  )
}

function PackRow({ plan }: { plan: PricingPlan }) {
  const locale = getLocale()
  const price = planPrice(plan, 'month')
  return (
    <li className="flex items-center gap-3 rounded-xl bg-card px-5 py-4 shadow-surface-2">
      <div className="grid min-w-0 flex-1 gap-0.5">
        <h3 className="font-semibold text-subtitle">{plan.name}</h3>
        <p className="text-caption text-muted-foreground">
          {m.pricing_page_pack_credits({ count: credits(plan.credits) })} ·{' '}
          {plan.creditExpiryDays === null
            ? m.pricing_page_pack_permanent()
            : m.pricing_page_pack_expiry({ count: plan.creditExpiryDays })}
        </p>
      </div>
      <span className="font-semibold text-title">
        {price
          ? formatPrice(price.amount, price.currency, locale)
          : m.pricing_page_price_unavailable()}
      </span>
      <Button asChild size="sm" variant="outline">
        <Link to="/app" aria-label={m.pricing_page_buy_label({ name: plan.name })}>
          {m.pricing_page_buy()}
        </Link>
      </Button>
    </li>
  )
}

function PricingEmpty() {
  return (
    <div className="grid justify-items-center gap-2.5 rounded-xl border border-dashed px-4 py-12 text-center">
      <span
        aria-hidden="true"
        className="flex h-20 w-30 items-center justify-center rounded-xl bg-active text-muted-foreground"
      >
        <CreditCard className="size-6" />
      </span>
      <h2 className="mt-1 font-semibold text-title">{m.pricing_page_empty_title()}</h2>
      <p className="max-w-md text-muted-foreground">{m.pricing_page_empty_desc()}</p>
      <Button asChild className="mt-1">
        <Link to="/register">{m.pricing_page_start_free()}</Link>
      </Button>
    </div>
  )
}

/** 加载态：保留分组骨架，避免数据到达后布局跳动 */
export function PricingSkeleton() {
  return (
    <div role="status" aria-label={m.pricing_page_loading()} className="grid gap-8 lg:grid-cols-10">
      <div className="grid gap-4 lg:col-span-7">
        <Bone className="h-8 w-40" />
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {[0, 1, 2].map((key) => (
            <div key={key} className="grid gap-4 rounded-xl bg-card p-6 shadow-surface-2">
              <Bone className="h-5 w-24" />
              <Bone className="h-8 w-30" />
              <Bone className="h-9 w-full" />
              <div className="grid gap-2.5 border-t pt-4">
                <Bone className="h-3 w-4/5" />
                <Bone className="h-3 w-2/3" />
                <Bone className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid content-start gap-3 lg:col-span-3">
        <Bone className="h-8 w-32" />
        {[0, 1, 2].map((key) => (
          <div
            key={key}
            className="flex items-center gap-3 rounded-xl bg-card px-5 py-4 shadow-surface-2"
          >
            <Bone className="h-4 flex-1" />
            <Bone className="h-5 w-14" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function PricingError({ onRetry }: { onRetry(): void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>{m.pricing_page_error_title()}</AlertTitle>
      <AlertDescription>
        <p>{m.pricing_page_error_desc()}</p>
        <Button type="button" size="sm" variant="outline" className="mt-1" onClick={onRetry}>
          {m.pricing_page_retry()}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

export function PricingFaq() {
  const questions = [
    { q: m.pricing_page_faq_1_q(), a: m.pricing_page_faq_1_a(), open: true },
    { q: m.pricing_page_faq_2_q(), a: m.pricing_page_faq_2_a(), open: true },
    { q: m.pricing_page_faq_3_q(), a: m.pricing_page_faq_3_a(), open: false },
    { q: m.pricing_page_faq_4_q(), a: m.pricing_page_faq_4_a(), open: false },
  ]
  return (
    <section aria-labelledby="pricing-faq" className="px-4 pb-20">
      <div className="mx-auto max-w-3xl">
        <h2 id="pricing-faq" className="text-center font-semibold text-display">
          {m.pricing_page_faq_title()}
        </h2>
        <div className="mt-6 divide-y border-y">
          {questions.map((item) => (
            <details key={item.q} open={item.open} className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium marker:hidden">
                {item.q}
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                />
              </summary>
              <p className="pb-4 text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

export function PricingBody({ children }: { children: ReactNode }) {
  return (
    <section aria-label={m.pricing_page_plans_label()} className="px-4 pb-18">
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  )
}

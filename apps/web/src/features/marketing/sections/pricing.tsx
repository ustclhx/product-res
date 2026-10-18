import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
} from '@product-res/ui'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'
import { getMarketingPricing } from '../pricing.functions.ts'
import {
  type BillingInterval,
  marketingPlans,
  PRICING_TTL_MS,
  type PricingPlan,
} from '../pricing-data.ts'
import { Section } from './section.tsx'

export type { BillingInterval, PricingPlan } from '../pricing-data.ts'

export function formatPrice(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    maximumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100)
}

export function Pricing({ plans: initialPlans }: { plans: readonly PricingPlan[] }) {
  const [plans, setPlans] = useState(initialPlans)
  const [interval, setInterval] = useState<BillingInterval>('month')
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const catalog = await getMarketingPricing()
        if (active) setPlans(marketingPlans(catalog))
      } catch {
        // 网络不可达时保留首屏快照。
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, PRICING_TTL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])
  const hasYearly = plans.some((plan) => plan.prices.some((price) => price.interval === 'year'))
  return (
    <Section
      id="pricing"
      title={m.marketing_pricing_title()}
      subtitle={m.marketing_pricing_subtitle()}
    >
      {hasYearly && (
        <fieldset className="mx-auto flex rounded-lg border p-1">
          <legend className="sr-only">{m.marketing_pricing_title()}</legend>
          {(['month', 'year'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={interval === value ? 'secondary' : 'ghost'}
              aria-pressed={interval === value}
              onClick={() => setInterval(value)}
            >
              {value === 'month' ? m.marketing_pricing_per_month() : m.marketing_pricing_per_year()}
            </Button>
          ))}
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <PlanCard key={plan.key} plan={plan} interval={interval} />
        ))}
      </div>
      <p className="text-center">
        <Link to="/pricing" className="text-sm underline underline-offset-4">
          {m.marketing_pricing_details()}
        </Link>
      </p>
    </Section>
  )
}

function PlanCard({ plan, interval }: { plan: PricingPlan; interval: BillingInterval }) {
  const locale = getLocale()
  const price =
    plan.type === 'credit_pack'
      ? plan.prices.find((p) => p.interval === null)
      : plan.prices.find((p) => p.interval === interval)
  const suffix =
    plan.type === 'credit_pack'
      ? m.marketing_pricing_one_time()
      : interval === 'month'
        ? m.marketing_pricing_per_month()
        : m.marketing_pricing_per_year()
  const details = [
    plan.type === 'subscription'
      ? m.marketing_pricing_credits_monthly({ count: plan.credits })
      : m.marketing_pricing_credits_pack({ count: plan.credits }),
    plan.maxSeats !== null && m.marketing_pricing_seats({ count: plan.maxSeats }),
    plan.storageGb !== null && m.marketing_pricing_storage({ count: plan.storageGb }),
    plan.creditExpiryDays !== null && m.marketing_pricing_expiry({ count: plan.creditExpiryDays }),
  ].filter((item) => item !== false)
  return (
    <Card className={cn(plan.highlighted && 'border-primary ring-1 ring-primary')}>
      <CardHeader>
        <CardTitle>
          <h3>{plan.name}</h3>
        </CardTitle>
        {plan.highlighted && <CardDescription>{m.marketing_pricing_popular()}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>
          <span className="font-semibold text-3xl">
            {price
              ? formatPrice(price.amount, price.currency, locale)
              : plan.key === 'free'
                ? formatPrice(0, 'usd', locale)
                : '—'}
          </span>{' '}
          {price && <span className="text-muted-foreground text-sm">{suffix}</span>}
        </p>
        <ul className="grid gap-1.5 text-muted-foreground text-sm">
          {details.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </CardContent>
      <CardFooter className="mt-auto">
        <Button asChild className="w-full" variant={plan.highlighted ? 'default' : 'outline'}>
          <Link to="/register">{m.marketing_pricing_cta()}</Link>
        </Button>
      </CardFooter>
    </Card>
  )
}

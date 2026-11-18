import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { trackEvent } from '../features/analytics/track.ts'
import { MarketingShell } from '../features/marketing/marketing-shell.tsx'
import { getMarketingPricing } from '../features/marketing/pricing.functions.ts'
import {
  groupPricingPlans,
  marketingPlans,
  PRICING_TTL_MS,
  packExpiryDays,
} from '../features/marketing/pricing-data.ts'
import {
  PricingBody,
  PricingError,
  PricingFacts,
  PricingFaq,
  PricingGroups,
  PricingHero,
  type PricingKind,
  PricingSkeleton,
  pricingKind,
} from '../features/marketing/pricing-page.tsx'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { pricingData } from '../features/seo/structured-data.ts'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'

export const Route = createFileRoute('/pricing')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  loader: () => getMarketingPricing(),
  component: PricingPage,
  pendingComponent: () => (
    <PricingFrame>
      <PricingSkeleton />
    </PricingFrame>
  ),
  errorComponent: PricingFailed,
  head: ({ matches, loaderData }) =>
    pageHead(
      staticPage('/pricing', getLocale()),
      originFromMatches(matches),
      loaderData ? pricingData(loaderData, originFromMatches(matches), getLocale()) : [],
    ),
})

function PricingFrame({
  children,
  facts,
  kind,
}: {
  children: ReactNode
  facts?: ReactNode
  kind?: PricingKind
}) {
  return (
    <MarketingShell>
      <PricingHero kind={kind} />
      {facts}
      <PricingBody>{children}</PricingBody>
      <PricingFaq />
    </MarketingShell>
  )
}

function PricingFailed() {
  const router = useRouter()
  return (
    <PricingFrame>
      <PricingError onRetry={() => void router.invalidate()} />
    </PricingFrame>
  )
}

function PricingPage() {
  const initialCatalog = Route.useLoaderData()
  const [catalog, setCatalog] = useState(initialCatalog)
  useEffect(() => trackEvent('paywall_view'), [])
  useEffect(() => {
    setCatalog(initialCatalog)
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const refreshed = await getMarketingPricing()
        if (active) setCatalog(refreshed)
      } catch {
        // 网络不可达时保留当前展示；结账入口始终重新读取服务端价格。
      }
    }, PRICING_TTL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [initialCatalog])
  const groups = groupPricingPlans(marketingPlans(catalog))
  const kind = pricingKind(groups)
  const both = kind === 'both' && groups.subscriptions.length > 0
  return (
    <PricingFrame
      kind={kind}
      facts={both ? <PricingFacts packExpiry={packExpiryDays(groups.creditPacks)} /> : null}
    >
      <PricingGroups
        groups={groups}
        paymentsAvailable={catalog.providers.some((provider) => provider.available)}
      />
    </PricingFrame>
  )
}

import { createFileRoute, redirect } from '@tanstack/react-router'
import { GrowthForm } from '../features/growth/forms.tsx'
import { MarketingShell } from '../features/marketing/marketing-shell.tsx'
import { placeholderPlans } from '../features/marketing/pricing-placeholder.ts'
import { Cta } from '../features/marketing/sections/cta.tsx'
import { Faq } from '../features/marketing/sections/faq.tsx'
import { Features } from '../features/marketing/sections/features.tsx'
import { Hero } from '../features/marketing/sections/hero.tsx'
import { Pricing } from '../features/marketing/sections/pricing.tsx'
import { Testimonials } from '../features/marketing/sections/testimonials.tsx'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { organizationData, websiteData } from '../features/seo/structured-data.ts'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'

// 首页（tasks.md 3.1）：各区块均为静态文案与数据，构建期预渲染，不依赖数据库（features/marketing/prerender.ts）
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    if (!templateConfig.marketing.enabled) throw redirect({ to: '/app' })
  },
  head: ({ matches }) =>
    templateConfig.marketing.enabled
      ? pageHead(staticPage('/', getLocale()), originFromMatches(matches), [
          organizationData(originFromMatches(matches)),
          websiteData(originFromMatches(matches)),
        ])
      : {},
  component: HomePage,
})

function HomePage() {
  return (
    <MarketingShell>
      <Hero />
      <Features />
      {templateConfig.billing.enabled && <Pricing plans={placeholderPlans} />}
      <Testimonials />
      <Faq />
      <Cta />
      {templateConfig.features.waitlist ? <GrowthForm feature="waitlist" /> : null}
      {templateConfig.features.newsletter ? <GrowthForm feature="newsletter" /> : null}
      <p data-testid="version" className="sr-only">
        v{__APP_VERSION__}
      </p>
    </MarketingShell>
  )
}

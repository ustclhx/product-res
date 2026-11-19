import { createFileRoute, redirect } from '@tanstack/react-router'
import { lazy, Suspense } from 'react'
import { GrowthForm } from '../features/growth/forms.tsx'
import { localized, localizeProduct } from '../features/marketing/localized.ts'
import { MarketingShell } from '../features/marketing/marketing-shell.tsx'
import { placeholderPlans } from '../features/marketing/pricing-placeholder.ts'
import { Cta } from '../features/marketing/sections/cta.tsx'
import { Faq } from '../features/marketing/sections/faq.tsx'
import { Features } from '../features/marketing/sections/features.tsx'
import { Hero } from '../features/marketing/sections/hero.tsx'
import { Pricing } from '../features/marketing/sections/pricing.tsx'
import { ProductMatrix } from '../features/marketing/sections/product-matrix.tsx'
import { Stats } from '../features/marketing/sections/stats.tsx'
import { Steps } from '../features/marketing/sections/steps.tsx'
import { Testimonials } from '../features/marketing/sections/testimonials.tsx'
import { site } from '../features/marketing/site.ts'
import { originFromMatches, pageHead, staticPage } from '../features/seo/metadata.ts'
import { organizationData, websiteData } from '../features/seo/structured-data.ts'
import { getLocale } from '../paraglide/runtime.js'
import { templateConfig } from '../server/template-config.ts'

// 未配置产品时的开发提示：只在开发环境按需加载。静态导入会让该模块随共享 chunk 进入首页，
// 生产构建里这个分支被常量折叠删除，提示组件不进入首页 JS。
const DevProductsEmptyHint = import.meta.env.DEV
  ? lazy(() =>
      import('../features/marketing/sections/products-empty-hint.tsx').then((module) => ({
        default: module.ProductsEmptyHint,
      })),
    )
  : null

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
  const { stats, steps, products } = site.marketing
  return (
    <MarketingShell>
      <Hero />
      {/* 新区块（openspec add-ui-design-system 8.5）：背书与产品矩阵未配置时不渲染 */}
      <Stats
        items={stats.items.map((item) => ({
          value: localized(item.value),
          label: localized(item.label),
        }))}
        source={stats.source === null ? null : localized(stats.source)}
      />
      <Steps
        steps={steps.map((step) => ({
          title: localized(step.title),
          description: localized(step.description),
        }))}
      />
      <ProductMatrix products={products.map((product) => localizeProduct(product))} />
      {DevProductsEmptyHint && products.length === 0 && (
        <Suspense fallback={null}>
          <DevProductsEmptyHint />
        </Suspense>
      )}
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

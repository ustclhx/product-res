import assert from 'node:assert/strict'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { localizeRequest } from '../../src/features/i18n/request.server.ts'
import { readMarketingPricing } from '../../src/features/marketing/pricing.server.ts'
import { marketingPlans } from '../../src/features/marketing/pricing-data.ts'
import { pricingSnapshot } from '../../src/features/marketing/pricing-snapshot.ts'
import { RichContent } from '../../src/features/marketing/rich-content.tsx'
import { Features } from '../../src/features/marketing/sections/features.tsx'
import { Pricing } from '../../src/features/marketing/sections/pricing.tsx'
import { robots, sitemap } from '../../src/features/seo/crawlers.ts'
import '../../src/features/seo/origin.functions.ts'
import '../../src/features/i18n/preference.functions.ts'
import { getLocale } from '../../src/paraglide/runtime.js'
import type { WebRuntime } from '../../src/server/runtime.ts'
import { templateConfig } from '../../src/server/template-config.ts'

const runtime = {
  config: { APP_URL: 'https://public.example', PAYMENT_MODE: 'invalid' },
  get db() {
    throw new Error('Public rendering accessed the business database')
  },
  get auth() {
    throw new Error('Public rendering accessed auth')
  },
  get publicDb() {
    throw new Error('Pricing database is offline')
  },
  cache: {
    get() {
      throw new Error('Public rendering queried payment cache')
    },
    put() {
      throw new Error('Public rendering wrote payment cache')
    },
    delete() {
      throw new Error('Public rendering deleted payment cache')
    },
  },
} as unknown as WebRuntime

async function main() {
  // 模块已真实加载；无数据库时读取失败由现有快照缓存处理。
  const catalog = await readMarketingPricing(runtime)
  assert.deepEqual(catalog.plans, pricingSnapshot.plans)
  assert.equal(
    catalog.prices.every((price) => !price.available),
    true,
  )
  assert.equal(
    catalog.providers.every((provider) => !provider.available),
    true,
  )

  for (const locale of ['en', 'zh']) {
    const response = await localizeRequest(
      new Request(`https://public.example/${locale}/pricing`),
      runtime,
      async () => {
        // i18n 关闭时所有路径都使用默认语言
        assert.equal(
          getLocale(),
          templateConfig.i18n.enabled ? locale : templateConfig.i18n.defaultLocale,
        )
        const root = createRootRoute()
        const page = createRoute({
          getParentRoute: () => root,
          path: '/',
          component: () => (
            <>
              <Features />
              <Pricing plans={marketingPlans(catalog)} />
              <RichContent html="<h2>Public legal content</h2>" />
            </>
          ),
        })
        const router = createRouter({
          routeTree: root.addChildren([page]),
          history: createMemoryHistory({ initialEntries: ['/'] }),
        })
        await router.load()
        return new Response(renderToStaticMarkup(<RouterProvider router={router} />))
      },
    )
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.ok(html.includes('id="features"'))
    assert.ok(html.includes('id="pricing"'))
    assert.ok(html.includes('Public legal content'))
    assert.ok(html.includes(catalog.plans[0]?.name ?? 'Missing plan'))
  }
  assert.ok(robots(runtime.config.APP_URL).includes('https://public.example/sitemap.xml'))
  assert.ok(
    sitemap(
      [{ path: '/', locale: 'en', title: 'Home', description: 'Home' }],
      runtime.config.APP_URL,
    ).includes('<loc>https://public.example/</loc>'),
  )
  process.stdout.write('Node public import and no-database rendering passed\n')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

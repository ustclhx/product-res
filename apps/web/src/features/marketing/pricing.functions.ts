import { createServerFn } from '@tanstack/react-start'
import { withBilling } from '../../server/feature-gates.ts'
import { getWebRuntime } from '../../server/runtime.ts'

export const getMarketingPricing = createServerFn({ method: 'GET' })
  .middleware([withBilling])
  .handler(async () => {
    const { readMarketingPricing } = await import('./pricing.server.ts')
    return readMarketingPricing(getWebRuntime())
  })

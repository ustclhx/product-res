import { m } from '../../paraglide/messages.js'
import type { PricingFeature } from './pricing-data.ts'

export function pricingFeatureLabel(item: PricingFeature): string {
  switch (item.key) {
    case 'maxSeats':
      return m.marketing_pricing_seats({ count: item.value })
    case 'storageGb':
      return m.marketing_pricing_storage({ count: item.value })
    case 'maxConcurrentTasks':
      return m.billing_coexist_tasks({ count: item.value })
    case 'models':
      return m.billing_coexist_models({ value: item.value.join(', ') || '—' })
    default: {
      const value = item.value ? m.billing_coexist_yes() : m.billing_coexist_no()
      if (item.key === 'publicApi') return m.billing_coexist_api({ value })
      if (item.key === 'priorityQueue') return m.billing_coexist_priority({ value })
      return m.billing_coexist_watermark({ value })
    }
  }
}

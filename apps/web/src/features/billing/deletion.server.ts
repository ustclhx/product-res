import type { DeletionStep } from '@product-res/auth'
import {
  createBillingDeletionStep,
  createPaymentRuntime,
  type PaymentRuntimeEnv,
} from '@product-res/billing'
import type { Database } from '@product-res/db'
import type { KeyValueStore } from '@product-res/platform'
import { templateConfig } from '../../server/template-config.ts'

export function createBillingDeletionSteps(
  config: PaymentRuntimeEnv,
  db: Database,
  cache: KeyValueStore,
): DeletionStep[] {
  if (!templateConfig.billing.enabled) return []
  // 普通认证不依赖支付配置；只有真正执行删除时才初始化支付能力。
  let step: DeletionStep
  return [
    {
      async before(context) {
        const { providers } = createPaymentRuntime(config, templateConfig.billing.providers, {
          cache,
          db,
        })
        step = createBillingDeletionStep({
          providers,
          refundWindowDays: templateConfig.billing.refundWindowDays,
        })
        await step.before?.(context)
      },
      async execute(context, sql) {
        await step.execute?.(context, sql)
      },
    },
  ]
}

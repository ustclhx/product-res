import {
  dbModelStore,
  listAvailableModels,
  supportsTextThinking,
  textModelConfig,
} from '@product-res/ai'
import { getEntitlements } from '@product-res/entitlements'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { withBilling } from '../../server/feature-gates.ts'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { readFaultAccess } from './fault-access.ts'

// 模型选择器的数据（tasks.md 3.2）：当前空间权益允许且已启用的模型，经 KV 缓存读取。
// 只返回选择与预计消耗所需的字段，不暴露服务商与服务商侧的模型 id。

export const getPickerModels = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(
    z.object({
      slug: z.string().min(1).max(64),
      kind: z.enum(['text', 'image', 'video']).default('text'),
    }),
  )
  .handler(async ({ context, data }) => {
    const runtime = getWebRuntime()
    const entitlements = await getEntitlements(context.db, context.workspace.id, {
      pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
    })
    const models = await listAvailableModels(
      {
        store: dbModelStore(context.db),
        cache: runtime.cache,
        workersAi: runtime.ai?.available === true && runtime.ai.value.workersAi.available,
        faultAccess: await readFaultAccess({
          auth: runtime.auth,
          db: context.db,
          headers: getRequest().headers,
          env: runtime.ai?.available ? runtime.ai.value.config : {},
        }),
      },
      entitlements,
      { kind: data.kind },
    )
    return models.map((model) => ({
      id: model.id,
      key: model.key,
      kind: model.kind,
      pricing: model.pricing,
      supportsThinking:
        model.kind === 'text' &&
        supportsTextThinking(model.provider, textModelConfig(model).thinking),
    }))
  })

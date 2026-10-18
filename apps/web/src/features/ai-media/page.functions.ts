import { dbModelStore, listAvailableModels } from '@product-res/ai'
import { file, scoped } from '@product-res/db'
import { getEntitlements } from '@product-res/entitlements'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { withBilling } from '../../server/feature-gates.ts'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { readFaultAccess } from '../ai/fault-access.ts'

export const getMediaSubmitPage = createServerFn({ method: 'GET' })
  .middleware([withBilling, withWorkspace])
  .inputValidator(z.object({ slug: z.string().min(1).max(64) }))
  .handler(async ({ context }) => {
    const runtime = getWebRuntime()
    const entitlements = await getEntitlements(context.db, context.workspace.id, {
      pastDueGraceDays: templateConfig.billing.pastDueGraceDays,
    })
    const available = await listAvailableModels(
      {
        store: dbModelStore(context.db),
        cache: runtime.cache,
        workersAi: runtime.ai?.available ? runtime.ai.value.workersAi.available : false,
        faultAccess: await readFaultAccess({
          auth: runtime.auth,
          db: context.db,
          headers: getRequest().headers,
          env: runtime.ai?.available ? runtime.ai.value.config : {},
        }),
      },
      entitlements,
    )
    const models = available
      .filter(
        (model) =>
          (model.kind === 'image' && templateConfig.ai.image) ||
          (model.kind === 'video' && templateConfig.ai.video),
      )
      .map(({ key, kind, pricing, paramsSchema }) => ({
        key,
        kind,
        pricing,
        // JSON 字符串保留完整 schema，同时满足 Server Function 的可序列化类型约束。
        paramsSchema: paramsSchema === null ? null : JSON.stringify(paramsSchema),
      }))
    const files = await scoped(context.db, context.workspace.id)
      .select(file, {
        fields: { id: file.id, mime: file.mime, size: file.size, status: file.status },
        where: and(eq(file.status, 'ready'), isNull(file.deletedAt)) as SQL,
      })
      .orderBy(desc(file.id))
    return {
      workspaceId: context.workspace.id,
      workspaceSlug: context.workspace.slug,
      readOnly: context.workspaceReadOnly,
      models,
      files,
    }
  })

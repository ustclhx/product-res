import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { withWorkspace } from '../../server/middleware.ts'
import { getWebRuntime } from '../../server/runtime.ts'
import { actorOf } from '../workbench/actor.ts'

/** 算法验证页（add-shadow-validation 4.1）；写权限在 service 内由 assertWorkbenchWriter 检查 */
const slug = z.object({ slug: z.string().min(1).max(64) })
const service = () => import('./validation.server.ts')

export const getValidationPage = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) =>
    (await service()).validationPage(actorOf(context), {
      replayQueueAvailable: getWebRuntime().selectionReplayQueue?.available === true,
    }),
  )

export const proposeWeightSuggestion = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug)
  .handler(async ({ context }) => (await service()).proposeSuggestion(actorOf(context)))

export const resolveWeightSuggestion = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ id: z.uuid(), decision: z.enum(['accept', 'dismiss']) }))
  .handler(async ({ context, data }) =>
    (await service()).resolveSuggestion(actorOf(context), data.id, data.decision, context.user.id),
  )

export const previewKeepaReplay = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .inputValidator(slug.extend({ directionId: z.uuid() }))
  .handler(async ({ context, data }) =>
    (await service()).previewReplay(actorOf(context), data.directionId),
  )

export const startKeepaReplay = createServerFn({ method: 'POST' })
  .middleware([withWorkspace])
  .inputValidator(
    slug.extend({
      directionId: z.uuid(),
      // 格式与范围的业务校验在 startReplay 中，返回带错误码的说明
      nodeDate: z.string().max(10),
      beforeDays: z.number().int(),
    }),
  )
  .handler(async ({ context, data }) => {
    const { slug: _slug, ...input } = data
    return (await service()).startKeepaReplay(
      actorOf(context),
      input,
      getWebRuntime().selectionReplayQueue,
    )
  })

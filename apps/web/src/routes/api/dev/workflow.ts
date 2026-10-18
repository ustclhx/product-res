import { requireCapability } from '@product-res/platform'
import { withRequestId } from '@product-res/shared/log'
import { createFileRoute } from '@tanstack/react-router'
import { devOnly } from '../../../server/dev-only.ts'
import { getWebRuntime } from '../../../server/runtime.ts'

// 调试：启动 apps/jobs 中定义的 AiMediaWorkflow 实例（POST），或查询实例状态（GET ?id=）。
export const Route = createFileRoute('/api/dev/workflow')({
  server: {
    handlers: {
      POST: () =>
        devOnly(async () => {
          const ai = requireCapability(getWebRuntime().ai ?? { available: false }, 'AI')
          const workflow = requireCapability(ai.workflow, 'Media workflow')
          const taskId = crypto.randomUUID()
          const instance = await workflow.create({ params: withRequestId({ taskId }) })
          return Response.json({ id: instance.id, taskId, status: await instance.status() })
        }),
      GET: ({ request }) =>
        devOnly(async () => {
          const id = new URL(request.url).searchParams.get('id')
          if (!id) return Response.json({ error: 'missing id' }, { status: 400 })
          const ai = requireCapability(getWebRuntime().ai ?? { available: false }, 'AI')
          const instance = await requireCapability(ai.workflow, 'Media workflow').get(id)
          return Response.json({ id, status: await instance.status() })
        }),
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { handleMediaCancel } from '../../../../../features/ai/media-tasks.ts'
import { getAiHttpDeps } from '../../../../../features/ai/runtime.ts'
import { templateConfig } from '../../../../../server/template-config.ts'

function deps() {
  return getAiHttpDeps()
}

export const Route = createFileRoute('/api/ai/tasks/$taskId/cancel')({
  server: {
    handlers: {
      POST: ({ request, params }) => {
        if (!templateConfig.billing.enabled) return new Response('Not Found', { status: 404 })
        return handleMediaCancel(request, params.taskId, deps())
      },
    },
  },
})
